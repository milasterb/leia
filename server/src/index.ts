/**
 * Leia demo server.
 *
 *   GET  /health                    liveness probe
 *   GET  /api/team                  roster (add ?session&via=agent to light the agent feed)
 *   GET  /api/status?session=…      who is busy with what (same ?via=agent option)
 *   GET  /api/stream?session=…      SSE — every event in the session, live
 *   POST /api/task                  { sessionId, task, via, target?, tool? }
 *   POST /api/recall                { sessionId, query, via?, tool? }
 *
 * One process, in-memory state, guarded by ./limits — this is a public
 * demo running on a real API key, not a product deployment.
 */

import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { TEAM, teamInfo, findMember } from "./team.js";
import { route } from "./orchestrator.js";
import { runTask } from "./companion.js";
import { recall, allEntries } from "./memory.js";
import { publish, subscribe } from "./bus.js";
import { tryAcquire, release } from "./limits.js";

const app = express();
app.use(express.json({ limit: "32kb" }));

const allowed = (process.env.WEB_ORIGIN ?? "*").split(",").map((s) => s.trim());
app.use(cors({ origin: allowed.includes("*") ? true : allowed }));

const MAX_TASK_CHARS = 4000;
const TASK_HARD_TIMEOUT_MS = 150_000;

/** taskId → what's running, per session — feeds /api/status. */
const busy = new Map<string, Map<string, { companion: string; task: string }>>();

function markBusy(sessionId: string, taskId: string, companion: string, task: string) {
  let m = busy.get(sessionId);
  if (!m) {
    m = new Map();
    busy.set(sessionId, m);
  }
  m.set(taskId, { companion, task: task.slice(0, 120) });
}

function markFree(sessionId: string, taskId: string) {
  const m = busy.get(sessionId);
  if (!m) return;
  m.delete(taskId);
  if (m.size === 0) busy.delete(sessionId);
}

function agentPing(sessionId: string | undefined, via: unknown, tool: unknown, detail: string) {
  if (via === "agent" && sessionId) {
    publish(sessionId, { type: "agent-tool", tool: String(tool ?? "unknown"), detail });
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, team: TEAM.length });
});

app.get("/api/team", (req, res) => {
  agentPing(String(req.query.session ?? "") || undefined, req.query.via, req.query.tool ?? "list_companions", "listed the team roster");
  res.json({ orchestrator: "Leia", companions: teamInfo() });
});

app.get("/api/status", (req, res) => {
  const sessionId = String(req.query.session ?? "");
  if (!sessionId) return res.status(400).json({ error: "session query param required" });
  agentPing(sessionId, req.query.via, req.query.tool ?? "get_team_status", "checked team status");

  const running = [...(busy.get(sessionId)?.values() ?? [])];
  const recent = allEntries(sessionId, 8).map((e) => ({
    via: e.via,
    companion: e.companion,
    task: e.task,
    summary: e.summary,
  }));
  res.json({ busy: running, recent });
});

app.get("/api/stream", (req, res) => {
  const sessionId = String(req.query.session ?? "");
  if (!sessionId) return res.status(400).json({ error: "session query param required" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: {}\n\n`);

  const unsubscribe = subscribe(sessionId, (e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post("/api/task", async (req, res) => {
  const { sessionId, task, via, target, tool } = req.body ?? {};

  if (typeof sessionId !== "string" || !sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }
  if (typeof task !== "string" || !task.trim()) {
    return res.status(400).json({ error: "task required" });
  }
  if (task.length > MAX_TASK_CHARS) {
    return res.status(400).json({ error: `task too long (max ${MAX_TASK_CHARS} chars)` });
  }
  const viaClean: "human" | "agent" = via === "agent" ? "agent" : "human";

  const gate = tryAcquire(sessionId);
  if (!gate.ok) return res.status(429).json({ error: gate.reason });

  const taskId = randomUUID();
  const cleanTask = task.trim();

  try {
    agentPing(
      sessionId,
      viaClean,
      tool ?? (target ? "ask_companion" : "delegate_task"),
      target ? `asked ${target} directly` : "delegated a task to the team"
    );
    publish(sessionId, { type: "task", taskId, via: viaClean, task: cleanTask });

    let companion: string;
    let how: string;
    if (target) {
      const member = findMember(String(target));
      if (!member) {
        publish(sessionId, { type: "task-error", taskId, message: `No companion named "${target}".` });
        return res.status(404).json({
          error: `No companion named "${target}". Use list_companions to see the roster.`,
        });
      }
      companion = member.name;
      how = "direct";
    } else {
      const routed = await route(cleanTask);
      companion = routed.companion;
      how = routed.how;
    }

    publish(sessionId, { type: "routed", taskId, companion, how });
    markBusy(sessionId, taskId, companion, cleanTask);

    const member = findMember(companion)!;
    const result = await Promise.race([
      runTask({ sessionId, taskId, member, task: cleanTask, via: viaClean }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Task timed out (demo limit).")), TASK_HARD_TIMEOUT_MS)
      ),
    ]);

    res.json({ taskId, companion, how, result });
  } catch (err) {
    let message = err instanceof Error ? err.message : "Unknown error while running the task.";
    if (/authentication|x-api-key|invalid.*api key|401/i.test(message)) {
      message = "The demo server has no valid ANTHROPIC_API_KEY configured — the operator needs to set it.";
    }
    publish(sessionId, { type: "task-error", taskId, message });
    res.status(500).json({ error: message });
  } finally {
    markFree(sessionId, taskId);
    release(sessionId);
  }
});

app.post("/api/recall", (req, res) => {
  const { sessionId, query, via, tool } = req.body ?? {};
  if (typeof sessionId !== "string" || !sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }
  if (typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "query required" });
  }
  agentPing(sessionId, via, tool ?? "recall_workspace_memory", `recalled: "${query.slice(0, 60)}"`);

  const hits = recall(sessionId, query.trim());
  res.json({
    query: query.trim(),
    hits: hits.map((e) => ({
      when: new Date(e.ts).toISOString(),
      via: e.via,
      companion: e.companion,
      task: e.task,
      summary: e.summary,
    })),
  });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Leia server listening on :${port} — team of ${TEAM.length} ready.`);
});
