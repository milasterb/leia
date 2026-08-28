/**
 * Budget guards for a public demo running on a real API key.
 *
 *  - per-session sliding window (tasks per minute)
 *  - per-session concurrency (parallel tasks)
 *  - global concurrency across all visitors
 *
 * All in-process and deliberately unfancy. If the demo ever needs more
 * than one server instance, this is the first thing to replace.
 */

const WINDOW_MS = 60_000;
const MAX_TASKS_PER_WINDOW = Number(process.env.MAX_TASKS_PER_MINUTE ?? 8);
const MAX_SESSION_CONCURRENT = Number(process.env.MAX_SESSION_CONCURRENT ?? 2);
const MAX_GLOBAL_CONCURRENT = Number(process.env.MAX_GLOBAL_CONCURRENT ?? 4);

const history = new Map<string, number[]>();
const running = new Map<string, number>();
let globalRunning = 0;

export function tryAcquire(sessionId: string): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();

  const recent = (history.get(sessionId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_TASKS_PER_WINDOW) {
    history.set(sessionId, recent);
    return {
      ok: false,
      reason: `Rate limit: max ${MAX_TASKS_PER_WINDOW} tasks per minute per session. Wait a moment and try again.`,
    };
  }

  const mine = running.get(sessionId) ?? 0;
  if (mine >= MAX_SESSION_CONCURRENT) {
    return {
      ok: false,
      reason: `This session already has ${mine} tasks running. Wait for one to finish.`,
    };
  }

  if (globalRunning >= MAX_GLOBAL_CONCURRENT) {
    return {
      ok: false,
      reason: "The team is at capacity right now (public demo). Try again in a few seconds.",
    };
  }

  recent.push(now);
  history.set(sessionId, recent);
  running.set(sessionId, mine + 1);
  globalRunning++;
  return { ok: true };
}

export function release(sessionId: string): void {
  const mine = running.get(sessionId) ?? 1;
  if (mine <= 1) running.delete(sessionId);
  else running.set(sessionId, mine - 1);
  globalRunning = Math.max(0, globalRunning - 1);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, times] of history) {
    const recent = times.filter((t) => now - t < WINDOW_MS);
    if (recent.length === 0) history.delete(id);
    else history.set(id, recent);
  }
}, WINDOW_MS).unref();
