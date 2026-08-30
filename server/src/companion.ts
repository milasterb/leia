/**
 * Runs one task on one companion: builds the persona prompt, calls the
 * model with streaming, publishes deltas to the session bus (the 3D
 * scene animates from these) and files a short summary into the shared
 * workspace memory when done.
 */

import Anthropic from "@anthropic-ai/sdk";
import { TeamMember, ORCHESTRATOR_NAME } from "./team.js";
import { publish } from "./bus.js";
import { remember, digest } from "./memory.js";
import { record as recordUsage } from "./usage.js";

const anthropic = new Anthropic();

const COMPANION_MODEL = process.env.COMPANION_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = Number(process.env.COMPANION_MAX_TOKENS ?? 1200);
const WEB_SEARCH_MAX_USES = Number(process.env.WEB_SEARCH_MAX_USES ?? 3);

export interface RunTaskInput {
  sessionId: string;
  taskId: string;
  member: TeamMember;
  task: string;
  via: "human" | "agent";
}

function buildSystemPrompt(member: TeamMember, sessionId: string): string {
  const workspace = digest(sessionId);
  return (
    `You are ${member.name}, a specialist on ${ORCHESTRATOR_NAME}'s team. ` +
    `Role: ${member.role}.\n\n` +
    `${member.personality}\n\n` +
    `You share one workspace with the human user and any AI agent acting on ` +
    `their behalf — both can see your answers. Recent workspace notes ` +
    `(what already happened in this session):\n${workspace}\n\n` +
    `Answer in English unless the task itself is written in another language — ` +
    `then answer in that language. Keep answers focused; this is a live ` +
    `demo, not a dissertation.\n\n` +
    `When you write out a COMPLETE file's worth of code (not a short inline ` +
    `snippet) — a full HTML page, a full CSS or JS file, a full config — open ` +
    `its code fence with the actual filename instead of just the language, ` +
    'e.g. ```index.html or ```styles.css rather than ```html or ```css. ' +
    `The page turns each fenced block into a downloadable file using exactly ` +
    `what you put after the backticks, so a real filename there means the ` +
    `person gets a working file instead of having to rename it themselves. ` +
    `Short snippets meant to illustrate a point, not to be saved as-is, can ` +
    `keep using a plain language label.`
  );
}

/** ~1-line summary for the workspace memory. Cheap: just truncate smartly. */
function summarize(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
}

export async function runTask(input: RunTaskInput): Promise<string> {
  const { sessionId, taskId, member, task, via } = input;

  publish(sessionId, { type: "working", taskId, companion: member.name });

  const tools: Anthropic.Messages.Tool[] | undefined = member.webSearch
    ? ([
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: WEB_SEARCH_MAX_USES,
        } as unknown as Anthropic.Messages.Tool,
      ])
    : undefined;

  const stream = anthropic.messages.stream({
    model: COMPANION_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(member, sessionId),
    messages: [{ role: "user", content: task }],
    ...(tools ? { tools } : {}),
  });

  stream.on("text", (delta) => {
    publish(sessionId, { type: "delta", taskId, companion: member.name, text: delta });
  });

  const finalMessage = await stream.finalMessage();
  recordUsage(COMPANION_MODEL, finalMessage.usage.input_tokens, finalMessage.usage.output_tokens);

  // A reply can hold SEVERAL text blocks — typically around a server-side
  // web search (text → search → text with findings). Taking only the first
  // block would throw away everything after the search.
  let result = finalMessage.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (finalMessage.stop_reason === "max_tokens") {
    result += "\n\n[reply truncated at the demo's token limit]";
  }

  remember(sessionId, { via, companion: member.name, task: summarize(task, 160), summary: summarize(result) });
  publish(sessionId, { type: "done", taskId, companion: member.name, via, result });

  return result;
}
