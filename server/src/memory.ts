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

interface Workspace {
  createdAt: number;
  lastSeen: number;
  entries: WorkspaceEntry[];
}

const MAX_ENTRIES_PER_SESSION = 60;
const SESSION_IDLE_MS = 45 * 60 * 1000; // dropped 45 min after last activity
const SWEEP_EVERY_MS = 5 * 60 * 1000;

const workspaces = new Map<string, Workspace>();

function touch(sessionId: string): Workspace {
  let ws = workspaces.get(sessionId);
  if (!ws) {
    ws = { createdAt: Date.now(), lastSeen: Date.now(), entries: [] };
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
  if (entries.length === 0) return "(the workspace is empty — nothing has happened in this session yet)";
  return entries
    .map((e) => {
      const t = new Date(e.ts).toISOString().slice(11, 19);
      return `[${t}] (${e.via} → ${e.companion}) task: ${e.task}\n  outcome: ${e.summary}`;
    })
    .join("\n");
}

setInterval(() => {
  const now = Date.now();
  for (const [id, ws] of workspaces) {
    if (now - ws.lastSeen > SESSION_IDLE_MS) workspaces.delete(id);
  }
}, SWEEP_EVERY_MS).unref();
