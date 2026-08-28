/**
 * Global, in-memory spend tracker for the public demo.
 *
 * Not per-session — this is "how much has the whole demo cost since the
 * server last started", which is what an operator actually wants to see
 * on the HUD. Resets on every redeploy, same as the rest of this server's
 * ephemeral state.
 *
 * The dollar figure is a courtesy ESTIMATE, not a bill: it's computed from
 * published per-model rates below, which can go stale the moment Anthropic
 * changes pricing. Token counts, by contrast, come straight from the API
 * response and are exact.
 */

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const usage = new Map<string, ModelUsage>();

// USD per million tokens (input/output). Verified against published rates
// as of August 2026 — check https://docs.claude.com/en/docs/about-claude/pricing
// before trusting this for anything that matters.
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
};
// fallback if a model is swapped in via env without updating the table above
const FALLBACK_PRICE = { in: 3.0, out: 15.0 };

export function record(model: string, inputTokens: number, outputTokens: number): void {
  const entry = usage.get(model) ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
  entry.inputTokens += inputTokens || 0;
  entry.outputTokens += outputTokens || 0;
  entry.calls += 1;
  usage.set(model, entry);
}

export function summary() {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCalls = 0;
  let estimatedCostUsd = 0;

  const byModel = [...usage.entries()].map(([model, u]) => {
    const price = PRICE_PER_MTOK[model] ?? FALLBACK_PRICE;
    const cost = (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out;
    totalInputTokens += u.inputTokens;
    totalOutputTokens += u.outputTokens;
    totalCalls += u.calls;
    estimatedCostUsd += cost;
    return { model, ...u, estimatedCostUsd: round(cost) };
  });

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCalls,
    estimatedCostUsd: round(estimatedCostUsd),
    byModel,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
