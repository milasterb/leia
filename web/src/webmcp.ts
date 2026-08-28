/**
 * The WebMCP layer — what makes this page usable by an agent, not just
 * scrapable. Five tools are exposed on `navigator.modelContext`; every
 * call an agent makes flows through the same backend as the human chat,
 * so both write into one shared workspace and the 3D scene shows the
 * agent's work live.
 *
 * The spec is young and still moving, so registration is defensive:
 *   1. `registerTool(tool)` per tool, if present (current shape)
 *   2. `provideContext({ tools })` as a fallback (earlier shape)
 * If neither exists we surface how to enable it instead of failing quietly.
 */

import { submitTask, recallMemory, fetchStatus, fetchTeam } from "./api.js";

type ToolResult = { content: { type: "text"; text: string }[] };

interface WebMCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: any) => Promise<ToolResult>;
  // earlier drafts of the spec used `run`/`callback`; harmless to include the schema key both ways
  [key: string]: unknown;
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

function err(e: unknown): ToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return text(`Tool failed: ${message}`);
}

export const TOOLS: WebMCPTool[] = [
  {
    name: "delegate_task",
    description:
      "Give a task to Leia's team of AI specialists. Leia (the orchestrator) picks the best-suited " +
      "companion, that companion does the work, and you get the result plus who handled it. " +
      "Use this when you don't know or don't care which specialist should do the job.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task to hand over, in plain language. Any language works.",
        },
      },
      required: ["task"],
    },
    execute: async ({ task }: { task: string }) => {
      try {
        const r = await submitTask({ task, via: "agent", tool: "delegate_task" });
        return text(`${r.companion} handled this (routing: ${r.how}).\n\n${r.result}`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "ask_companion",
    description:
      "Ask one specific companion directly, bypassing Leia's routing. Companions: Smith (code), " +
      "Scout (research with live web search), Keeper (session context & memory), Scribe (writing), " +
      "Planner (plans & estimates), Warden (critical review), Analyst (numbers & data). " +
      "Use list_companions for full roles.",
    inputSchema: {
      type: "object",
      properties: {
        companion: {
          type: "string",
          description: "Name of the companion, e.g. \"Scout\".",
        },
        question: {
          type: "string",
          description: "What to ask them.",
        },
      },
      required: ["companion", "question"],
    },
    execute: async ({ companion, question }: { companion: string; question: string }) => {
      try {
        const r = await submitTask({ task: question, via: "agent", target: companion, tool: "ask_companion" });
        return text(`${r.companion} answers:\n\n${r.result}`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "list_companions",
    description:
      "List Leia's team: every companion's name and specialty. Call this first if you're unsure " +
      "who does what.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      try {
        const team = await fetchTeam({ via: "agent", tool: "list_companions" });
        const lines = team.map((m) => `- ${m.name}: ${m.role}`).join("\n");
        return text(`Leia orchestrates this team:\n${lines}`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "get_team_status",
    description:
      "See what the team is doing right now in this session: which companions are busy with what, " +
      "plus the most recent completed work. The human sees the same thing in the 3D scene.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      try {
        const s = await fetchStatus({ via: "agent", tool: "get_team_status" });
        const busyLines =
          s.busy.length === 0
            ? "Nobody is busy right now."
            : s.busy.map((b) => `- ${b.companion} is working on: ${b.task}`).join("\n");
        const recentLines =
          s.recent.length === 0
            ? "No work has been done in this session yet."
            : s.recent
                .map((r) => `- [${r.via}] ${r.companion} — ${r.task} → ${r.summary}`)
                .join("\n");
        return text(`Currently busy:\n${busyLines}\n\nRecent work:\n${recentLines}`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "recall_workspace_memory",
    description:
      "Search the shared session workspace — everything the human and you have done here so far " +
      "(tasks, who handled them, outcomes). The workspace is per-session and shared between the " +
      "human user and their agent, so use this to build on earlier work instead of repeating it.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, e.g. \"the plan Planner made\" or \"pricing research\".",
        },
      },
      required: ["query"],
    },
    execute: async ({ query }: { query: string }) => {
      try {
        const r = await recallMemory(query, "agent");
        if (r.hits.length === 0) {
          return text(`Nothing in the workspace matches "${r.query}" yet.`);
        }
        const lines = r.hits
          .map((h) => `- [${h.via} → ${h.companion}] ${h.task}\n  outcome: ${h.summary}`)
          .join("\n");
        return text(`Workspace matches for "${r.query}":\n${lines}`);
      } catch (e) {
        return err(e);
      }
    },
  },
];

export type WebMCPStatus =
  | { available: true; method: "registerTool" | "provideContext" }
  | { available: false };

export function registerWebMCP(): WebMCPStatus {
  const mc = (navigator as any).modelContext;
  if (!mc) return { available: false };

  try {
    if (typeof mc.registerTool === "function") {
      for (const tool of TOOLS) mc.registerTool(tool);
      return { available: true, method: "registerTool" };
    }
    if (typeof mc.provideContext === "function") {
      mc.provideContext({ tools: TOOLS });
      return { available: true, method: "provideContext" };
    }
  } catch (e) {
    console.warn("WebMCP registration failed:", e);
  }
  return { available: false };
}
