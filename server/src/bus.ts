/**
 * Per-session event bus. The home version of this system publishes events
 * over NATS; the demo replaces that with a tiny in-process pub/sub feeding
 * one SSE stream per browser session.
 *
 * Everything that happens — a human message, an agent's WebMCP tool call,
 * routing, streamed deltas, completions — flows through here, which is
 * what lets the 3D scene animate the work in real time.
 */

import type { BoardItem } from "./memory.js";

export type BusEvent =
  | { type: "task"; taskId: string; via: "human" | "agent"; task: string }
  | { type: "routed"; taskId: string; companion: string; how: string }
  | { type: "working"; taskId: string; companion: string }
  | { type: "delta"; taskId: string; companion: string; text: string }
  | { type: "done"; taskId: string; companion: string; via: "human" | "agent"; result: string }
  | { type: "task-error"; taskId: string; companion?: string; message: string }
  | { type: "agent-tool"; tool: string; detail: string }
  | { type: "status"; busy: { companion: string; task: string }[] }
  | {
      type: "board";
      items: BoardItem[];
      changed?: { id: string; action: "add" | "update" | "remove"; via: "human" | "agent"; title: string };
    }
  | {
      // agent-initiated work that needs a human's go-ahead before it runs.
      // "board" pending items show their Approve/Reject controls on the
      // board card itself; "freeform" ones (delegate_task/ask_companion,
      // not tied to any board item) show them inline in the feed, since
      // the feed is the only place that request is visible at all.
      type: "pending";
      taskId: string;
      kind: "board" | "freeform";
      task: string;
      boardId?: string;
      target?: string;
    }
  | { type: "pending-resolved"; taskId: string; decision: "approved" | "rejected" | "expired" };

type Listener = (e: BusEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(sessionId: string, fn: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}

export function publish(sessionId: string, event: BusEvent): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* one broken listener must not break the rest */
    }
  }
}
