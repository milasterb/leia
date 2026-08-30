/**
 * Session-scoped workspace memory.
 *
 * The home version of this system uses a vector database; the public demo
 * deliberately does not. Every visitor (browser session) gets an isolated
 * in-process workspace that lives while they use the page and is dropped
 * after a period of inactivity. Nothing is shared between visitors and
 * nothing is persisted to disk.
 */

export interface WorkspaceEntry {
  ts: number;
  /** Who initiated the task. */
  via: "human" | "agent";
  companion: string;
  task: string;
  /** Short summary of the result, kept for recall. */
  summary: string;
}

/**
 * The board: the workspace's REAL shared state. Unlike the entry log
 * (what happened), the board is the current plan — items the human and
 * the agent both create, move and resolve through the same operations.
 * No model call is involved in a board mutation; this is plain state.
 */
export type BoardStatus = "todo" | "pending" | "doing" | "done";

export interface BoardItem {
  id: string;
  title: string;
  note: string;
  status: BoardStatus;
  createdBy: "human" | "agent";
  ts: number;
  updatedTs: number;
}

const MAX_BOARD_ITEMS = 30;
const MAX_TITLE = 140;
const MAX_NOTE = 600;

interface Workspace {
  createdAt: number;
  lastSeen: number;
  entries: WorkspaceEntry[];
  board: BoardItem[];
  boardCounter: number;
}

const MAX_ENTRIES_PER_SESSION = 60;
const SESSION_IDLE_MS = 45 * 60 * 1000; // dropped 45 min after last activity
const SWEEP_EVERY_MS = 5 * 60 * 1000;

const workspaces = new Map<string, Workspace>();

function touch(sessionId: string): Workspace {
  let ws = workspaces.get(sessionId);
  if (!ws) {
    ws = { createdAt: Date.now(), lastSeen: Date.now(), entries: [], board: [], boardCounter: 0 };
    workspaces.set(sessionId, ws);
  }
  ws.lastSeen = Date.now();
  return ws;
}

export function remember(sessionId: string, entry: Omit<WorkspaceEntry, "ts">): void {
  const ws = touch(sessionId);
  ws.entries.push({ ...entry, ts: Date.now() });
  if (ws.entries.length > MAX_ENTRIES_PER_SESSION) {
    ws.entries.splice(0, ws.entries.length - MAX_ENTRIES_PER_SESSION);
  }
}

/**
 * Plain relevance scoring: keyword overlap with a small recency boost.
 * Deliberately simple — the demo's point is the shape of the capability
 * (agents sharing a workspace with the human), not retrieval quality.
 */
export function recall(sessionId: string, query: string, limit = 6): WorkspaceEntry[] {
  const ws = workspaces.get(sessionId);
  if (!ws) return [];
  ws.lastSeen = Date.now();

  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

  const scored = ws.entries.map((e, i) => {
    const hay = `${e.task} ${e.summary} ${e.companion}`.toLowerCase();
    const overlap = words.filter((w) => hay.includes(w)).length;
    const recency = i / Math.max(1, ws.entries.length - 1); // 0..1, newest = 1
    return { e, score: overlap + recency * 0.5 };
  });

  return scored
    .filter((s) => s.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

export function allEntries(sessionId: string, limit = 20): WorkspaceEntry[] {
  const ws = workspaces.get(sessionId);
  if (!ws) return [];
  ws.lastSeen = Date.now();
  return ws.entries.slice(-limit);
}

/** Compact textual digest of the workspace — fed to Keeper as context. */
export function digest(sessionId: string, limit = 20): string {
  const entries = allEntries(sessionId, limit);
  const board = listBoard(sessionId);

  const log =
    entries.length === 0
      ? "(nothing has happened in this session yet)"
      : entries
          .map((e) => {
            const t = new Date(e.ts).toISOString().slice(11, 19);
            return `[${t}] (${e.via} → ${e.companion}) task: ${e.task}\n  outcome: ${e.summary}`;
          })
          .join("\n");

  const plan =
    board.length === 0
      ? "(the board is empty)"
      : board
          .map((b) => `[${b.id}] (${b.status}) ${b.title}${b.note ? ` — ${b.note}` : ""}`)
          .join("\n");

  return `WORKSPACE BOARD (current shared plan):\n${plan}\n\nRECENT ACTIVITY LOG:\n${log}`;
}

/* ---------------- board operations (plain state, no model involved) ---------------- */

export function listBoard(sessionId: string): BoardItem[] {
  const ws = workspaces.get(sessionId);
  if (!ws) return [];
  ws.lastSeen = Date.now();
  return ws.board;
}

export function addBoardItem(
  sessionId: string,
  input: { title: string; note?: string; status?: BoardStatus; createdBy: "human" | "agent" }
): BoardItem | { error: string } {
  const ws = touch(sessionId);
  if (ws.board.length >= MAX_BOARD_ITEMS) {
    return { error: `Board is full (max ${MAX_BOARD_ITEMS} items). Remove something first.` };
  }
  const title = input.title.trim().slice(0, MAX_TITLE);
  if (!title) return { error: "Item title must not be empty." };

  ws.boardCounter += 1;
  const item: BoardItem = {
    id: `b${ws.boardCounter}`,
    title,
    note: (input.note ?? "").trim().slice(0, MAX_NOTE),
    status: input.status === "doing" || input.status === "done" ? input.status : "todo",
    createdBy: input.createdBy,
    ts: Date.now(),
    updatedTs: Date.now(),
  };
  ws.board.push(item);
  return item;
}

export function updateBoardItem(
  sessionId: string,
  id: string,
  patch: { title?: string; note?: string; status?: BoardStatus }
): BoardItem | { error: string } {
  const ws = workspaces.get(sessionId);
  const item = ws?.board.find((b) => b.id === id);
  if (!ws || !item) return { error: `No board item "${id}". Use list_board to see current ids.` };
  ws.lastSeen = Date.now();

  if (patch.title !== undefined) {
    const t = patch.title.trim().slice(0, MAX_TITLE);
    if (!t) return { error: "Item title must not be empty." };
    item.title = t;
  }
  if (patch.note !== undefined) item.note = patch.note.trim().slice(0, MAX_NOTE);
  if (patch.status !== undefined) {
    if (!["todo", "pending", "doing", "done"].includes(patch.status)) {
      return { error: `Invalid status "${patch.status}". Use todo, doing or done.` };
    }
    item.status = patch.status;
  }
  item.updatedTs = Date.now();
  return item;
}

export function removeBoardItem(sessionId: string, id: string): BoardItem | { error: string } {
  const ws = workspaces.get(sessionId);
  if (!ws) return { error: `No board item "${id}".` };
  ws.lastSeen = Date.now();
  const idx = ws.board.findIndex((b) => b.id === id);
  if (idx === -1) return { error: `No board item "${id}". Use list_board to see current ids.` };
  const [removed] = ws.board.splice(idx, 1);
  return removed;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, ws] of workspaces) {
    if (now - ws.lastSeen > SESSION_IDLE_MS) workspaces.delete(id);
  }
}, SWEEP_EVERY_MS).unref();
