/**
 * Human-in-the-loop gate for agent-initiated work.
 *
 * Anything a HUMAN triggers (clicking Send, clicking the ⚡ on a board
 * item) runs immediately — they're right there, watching it happen.
 * Anything an AGENT triggers through a WebMCP tool call is different: it
 * runs autonomously, on a real paid API key, possibly while no one is
 * looking. So every agent-initiated task that would cost money lands
 * here first and waits for a human to approve or reject it — the
 * approval endpoint itself is never exposed as a WebMCP tool, on
 * purpose, so an agent can only ever propose work, never wave itself
 * through.
 */

export interface PendingApproval {
  taskId: string;
  sessionId: string;
  kind: "board" | "freeform";
  /** Board item id, only set when kind === "board". */
  boardId?: string;
  taskText: string;
  /** Direct companion target, only set for an ask_companion-style call. */
  target?: string;
  tool?: string;
  createdAt: number;
}

const PENDING_TTL_MS = 3 * 60 * 1000; // auto-reject after 3 minutes, unattended

const pending = new Map<string, PendingApproval>();

export function addPending(approval: PendingApproval): void {
  pending.set(approval.taskId, approval);
}

export function getPending(taskId: string): PendingApproval | undefined {
  return pending.get(taskId);
}

export function removePending(taskId: string): void {
  pending.delete(taskId);
}

/** Approvals older than the TTL — the caller is responsible for rejecting and cleaning each one up. */
export function sweepExpired(): PendingApproval[] {
  const now = Date.now();
  const expired: PendingApproval[] = [];
  for (const approval of pending.values()) {
    if (now - approval.createdAt > PENDING_TTL_MS) expired.push(approval);
  }
  return expired;
}
