/**
 * Thin client for the Leia server + the session identity.
 * A session = one browser (localStorage UUID). The human chat and the
 * visiting agent's WebMCP calls share it — that's the whole point.
 */

export const API_BASE: string =
  (import.meta as any).env?.VITE_API_URL?.replace(/\/$/, "") ?? "http://localhost:8787";

const SESSION_KEY = "leia-session";

export function sessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export interface TeamMemberInfo {
  name: string;
  role: string;
  color: string;
}

export async function fetchTeam(opts?: { via?: "agent"; tool?: string }): Promise<TeamMemberInfo[]> {
  const params = new URLSearchParams();
  if (opts?.via === "agent") {
    params.set("session", sessionId());
    params.set("via", "agent");
    if (opts.tool) params.set("tool", opts.tool);
  }
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/team${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`team fetch failed (${res.status})`);
  const data = await res.json();
  return data.companions as TeamMemberInfo[];
}

export interface TaskResponse {
  taskId: string;
  companion: string;
  how: string;
  result: string;
}

export async function submitTask(input: {
  task: string;
  via: "human" | "agent";
  target?: string;
  tool?: string;
}): Promise<TaskResponse> {
  const res = await fetch(`${API_BASE}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sessionId(), ...input }),
    signal: AbortSignal.timeout(160_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `task failed (${res.status})`);
  return data as TaskResponse;
}

export async function recallMemory(query: string, via: "human" | "agent" = "human") {
  const res = await fetch(`${API_BASE}/api/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sessionId(), query, via }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `recall failed (${res.status})`);
  return data as {
    query: string;
    hits: { when: string; via: string; companion: string; task: string; summary: string }[];
  };
}

export async function fetchStatus(opts?: { via?: "agent"; tool?: string }) {
  const params = new URLSearchParams({ session: sessionId() });
  if (opts?.via === "agent") {
    params.set("via", "agent");
    if (opts.tool) params.set("tool", opts.tool);
  }
  const res = await fetch(`${API_BASE}/api/status?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `status failed (${res.status})`);
  return data as {
    busy: { companion: string; task: string }[];
    recent: { via: string; companion: string; task: string; summary: string }[];
  };
}

export type StreamEvent =
  | { type: "task"; taskId: string; via: "human" | "agent"; task: string }
  | { type: "routed"; taskId: string; companion: string; how: string }
  | { type: "working"; taskId: string; companion: string }
  | { type: "delta"; taskId: string; companion: string; text: string }
  | { type: "done"; taskId: string; companion: string; via: "human" | "agent"; result: string }
  | { type: "task-error"; taskId: string; companion?: string; message: string }
  | { type: "agent-tool"; tool: string; detail: string };

export function openStream(
  onEvent: (e: StreamEvent) => void,
  onState: (state: "open" | "down") => void
): () => void {
  let source: EventSource | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    source = new EventSource(`${API_BASE}/api/stream?session=${sessionId()}`);
    source.onopen = () => onState("open");
    source.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as StreamEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    source.onerror = () => {
      onState("down");
      source?.close();
      if (!closed) setTimeout(connect, 2500); // EventSource auto-retry is flaky cross-browser
    };
  };

  connect();
  return () => {
    closed = true;
    source?.close();
  };
}
