/**
 * Entry point: fetch the roster, build the 3D world, open the live
 * stream, register the WebMCP tools, and wire the human console.
 *
 * One rule keeps the whole page coherent: everything renders from
 * SSE events. The human's own tasks, the agent's WebMCP calls, the
 * streamed deltas — all arrive through the same stream, so the feed
 * and the 3D scene always agree on what's happening.
 */

import "./style.css";
import { fetchTeam, openStream, submitTask, sessionId, TeamMemberInfo, StreamEvent } from "./api.js";
import { initScene, SceneHandle } from "./scene.js";
import { registerWebMCP, TOOLS } from "./webmcp.js";
import { renderMarkdown } from "./markdown.js";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const feed = $("#feed") as HTMLDivElement;
const conn = $("#conn") as HTMLDivElement;
const legend = $("#legend") as HTMLElement;
const composer = $("#composer") as HTMLFormElement;
const input = $("#task-input") as HTMLInputElement;
const send = $("#send") as HTMLButtonElement;

let scene: SceneHandle | null = null;
let team: TeamMemberInfo[] = [];
const colorOf = (name: string) =>
  team.find((m) => m.name.toLowerCase() === name.toLowerCase())?.color ?? "#8f88ad";

/* ---------------- feed rendering ---------------- */

const emptyState = document.createElement("div");
emptyState.className = "empty-state";
emptyState.innerHTML =
  "The workspace is quiet.<br />Type a task below — or open this page in an agent's browser " +
  "and let it call the tools.<br /><span class=\"kbd\">try: “plan a 3-day Prague trip”</span>";
feed.appendChild(emptyState);

let hasMessages = false;
function ensureNotEmpty() {
  if (!hasMessages) {
    emptyState.remove();
    hasMessages = true;
  }
}

function scrollFeed() {
  feed.scrollTop = feed.scrollHeight;
}

function addHumanOrAgentTask(via: "human" | "agent", task: string) {
  ensureNotEmpty();
  const el = document.createElement("div");
  el.className = `msg you${via === "agent" ? " agent-origin" : ""}`;
  el.innerHTML = `<div class="who">${via === "agent" ? "your agent" : "you"}</div><div class="bubble"></div>`;
  el.querySelector(".bubble")!.textContent = task;
  feed.appendChild(el);
  scrollFeed();
}

function addSystemLine(text: string) {
  ensureNotEmpty();
  const el = document.createElement("div");
  el.className = "msg sys";
  el.textContent = text;
  feed.appendChild(el);
  scrollFeed();
}

function addAgentCall(tool: string, detail: string) {
  ensureNotEmpty();
  const el = document.createElement("div");
  el.className = "agent-call";
  el.innerHTML = `<span class="glyph">⟡</span>agent → <strong></strong> · <span class="d"></span>`;
  el.querySelector("strong")!.textContent = tool;
  el.querySelector(".d")!.textContent = detail;
  feed.appendChild(el);
  scrollFeed();
  flashAgentPill();
}

interface LiveBubble {
  el: HTMLDivElement;
  bubble: HTMLDivElement;
  streamed: boolean;
}
const liveBubbles = new Map<string, LiveBubble>();

function startCompanionBubble(taskId: string, companion: string) {
  ensureNotEmpty();
  const el = document.createElement("div");
  el.className = "msg bot";
  el.innerHTML = `<div class="who"><span class="who-dot"></span><span class="n"></span></div><div class="bubble"></div>`;
  (el.querySelector(".who-dot") as HTMLElement).style.setProperty("--c", colorOf(companion));
  el.querySelector(".n")!.textContent = companion;
  feed.appendChild(el);
  const bubble = el.querySelector(".bubble") as HTMLDivElement;
  bubble.textContent = "…";
  liveBubbles.set(taskId, { el, bubble, streamed: false });
  scrollFeed();
}

function appendDelta(taskId: string, text: string) {
  const live = liveBubbles.get(taskId);
  if (!live) return;
  if (!live.streamed) {
    live.bubble.textContent = "";
    live.streamed = true;
  }
  live.bubble.textContent += text;
  scrollFeed();
}

function finishBubble(taskId: string, companion: string, result: string) {
  const live = liveBubbles.get(taskId);
  if (live) {
    live.bubble.innerHTML = renderMarkdown(result); // authoritative final text, formatted
    liveBubbles.delete(taskId);
  } else {
    startCompanionBubble(taskId, companion);
    finishBubble(taskId, companion, result);
    return;
  }
  scrollFeed();
}

function addError(taskId: string, message: string) {
  const live = liveBubbles.get(taskId);
  if (live) {
    live.el.classList.add("err");
    live.bubble.textContent = message;
    liveBubbles.delete(taskId);
  } else {
    ensureNotEmpty();
    const el = document.createElement("div");
    el.className = "msg bot err";
    el.innerHTML = `<div class="who">error</div><div class="bubble"></div>`;
    el.querySelector(".bubble")!.textContent = message;
    feed.appendChild(el);
  }
  scrollFeed();
}

/* ---------------- legend ---------------- */

function renderLegend() {
  legend.innerHTML = "";
  for (const m of team) {
    const chip = document.createElement("div");
    chip.className = "legend-chip";
    chip.dataset.name = m.name.toLowerCase();
    chip.style.setProperty("--c", m.color);
    const shortRole = m.role.split("—")[1]?.trim() ?? m.role;
    chip.innerHTML = `<span class="swatch"></span><span class="who"></span><span class="role-hint"></span>`;
    chip.querySelector(".who")!.textContent = m.name;
    chip.querySelector(".role-hint")!.textContent = `· ${shortRole}`;
    legend.appendChild(chip);
  }
}

function setChipWorking(name: string, working: boolean) {
  const chip = legend.querySelector<HTMLElement>(`[data-name="${name.toLowerCase()}"]`);
  chip?.classList.toggle("working", working);
}

/* ---------------- agent pill / drawer ---------------- */

const pill = $("#agent-pill") as HTMLButtonElement;
const pillText = $("#agent-pill-text") as HTMLSpanElement;
const drawer = $("#agent-drawer") as HTMLDivElement;
const toolsList = $("#agent-tools") as HTMLUListElement;
const agentHint = $("#agent-hint") as HTMLParagraphElement;

pill.addEventListener("click", () => {
  const open = drawer.hidden;
  drawer.hidden = !open;
  pill.setAttribute("aria-expanded", String(open));
});

let pillFlashTimer = 0;
function flashAgentPill() {
  pill.classList.add("flash");
  clearTimeout(pillFlashTimer);
  pillFlashTimer = window.setTimeout(() => pill.classList.remove("flash"), 750);
}

function renderAgentPanel() {
  toolsList.innerHTML = "";
  for (const tool of TOOLS) {
    const li = document.createElement("li");
    const short = tool.description.split(".")[0] + ".";
    li.innerHTML = `<span class="t"></span><span class="tool-desc"></span>`;
    li.querySelector(".t")!.textContent = tool.name;
    li.querySelector(".tool-desc")!.textContent = short;
    toolsList.appendChild(li);
  }

  const status = registerWebMCP();
  if (status.available) {
    pill.classList.add("live");
    pillText.textContent = `Agent link · ${TOOLS.length} tools live`;
    agentHint.innerHTML =
      "WebMCP is active. Ask your agent to <code>list_companions</code> and watch the field light up.";
  } else {
    pillText.textContent = "Agent link · inactive";
    agentHint.innerHTML =
      "This browser doesn't expose <code>navigator.modelContext</code>. Open this page in " +
      "ChatGPT's in-app browser, or enable WebMCP in Chrome (experimental flag / origin trial), " +
      "and the team becomes callable by your agent.";
  }
}

/* ---------------- stream wiring ---------------- */

function handleEvent(e: StreamEvent) {
  switch (e.type) {
    case "task":
      addHumanOrAgentTask(e.via, e.task);
      break;
    case "routed":
      addSystemLine(`Leia → ${e.companion} (${e.how})`);
      scene?.beamTo(e.companion);
      break;
    case "working":
      scene?.setWorking(e.companion, true);
      setChipWorking(e.companion, true);
      startCompanionBubble(e.taskId, e.companion);
      break;
    case "delta":
      appendDelta(e.taskId, e.text);
      break;
    case "done":
      scene?.setWorking(e.companion, false);
      setChipWorking(e.companion, false);
      scene?.flashDone(e.companion);
      finishBubble(e.taskId, e.companion, e.result);
      break;
    case "task-error":
      if (e.companion) {
        scene?.setWorking(e.companion, false);
        setChipWorking(e.companion, false);
      }
      addError(e.taskId, e.message);
      break;
    case "agent-tool":
      addAgentCall(e.tool, e.detail);
      break;
  }
}

/* ---------------- human composer ---------------- */

composer.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const task = input.value.trim();
  if (!task) return;
  input.value = "";
  send.disabled = true;
  try {
    // rendering happens via SSE events; we only need to await + surface errors
    await submitTask({ task, via: "human" });
  } catch (err) {
    addError("local", err instanceof Error ? err.message : "Task failed.");
  } finally {
    send.disabled = false;
    input.focus();
  }
});

/* ---------------- boot ---------------- */

async function boot() {
  conn.textContent = `session ${sessionId().slice(0, 8)} · connecting…`;
  try {
    team = await fetchTeam();
  } catch {
    conn.textContent = "server unreachable — is the Leia server running?";
    conn.classList.add("err");
    renderAgentPanel(); // tools still register; they'll error politely if called
    return;
  }

  renderLegend();
  renderAgentPanel();

  await document.fonts.ready.catch(() => {});
  scene = initScene($("#world") as HTMLCanvasElement, team);

  openStream(handleEvent, (state) => {
    if (state === "open") {
      conn.textContent = `session ${sessionId().slice(0, 8)} · live`;
      conn.classList.add("ok");
      conn.classList.remove("err");
    } else {
      conn.textContent = `session ${sessionId().slice(0, 8)} · reconnecting…`;
      conn.classList.remove("ok");
    }
  });
}

boot();
