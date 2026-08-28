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

import { submitTask, recallMemory, fetchStatus, fetchTeam, fetchBoard, mutateBoard, delegateBoardItem } from "./api.js";

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
  {
    name: "list_board",
    description:
      "Read the shared workspace board — the CURRENT PLAN both the human and you edit together. " +
      "Items have an id (like b1), a title, an optional note, and a status: todo, doing or done. " +
      "Always read the board before adding or changing items, so you build on the human's plan " +
      "instead of duplicating it. This is real state on the page, not generated text.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      try {
        const items = await fetchBoard({ via: "agent", tool: "list_board" });
        if (items.length === 0) return text("The board is empty. Use add_board_item to start the plan.");
        const lines = items
          .map((b) => `- [${b.id}] (${b.status}) ${b.title}${b.note ? ` — note: ${b.note}` : ""}`)
          .join("\n");
        return text(`Current board:\n${lines}`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "add_board_item",
    description:
      "Add an item to the shared workspace board the human is looking at. Use this to lay out a " +
      "plan, capture decisions, or queue work — each item appears instantly in the human's UI and " +
      "in the 3D scene. Prefer several small, concrete items over one vague one.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, concrete item title (max 140 chars)." },
        note: { type: "string", description: "Optional context or detail for the item." },
        status: {
          type: "string",
          enum: ["todo", "doing", "done"],
          description: "Initial status. Defaults to todo.",
        },
      },
      required: ["title"],
    },
    execute: async ({ title, note, status }: { title: string; note?: string; status?: any }) => {
      try {
        const item = await mutateBoard({ action: "add", title, note, status, via: "agent", tool: "add_board_item" });
        return text(`Added [${item.id}] "${item.title}" (${item.status}) to the board.`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "update_board_item",
    description:
      "Update a board item: change its status (todo → doing → done), retitle it, or attach a note. " +
      "Use the id from list_board (e.g. b2). Moving items is how you and the human keep a shared " +
      "picture of progress.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Item id, e.g. \"b2\"." },
        status: { type: "string", enum: ["todo", "doing", "done"], description: "New status." },
        title: { type: "string", description: "New title (optional)." },
        note: { type: "string", description: "New note (optional, replaces the old one)." },
      },
      required: ["id"],
    },
    execute: async ({ id, status, title, note }: { id: string; status?: any; title?: string; note?: string }) => {
      try {
        const item = await mutateBoard({ action: "update", id, status, title, note, via: "agent", tool: "update_board_item" });
        return text(`Updated [${item.id}]: "${item.title}" is now ${item.status}${item.note ? ` — note: ${item.note}` : ""}.`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "remove_board_item",
    description:
      "Remove an item from the shared board by id. Only remove items that are obsolete or were " +
      "added by mistake — completed work should be marked done, not removed, so the human keeps " +
      "the picture of what happened.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Item id, e.g. \"b3\"." },
      },
      required: ["id"],
    },
    execute: async ({ id }: { id: string }) => {
      try {
        const item = await mutateBoard({ action: "remove", id, via: "agent", tool: "remove_board_item" });
        return text(`Removed [${item.id}] "${item.title}" from the board.`);
      } catch (e) {
        return err(e);
      }
    },
  },
  {
    name: "delegate_board_item",
    description:
      "Send one board item to Leia's team to actually get done: the item flips to \"doing\", Leia " +
      "routes it to the right specialist, and when they finish the item flips to \"done\" with the " +
      "outcome attached as its note. The human watches all of it happen live. This is the bridge " +
      "between the shared plan (board) and the team doing the work.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Board item id to execute, e.g. \"b1\"." },
      },
      required: ["id"],
    },
    execute: async ({ id }: { id: string }) => {
      try {
        const r = await delegateBoardItem(id, "agent", "delegate_board_item");
        return text(`[${r.id}] handled by ${r.companion} and marked done.\n\n${r.result}`);
      } catch (e) {
        return err(e);
      }
    },
  },
];

export type WebMCPStatus =
  | { available: true; method: "registerTool" | "provideContext"; anchor: "navigator" | "document" }
  | { available: false };

/**
 * Where the browser puts `modelContext` has moved between preview builds
 * (early drafts used `navigator.modelContext`; some current Chrome Canary
 * builds expose it on `document.modelContext` instead). We check both
 * rather than picking one, so registration keeps working across browsers
 * without needing to track the spec's churn by hand.
 */
export function registerWebMCP(): WebMCPStatus {
  const navMc = (navigator as any).modelContext;
  const docMc = (document as any).modelContext;
  const mc = navMc ?? docMc;
  if (!mc) return { available: false };
  const anchor: "navigator" | "document" = navMc ? "navigator" : "document";

  try {
    if (typeof mc.registerTool === "function") {
      for (const tool of TOOLS) mc.registerTool(tool);
      return { available: true, method: "registerTool", anchor };
    }
    if (typeof mc.provideContext === "function") {
      mc.provideContext({ tools: TOOLS });
      return { available: true, method: "provideContext", anchor };
    }
  } catch (e) {
    console.warn("WebMCP registration failed:", e);
  }
  return { available: false };
}
