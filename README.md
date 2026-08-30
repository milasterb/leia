# Leia — a living agent workspace

Seven AI specialists. One orchestrator. A shared workspace that **you and your AI agent command together** — and a 3D world where you watch it happen.

Leia is a WebMCP demo built for the [OpenAI WebMCP Challenge](https://openai.com/webmcp-challenge/). Open the page as a human and you get a **shared board** (the plan), a chat console, and a particle constellation of seven companions. Open it in an agent's browser (ChatGPT's in-app browser, or Chrome with WebMCP enabled) and the same page exposes **ten structured tools** through the browser's WebMCP API.

The core of the demo is the board: **real, editable state that the human and the agent manipulate through the same operations** — add an item, move it todo → doing → done, attach notes. No model call happens on a board mutation; it is plain state the page owns, and every change renders live in the human's UI and in the 3D scene. On top of that sits the team: `delegate_board_item` sends a board item through Leia's routing to a specialist companion, and the outcome lands back **on the item itself** — plan and execution stay one thing.

**Human + agent, meaningfully better together:** the agent gains what it normally lacks — a persistent shared plan, a session workspace memory, and a team of role-specialized workers — while the human sees, steers and continues everything the agent did, in the same space.

## The team

| Companion | Specialty |
| --- | --- |
| **Smith** | engineering — writes, fixes and explains code |
| **Scout** | research — finds and verifies information (live web search) |
| **Keeper** | context — guards the shared workspace memory, recalls what the team knows |
| **Scribe** | writing — texts, docs, emails |
| **Planner** | planning — task breakdown, estimates, priorities |
| **Warden** | review — critiques work, finds holes and risks |
| **Analyst** | data — numbers, calculations, comparisons |

**Leia** herself does no work — she routes. Routing is two-tier: a small model decides by meaning; a keyword scorer is the fallback when the model call fails.

## Tools exposed over WebMCP

**The board — shared state, no model in the loop:**

| Tool | What it does |
| --- | --- |
| `list_board` | Read the current shared plan (ids, titles, notes, statuses) |
| `add_board_item` | Add an item to the plan the human is looking at |
| `update_board_item` | Move an item todo → doing → done, retitle it, attach a note |
| `remove_board_item` | Remove an obsolete item |
| `delegate_board_item` | Send an item through the team; the outcome lands back on the item and it flips to done |

**The team — specialists on demand:**

| Tool | What it does |
| --- | --- |
| `delegate_task` | Hand a free-form task to the team; Leia picks the right companion |
| `ask_companion` | Ask one specific companion directly, bypassing routing |
| `list_companions` | The roster and each companion's specialty |
| `get_team_status` | Who is busy with what right now + recent completed work |
| `recall_workspace_memory` | Search the shared per-session memory (human's and agent's work alike) |

Registration is defensive across spec revisions: the WebMCP preview has moved where it lives on the browser object between Chrome Canary builds (`navigator.modelContext` in earlier drafts, `document.modelContext` in some current ones), so the client checks both. `registerTool()` is used when available, `provideContext({ tools })` as an older-spec fallback, with a visible hint in the UI when the browser exposes neither.

## Architecture

```
web/      Vite + TypeScript + three.js  →  Vercel (static)
          the 3D world, the human console, the WebMCP tool layer

server/   Node 20 + Express + Anthropic SDK  →  Render (web service)
          orchestrator (two-tier routing), companion runner (streaming),
          session-scoped workspace memory, SSE event stream, rate limits
```

One design rule keeps the page coherent: **everything renders from the SSE event stream.** Human tasks, agent tool calls, routing decisions, streamed deltas — one stream, so the feed and the 3D scene always agree.

Session memory (the board, the activity log) is per-browser-session, in-process, and dropped after 45 minutes of inactivity — nothing there is shared between visitors, and nothing is persisted. The one deliberate exception is the token/cost tracker, which is a global running total across everyone using the demo (see Budget guards below); it resets only when the server restarts.

## Run locally

```bash
# server
cd server
cp .env.example .env        # put your ANTHROPIC_API_KEY in .env
npm install
npm run dev                 # http://localhost:8787

# web (second terminal)
cd web
npm install
npm run dev                 # http://localhost:5173
```

To exercise the WebMCP layer, open the page in ChatGPT's in-app browser or in Chrome with WebMCP enabled (experimental flag / origin trial), then ask the agent to e.g. *"use list_companions, then delegate a task to plan a weekend in Prague."*

## Deploy

- **web → Vercel:** project root `web/`, build `npm run build`, output `dist/`. Set `VITE_API_URL` to the server URL.
- **server → Render:** `render.yaml` in the repo root describes the service. Set **Language: Node** (Render sometimes defaults to Docker, which won't find a Dockerfile here) and **Root Directory: `server`**. Set `ANTHROPIC_API_KEY` (and `WEB_ORIGIN` to the Vercel URL) in the Render dashboard.

## Budget guards

This is a public demo running on a real API key, so the server enforces per-session rate limits, per-session and global concurrency caps, token ceilings and a hard task timeout. All tunable via env — see `server/.env.example`. A live token/cost readout in the HUD (`GET /api/usage`) tracks exact token counts per model since the server last started, with an approximate USD estimate from published rates — a courtesy figure, not a bill.

## Reliability & security

Built and pressure-tested past the happy path, since this runs a real, paid API key in public:

- **CORS locked to the deployed frontend** — the server only answers `leia-theta.vercel.app`, verified by attempting cross-origin requests from an unrelated domain
- **Sessions are isolated** — a session only ever sees its own board and memory; there is no cross-session read path
- **User-supplied board content is rendered as text, never HTML** — injected markup shows up literally, it doesn't execute
- **Every mutation is validated server-side**, independent of the client: type checks, length caps, and existence checks on ids, with the same guarantees whether the caller is the human UI or a WebMCP tool call
- **A board item can't be double-delegated** — concurrent or repeated delegation on the same item is rejected instead of silently paying for the same work twice
- **The live event stream self-heals** — if a connection goes quiet (some proxies drop idle connections without ever erroring), the client detects the silence and reconnects on its own

## Background

Leia was designed and built from scratch for this challenge — the repository, the architecture, and every line of code here are new. The companion-team concept, the two-tier routing design, and the particle-world aesthetic draw on my own experience building multi-agent AI systems and real-time 3D interfaces, but none of that prior experience takes the form of code reused here.

## AI assistance

This project was built with AI pair-programming assistance (Anthropic's Claude) during the challenge submission period, under my direction and review.

## License

[MIT](./LICENSE)
