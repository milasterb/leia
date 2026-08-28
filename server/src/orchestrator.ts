/**
 * Leia — the orchestrator ("manager"). She does no work herself; she only
 * decides WHO the task belongs to.
 *
 * Routing has two tiers (same design as the home system this demo is
 * derived from):
 *   1. Model — a cheap, tiny call decides by MEANING. Handles phrasing
 *      the keyword list never anticipated.
 *   2. Keywords — the fallback when the model call fails (API outage,
 *      missing key). Cheap and reliable, just dumb.
 */

import Anthropic from "@anthropic-ai/sdk";
import { TEAM, findMember, ORCHESTRATOR_NAME } from "./team.js";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const ROUTER_MODEL = process.env.ROUTER_MODEL ?? "claude-haiku-4-5-20251001";

export interface RouteResult {
  companion: string;
  how: "model" | "keywords" | "fallback";
}

/**
 * Keyword fallback. Doesn't take the first hit — it counts HOW MANY
 * keywords match and takes the best score. Without that, "review this
 * code" would land on Smith (matched "code") instead of Warden (matches
 * both "review" and "code") just because Smith is earlier in the list.
 */
export function routeByKeywords(task: string): string | null {
  const lowered = task.toLowerCase();
  let best: { companion: string; score: number } | null = null;

  for (const member of TEAM) {
    const score = member.keywords.filter((kw) => lowered.includes(kw)).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { companion: member.name, score };
    }
  }
  return best?.companion ?? null;
}

async function routeByModel(task: string): Promise<string | null> {
  const list = TEAM.map((m) => `- ${m.name}: ${m.role}`).join("\n");

  const system =
    `You are ${ORCHESTRATOR_NAME}, the orchestrator of a team of AI specialists. ` +
    `Decide which team member the given task belongs to.\n\n` +
    `Team:\n${list}\n\n` +
    `Answer with ONLY the name of one member, exactly as written above. ` +
    `No explanation, no extra punctuation. If unsure, pick the closest role.`;

  try {
    const response = await anthropic.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 16,
      system,
      messages: [{ role: "user", content: task }],
    });

    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");

    return findMember(answer)?.name ?? null;
  } catch {
    return null; // API failed — fall through to keywords
  }
}

/** Model first, keywords second, first-in-list as the visible last resort. */
export async function route(task: string): Promise<RouteResult> {
  const byModel = await routeByModel(task);
  if (byModel) return { companion: byModel, how: "model" };

  const byKeywords = routeByKeywords(task);
  if (byKeywords) return { companion: byKeywords, how: "keywords" };

  return { companion: TEAM[0].name, how: "fallback" };
}
