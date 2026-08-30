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
import {
  recall,
  allEntries,
  listBoard,
  addBoardItem,
  updateBoardItem,
  removeBoardItem,
  BoardStatus,
  echoId,
} from "./memory.js";
import { publish, subscribe } from "./bus.js";
import { tryAcquire, release } from "./limits.js";
import { summary as usageSummary } from "./usage.js";
import { addPending, getPending, removePending, sweepExpired } from "./approvals.js";

const app = express();

// CORS MUST come before express.json(): if a request body exceeds the size
// limit below, body-parsing throws before reaching later middleware — with
// cors() registered after json(), that error response would go out with no
// Access-Control-Allow-Origin header, and the browser would surface it to
// the caller as an opaque "Failed to fetch" instead of a readable 413.
const allowed = (process.env.WEB_ORIGIN ?? "*").split(",").map((s) => s.trim());
app.use(cors({ origin: allowed.includes("*") ? true : allowed }));
app.use(express.json({ limit: "32kb" }));

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

// Global, not per-session — how much the whole public demo has spent since
// the server last started. estimatedCostUsd is a courtesy estimate from
// published rates, not a bill; token counts are exact.
app.get("/api/usage", (_req, res) => {
  res.json(usageSummary());
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
  // A real "data:" message, not a bare SSE comment — comments are invisible
  // to EventSource.onmessage, so the client has no way to notice a
  // connection that's silently hung (no error, just stopped delivering)
  // unless the heartbeat itself is something it can observe.
  const heartbeat = setInterval(() => res.write(`data: {"type":"ping"}\n\n`), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * Runs a free-form task (delegate_task / ask_companion) right now — paid
 * API call included. Called directly for human-initiated requests (they're
 * watching, no gate needed) and again from /api/approve once a human has
 * signed off on an agent-proposed one.
 */
async function runFreeformTask(
  res: express.Response,
  sessionId: string,
  params: { taskId: string; task: string; target?: string; via: "human" | "agent"; tool?: unknown }
) {
  const { taskId, task: cleanTask, target, via: viaClean, tool } = params;

  const gate = tryAcquire(sessionId);
  if (!gate.ok) return res.status(429).json({ error: gate.reason });

  try {
    agentPing(
      sessionId,
      viaClean,
      tool ?? (target ? "ask_companion" : "delegate_task"),
      target ? `asked ${echoId(String(target))} directly` : "delegated a task to the team"
    );
    publish(sessionId, { type: "task", taskId, via: viaClean, task: cleanTask });

    let companion: string;
    let how: string;
    if (target) {
      const member = findMember(String(target));
      if (!member) {
        const shownTarget = echoId(String(target));
        publish(sessionId, { type: "task-error", taskId, message: `No companion named "${shownTarget}".` });
        return res.status(404).json({
          error: `No companion named "${shownTarget}". Use list_companions to see the roster.`,
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
}

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
  const cleanTask = task.trim();
  const targetClean = typeof target === "string" && target ? target : undefined;

  // Agent-initiated work costs real money and can run unattended, so it
  // waits for a human's go-ahead. Human-initiated work runs immediately —
  // a person clicking Send is already watching it happen.
  if (viaClean === "agent") {
    const taskId = randomUUID();
    addPending({
      taskId,
      sessionId,
      kind: "freeform",
      taskText: cleanTask,
      target: targetClean,
      tool: typeof tool === "string" ? tool : undefined,
      createdAt: Date.now(),
    });
    agentPing(
      sessionId,
      viaClean,
      tool ?? (targetClean ? "ask_companion" : "delegate_task"),
      targetClean ? `proposed asking ${echoId(targetClean)} directly` : "proposed a task for the team"
    );
    publish(sessionId, { type: "pending", taskId, kind: "freeform", task: cleanTask, target: targetClean });
    return res.json({ taskId, status: "pending", message: "Waiting for human approval before this runs." });
  }

  await runFreeformTask(res, sessionId, { taskId: randomUUID(), task: cleanTask, target: targetClean, via: viaClean, tool });
});

/* ---------------- board: real shared state, no model in the loop ---------------- */

function broadcastBoard(
  sessionId: string,
  changed?: { id: string; action: "add" | "update" | "remove"; via: "human" | "agent"; title: string }
) {
  publish(sessionId, { type: "board", items: listBoard(sessionId), changed });
}

app.get("/api/board", (req, res) => {
  const sessionId = String(req.query.session ?? "");
  if (!sessionId) return res.status(400).json({ error: "session query param required" });
  agentPing(sessionId, req.query.via, req.query.tool ?? "list_board", "read the board");
  res.json({ items: listBoard(sessionId) });
});

app.post("/api/board", (req, res) => {
  const { sessionId, action, id, title, note, status, via, tool } = req.body ?? {};
  if (typeof sessionId !== "string" || !sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }
  const viaClean: "human" | "agent" = via === "agent" ? "agent" : "human";

  let result: ReturnType<typeof addBoardItem>;
  if (action === "add") {
    if (typeof title !== "string") return res.status(400).json({ error: "title required" });
    result = addBoardItem(sessionId, {
      title,
      note: typeof note === "string" ? note : undefined,
      status: status as BoardStatus | undefined,
      createdBy: viaClean,
    });
  } else if (action === "update") {
    if (typeof id !== "string") return res.status(400).json({ error: "id required" });
    if (status === "pending") {
      return res.status(400).json({
        error: '"pending" can\'t be set directly — it\'s applied automatically when an agent proposes delegating this item, and cleared when a human approves or rejects it.',
      });
    }
    result = updateBoardItem(sessionId, id, {
      title: typeof title === "string" ? title : undefined,
      note: typeof note === "string" ? note : undefined,
      status: status as BoardStatus | undefined,
    });
  } else if (action === "remove") {
    if (typeof id !== "string") return res.status(400).json({ error: "id required" });
    result = removeBoardItem(sessionId, id);
  } else {
    return res.status(400).json({ error: `Unknown action "${echoId(String(action))}". Use add, update or remove.` });
  }

  // ping AFTER the mutation is confirmed to have actually happened — an
  // agentPing before this point would tell the human's feed a write
  // succeeded even when validation rejected it (e.g. bad id, empty title)
  if ("error" in result) return res.status(400).json({ error: result.error });

  if (action === "add") {
    agentPing(sessionId, viaClean, tool ?? "add_board_item", `added to board: "${result.title.slice(0, 60)}"`);
  } else if (action === "update") {
    agentPing(sessionId, viaClean, tool ?? "update_board_item", `updated [${result.id}]${status ? ` → ${result.status}` : ""}`);
  } else {
    agentPing(sessionId, viaClean, tool ?? "remove_board_item", `removed [${result.id}] from the board`);
  }

  broadcastBoard(sessionId, {
    id: result.id,
    action: action as "add" | "update" | "remove",
    via: viaClean,
    title: result.title,
  });
  res.json({ item: result });
});

/**
 * Runs a board item's delegation right now. Called directly for human
 * clicks (⚡ button) and again from /api/approve once a human has signed
 * off on an agent-proposed delegation.
 */
async function runBoardDelegateTask(
  res: express.Response,
  sessionId: string,
  params: { taskId: string; id: string; item: { title: string; note: string }; via: "human" | "agent"; tool?: unknown }
) {
  const { taskId, id, item, via: viaClean, tool } = params;

  const gate = tryAcquire(sessionId);
  if (!gate.ok) return res.status(429).json({ error: gate.reason });

  const taskText = item.note ? `${item.title}\n\nContext note on the board item: ${item.note}` : item.title;

  try {
    agentPing(sessionId, viaClean, tool ?? "delegate_board_item", `sent [${id}] "${item.title.slice(0, 50)}" to the team`);
    publish(sessionId, { type: "task", taskId, via: viaClean, task: `[board ${id}] ${item.title}` });

    const toDoing = updateBoardItem(sessionId, id, { status: "doing" });
    if (!("error" in toDoing)) broadcastBoard(sessionId, { id, action: "update", via: viaClean, title: item.title });

    const routed = await route(taskText);
    publish(sessionId, { type: "routed", taskId, companion: routed.companion, how: routed.how });
    markBusy(sessionId, taskId, routed.companion, item.title);

    const member = findMember(routed.companion)!;
    const result = await Promise.race([
      runTask({ sessionId, taskId, member, task: taskText, via: viaClean }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Task timed out (demo limit).")), TASK_HARD_TIMEOUT_MS)
      ),
    ]);

    const summary = result.replace(/\s+/g, " ").trim().slice(0, 280);
    // the item may have been deleted while this delegation was mid-flight
    // (e.g. someone hit "remove" on a "doing" item) — the work still
    // happened and the caller still gets the result, but there's nothing
    // left on the board to write it back to, so skip the board broadcast
    const toDone = updateBoardItem(sessionId, id, { status: "done", note: summary });
    if (!("error" in toDone)) broadcastBoard(sessionId, { id, action: "update", via: viaClean, title: item.title });

    res.json({ taskId, id, companion: routed.companion, how: routed.how, result });
  } catch (err) {
    const rollback = updateBoardItem(sessionId, id, { status: "todo" }); // roll back so it can be retried
    if (!("error" in rollback)) broadcastBoard(sessionId, { id, action: "update", via: viaClean, title: item.title });

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
}

app.post("/api/board/delegate", async (req, res) => {
  const { sessionId, id, via, tool } = req.body ?? {};
  if (typeof sessionId !== "string" || !sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }
  if (typeof id !== "string" || !id) return res.status(400).json({ error: "id required" });
  const viaClean: "human" | "agent" = via === "agent" ? "agent" : "human";

  const item = listBoard(sessionId).find((b) => b.id === id);
  if (!item) {
    return res.status(404).json({ error: `No board item "${echoId(id)}". Use list_board to see current ids.` });
  }
  // an item already running or already waiting on a human stays untouched
  // — without this, two quick clicks (or a human and an agent both
  // reaching for the same item) would fire two paid API calls for the
  // same piece of work and race on the write
  if (item.status === "doing" || item.status === "pending") {
    const state = item.status === "pending" ? "waiting for approval" : "already being worked on";
    return res.status(409).json({ error: `[${echoId(id)}] "${item.title}" is ${state}.` });
  }

  if (viaClean === "agent") {
    const taskId = randomUUID();
    addPending({
      taskId,
      sessionId,
      kind: "board",
      boardId: id,
      taskText: item.note ? `${item.title}\n\nContext note on the board item: ${item.note}` : item.title,
      tool: typeof tool === "string" ? tool : undefined,
      createdAt: Date.now(),
    });
    const toPending = updateBoardItem(sessionId, id, { status: "pending" });
    if (!("error" in toPending)) broadcastBoard(sessionId, { id, action: "update", via: viaClean, title: item.title });
    agentPing(sessionId, viaClean, tool ?? "delegate_board_item", `proposed sending [${id}] "${item.title.slice(0, 50)}" to the team`);
    publish(sessionId, { type: "pending", taskId, kind: "board", boardId: id, task: item.title });
    return res.json({ taskId, id, status: "pending", message: "Waiting for human approval before this runs." });
  }

  await runBoardDelegateTask(res, sessionId, { taskId: randomUUID(), id, item, via: viaClean, tool });
});

/**
 * The only way a pending, agent-proposed task actually runs. Deliberately
 * NOT exposed as a WebMCP tool anywhere in the frontend — an agent can
 * propose work through delegate_task/ask_companion/delegate_board_item,
 * but only a human clicking Approve in the page's own UI can wave it
 * through. This is what makes the approval real rather than decorative.
 */
app.post("/api/approve", async (req, res) => {
  const { sessionId, taskId, decision } = req.body ?? {};
  if (typeof sessionId !== "string" || !sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }
  if (typeof taskId !== "string" || !taskId) {
    return res.status(400).json({ error: "taskId required" });
  }
  if (decision !== "approve" && decision !== "reject") {
    return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
  }

  const approval = getPending(taskId);
  if (!approval || approval.sessionId !== sessionId) {
    return res.status(404).json({ error: "No pending approval with that id for this session." });
  }
  removePending(taskId);

  if (decision === "reject") {
    if (approval.kind === "board" && approval.boardId) {
      const back = updateBoardItem(sessionId, approval.boardId, { status: "todo" });
      if (!("error" in back)) {
        broadcastBoard(sessionId, { id: approval.boardId, action: "update", via: "human", title: back.title });
      }
    }
    publish(sessionId, { type: "pending-resolved", taskId, decision: "rejected" });
    return res.json({ taskId, decision: "rejected" });
  }

  publish(sessionId, { type: "pending-resolved", taskId, decision: "approved" });

  if (approval.kind === "board" && approval.boardId) {
    const item = listBoard(sessionId).find((b) => b.id === approval.boardId);
    if (!item) return res.status(404).json({ error: "The board item no longer exists." });
    return runBoardDelegateTask(res, sessionId, { taskId, id: approval.boardId, item, via: "agent", tool: approval.tool });
  }

  await runFreeformTask(res, sessionId, { taskId, task: approval.taskText, target: approval.target, via: "agent", tool: approval.tool });
});

// Approvals nobody acted on eventually auto-reject, so a proposal an agent
// made and then abandoned doesn't leave a board item stuck on "pending"
// forever, or leave the human wondering if it's still waiting on them.
setInterval(() => {
  for (const approval of sweepExpired()) {
    removePending(approval.taskId);
    if (approval.kind === "board" && approval.boardId) {
      const back = updateBoardItem(approval.sessionId, approval.boardId, { status: "todo" });
      if (!("error" in back)) {
        broadcastBoard(approval.sessionId, { id: approval.boardId, action: "update", via: "human", title: back.title });
      }
    }
    publish(approval.sessionId, { type: "pending-resolved", taskId: approval.taskId, decision: "expired" });
  }
}, 30_000).unref();

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

// Body-parser errors (bad JSON, payload over the size limit) land here
// instead of Express's default HTML error page — every other endpoint
// returns { error: "..." }, so this one should too.
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large (max 32kb)." });
  }
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed JSON in request body." });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Leia server listening on :${port} — team of ${TEAM.length} ready.`);
});
