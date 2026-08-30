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
import {
  fetchTeam,
  fetchBoard,
  mutateBoard,
  delegateBoardItem,
  approveTask,
  fetchUsage,
  openStream,
  submitTask,
  sessionId,
  TeamMemberInfo,
  StreamEvent,
  BoardItem,
} from "./api.js";
import { initScene, SceneHandle } from "./scene.js";
import { registerWebMCP, TOOLS } from "./webmcp.js";
import { renderMarkdown } from "./markdown.js";
import { attachDownloadButtons } from "./downloads.js";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const feed = $("#feed") as HTMLDivElement;
const conn = $("#conn") as HTMLDivElement;
const usageEl = $("#usage") as HTMLDivElement;
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
    attachDownloadButtons(live.bubble);
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

/* ---------------- board (shared plan) ---------------- */

const boardItemsEl = $("#board-items") as HTMLDivElement;
const boardCount = $("#board-count") as HTMLSpanElement;
const boardComposer = $("#board-composer") as HTMLFormElement;
const boardInput = $("#board-input") as HTMLInputElement;

let lastFlashId: string | null = null;

const NEXT_STATUS: Record<string, "todo" | "doing" | "done"> = {
  todo: "doing",
  doing: "done",
  done: "todo",
};

/* ---------------- human-in-the-loop: agent proposals waiting on a person ---------------- */

interface PendingInfo {
  kind: "board" | "freeform";
  boardId?: string;
  task: string;
  target?: string;
  feedEl?: HTMLElement;
}
const pendingApprovals = new Map<string, PendingInfo>(); // taskId -> info

function pendingTaskIdFor(boardId: string): string {
  for (const [taskId, p] of pendingApprovals) if (p.boardId === boardId) return taskId;
  return "";
}

function addPendingBubble(taskId: string, task: string, target?: string) {
  ensureNotEmpty();
  const el = document.createElement("div");
  el.className = "msg pending";
  const who = target ? `wants to ask ${target} directly` : "wants to delegate this to the team";
  el.innerHTML = `
    <div class="who">your agent · proposal</div>
    <div class="bubble"></div>
    <div class="pending-controls">
      <button class="approve">✓ Approve</button>
      <button class="reject">✗ Reject</button>
    </div>`;
  el.querySelector(".bubble")!.textContent = `${who}:\n"${task}"`;
  const approveBtn = el.querySelector(".approve") as HTMLButtonElement;
  const rejectBtn = el.querySelector(".reject") as HTMLButtonElement;
  approveBtn.addEventListener("click", () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    approveTask(taskId, "approve").catch((e) => addError("local", e instanceof Error ? e.message : "Approve failed."));
  });
  rejectBtn.addEventListener("click", () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    approveTask(taskId, "reject").catch((e) => addError("local", e instanceof Error ? e.message : "Reject failed."));
  });
  feed.appendChild(el);
  scrollFeed();
  return el;
}

function resolvePendingBubble(el: HTMLElement, decision: "approved" | "rejected" | "expired") {
  const controls = el.querySelector(".pending-controls");
  controls?.remove();
  const note = document.createElement("div");
  note.className = "pending-note";
  note.textContent =
    decision === "approved" ? "→ approved, running now" : decision === "rejected" ? "→ rejected" : "→ expired (no response)";
  el.appendChild(note);
}

function renderBoard(items: BoardItem[]) {
  boardCount.textContent = items.length
    ? `${items.filter((b) => b.status === "done").length}/${items.length} done`
    : "";
  boardItemsEl.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent = "No plan yet — add an item, or let your agent lay one out.";
    boardItemsEl.appendChild(empty);
    scene?.setBoard([]);
    return;
  }

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "board-item";
    el.dataset.status = item.status;
    if (item.id === lastFlashId) {
      el.classList.add("flash");
    }

    const statusBtn = document.createElement("button");
    statusBtn.className = "board-status";
    if (item.status === "pending") {
      statusBtn.disabled = true;
      statusBtn.title = "Your agent proposed this — waiting for your approval";
    } else {
      statusBtn.title =
        item.status === "todo"
          ? "todo — click to mark doing yourself (this also locks out delegating it to the team)"
          : `${item.status} — click to move to ${NEXT_STATUS[item.status]}`;
      statusBtn.addEventListener("click", () => {
        mutateBoard({ action: "update", id: item.id, status: NEXT_STATUS[item.status], via: "human" }).catch((e) =>
          addError("local", e instanceof Error ? e.message : "Board update failed.")
        );
      });
    }

    const textWrap = document.createElement("div");
    textWrap.className = "board-text";
    const title = document.createElement("div");
    title.className = "board-item-title";
    title.textContent = item.title;
    title.title = item.title;
    textWrap.appendChild(title);
    if (item.note) {
      const note = document.createElement("div");
      note.className = "board-item-note";
      note.textContent = item.note;
      note.title = item.note;
      textWrap.appendChild(note);
    }

    const actions = document.createElement("div");
    actions.className = "board-actions";

    if (item.status === "pending") {
      // this is the ONLY place a pending item can be waved through — no
      // WebMCP tool can call this, only a human clicking here
      actions.classList.add("pending-actions");
      const approveBtn = document.createElement("button");
      approveBtn.textContent = "✓";
      approveBtn.className = "approve";
      approveBtn.title = "Approve — let the team actually run this";
      approveBtn.addEventListener("click", () => {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        approveTask(pendingTaskIdFor(item.id), "approve").catch((e) =>
          addError("local", e instanceof Error ? e.message : "Approve failed.")
        );
      });
      const rejectBtn = document.createElement("button");
      rejectBtn.textContent = "✗";
      rejectBtn.className = "reject";
      rejectBtn.title = "Reject — send it back to todo, nothing runs";
      rejectBtn.addEventListener("click", () => {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        approveTask(pendingTaskIdFor(item.id), "reject").catch((e) =>
          addError("local", e instanceof Error ? e.message : "Reject failed.")
        );
      });
      actions.append(approveBtn, rejectBtn);
    } else {
      const runBtn = document.createElement("button");
      runBtn.textContent = "⚡";
      runBtn.disabled = item.status === "doing";
      runBtn.title = runBtn.disabled
        ? "Already marked doing — move it back to todo (click the status circle) to delegate it"
        : "Send to the team (Leia routes it, outcome lands back on the item)";
      runBtn.addEventListener("click", () => {
        runBtn.disabled = true;
        runBtn.title = "Sending…";
        delegateBoardItem(item.id, "human").catch((e) =>
          addError("local", e instanceof Error ? e.message : "Delegation failed.")
        );
      });

      const delBtn = document.createElement("button");
      delBtn.textContent = "×";
      delBtn.title = "Remove from board";
      delBtn.addEventListener("click", () => {
        mutateBoard({ action: "remove", id: item.id, via: "human" }).catch((e) =>
          addError("local", e instanceof Error ? e.message : "Remove failed.")
        );
      });

      actions.append(runBtn, delBtn);
    }

    el.append(statusBtn, textWrap);
    if (item.createdBy === "agent") {
      const badge = document.createElement("span");
      badge.className = "by-agent";
      badge.textContent = "agent";
      badge.title = "Added by your agent";
      el.appendChild(badge);
    }
    el.appendChild(actions);
    boardItemsEl.appendChild(el);
  }

  scene?.setBoard(items.map((b) => ({ status: b.status, createdBy: b.createdBy })));
  lastFlashId = null;
}

boardComposer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const title = boardInput.value.trim();
  if (!title) return;
  boardInput.value = "";
  mutateBoard({ action: "add", title, via: "human" }).catch((e) =>
    addError("local", e instanceof Error ? e.message : "Could not add board item.")
  );
});

/* ---------------- usage / cost estimate ---------------- */

let usageTimer = 0;
function refreshUsage() {
  fetchUsage()
    .then((u) => {
      if (u.totalCalls === 0) {
        usageEl.textContent = "";
        return;
      }
      const tokens = u.totalInputTokens + u.totalOutputTokens;
      const tokensFmt = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
      usageEl.textContent = `~${tokensFmt} tokens · ~$${u.estimatedCostUsd.toFixed(3)} (demo total, est.)`;
    })
    .catch(() => {
      /* purely cosmetic — silently skip on failure */
    });
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
      `WebMCP is active (via <code>${status.anchor}.modelContext</code>). Ask your agent to ` +
      "<code>list_companions</code> and watch the field light up.";
  } else {
    pillText.textContent = "Agent link · inactive";
    agentHint.innerHTML =
      "This browser doesn't expose <code>modelContext</code>. Open this page in " +
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
      refreshUsage(); // this companion's call is already recorded server-side by the time "done" arrives
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
    case "board": {
      if (e.changed) {
        lastFlashId = e.changed.id;
        const who = e.changed.via === "agent" ? "agent" : "you";
        const verb =
          e.changed.action === "add" ? "added" : e.changed.action === "remove" ? "removed" : "updated";
        addSystemLine(`⚑ ${who} ${verb} “${e.changed.title}” on the board`);
      }
      renderBoard(e.items);
      break;
    }
    case "pending": {
      if (e.kind === "board" && e.boardId) {
        pendingApprovals.set(e.taskId, { kind: "board", boardId: e.boardId, task: e.task });
        addSystemLine(`⏳ your agent proposed “${e.task}” — approve it on the board`);
      } else {
        const feedEl = addPendingBubble(e.taskId, e.task, e.target);
        pendingApprovals.set(e.taskId, { kind: "freeform", task: e.task, target: e.target, feedEl });
      }
      break;
    }
    case "pending-resolved": {
      const info = pendingApprovals.get(e.taskId);
      if (info?.feedEl) resolvePendingBubble(info.feedEl, e.decision);
      pendingApprovals.delete(e.taskId);
      break;
    }
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
  refreshUsage();
  clearInterval(usageTimer);
  usageTimer = window.setInterval(refreshUsage, 20_000); // catches spend from other visitors too

  await document.fonts.ready.catch(() => {});
  scene = initScene($("#world") as HTMLCanvasElement, team);

  // AFTER the scene exists — otherwise items already on the board at page
  // load render in the panel but never make it into the 3D ring
  fetchBoard()
    .then(renderBoard)
    .catch(() => {}); // board also comes in over SSE on first change

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
