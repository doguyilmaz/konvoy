# konvoy — design

**Status:** approved design, pre-implementation
**Date:** 2026-09-19
**Binary:** `konvoy`

## 1. Problem

Four agentic coding CLIs are in daily use — Claude Code, Codex, Kiro CLI, opencode — and
switching between them is manual. Each keeps its own sessions, its own context, its own
model and effort settings. Work started in one cannot continue in another without
re-explaining everything. There is no way to make them cooperate on a single task.

## 2. Goals

1. **One session, four agents.** A konvoy session binds one foreign session per CLI and
   survives restarts; `konvoy resume` reconnects all of them.
2. **Shared context.** All four read and write one ledger, so a fact discovered by one is
   available to the rest without re-prompting.
3. **Delegation.** Agents hand work to each other directly, choosing the recipient
   themselves, and each CLI's own subagents keep working as a layer below.
4. **Per-agent tuning.** Model, reasoning effort and permission level are set globally,
   per project, per session, or per agent, from one place.
5. **Thin.** `konvoy attach codex` drops into the real Codex TUI. konvoy never
   reimplements an agent's interface.
6. **Graceful.** A CLI that is missing, logged out, upgraded, or broken degrades the
   session instead of failing it.

## 3. Non-goals

- No account/API-key brokering. Every CLI authenticates itself, locally, as it does today.
- No custom TUI in v1. The dashboard is `konvoy roster` / `konvoy status`, plain text.
- No model calls of konvoy's own. konvoy has no LLM; all intelligence lives in the four CLIs.
- No replacement for each CLI's config. konvoy layers on top and never rewrites user config
  files in place.

## 4. Verified capability matrix

Established by direct inspection on 2026-09-19 (versions: claude 2.1.278, codex-cli 0.155.1,
kiro-cli 2.22.1, opencode 1.17.18). Everything below is evidence-backed, not assumed.

| | claude | codex | kiro | opencode |
|---|---|---|---|---|
| headless turn | `claude -p` | `codex exec` | `kiro-cli chat --no-interactive` | `opencode run` |
| **we choose session id** | **yes** — `--session-id <uuid>` | no | no (`sess_<uuid>`) | no (`ses_...`; supplied `id` silently ignored) |
| resume | `--resume <id>`, `--fork-session` | `codex exec resume <id>` | `--resume-id <id>` | `-s <id>`, `--fork` |
| event stream | `--output-format stream-json` (and `--input-format stream-json`, bidirectional) | `--json` (JSONL) | `--output-format stream-json` (ACP events) | `--format json` |
| **where the id appears** | we already know it | `session_meta.payload.id` | `sessionId` on every event | `sessionID` on every line |
| final message | `result` event | `task_complete.last_agent_message`, or `-o <file>` | last `agent_message_chunk` | last `text` event |
| **structured final answer** | — | **`--output-schema <file>`** (works on `resume` too) | — | — |
| model | `--model` | `-m` | `--model` | `-m provider/model` |
| effort | `--effort low\|medium\|high\|xhigh\|max` | `-c model_reasoning_effort=…` | `--effort …` | `--variant …` |
| effort vocabulary | fixed | **per model** (`models_cache.json`) | **per model** (server-supplied) | **per model** (derived from provider caps) |
| MCP injection (no global edit) | `--mcp-config <json>` + `--strict-mcp-config` | `-c mcp_servers.konvoy.command=…` | per-agent `mcpServers` in agent JSON | `OPENCODE_CONFIG=<our file>` |
| prelude surface | `--append-system-prompt`, `--agents <json>` | prompt prefix / profile / `AGENTS.md` | agent JSON `prompt: "file:///…"` (live file!) | config `instructions: []` + agent `prompt` |
| rename / title | — | auto only (TUI-side rename exists) | `/title` slash command | **`title` on create and `PATCH /session/{id}`** |
| isolation | worktree via harness | **`--worktree`** | — | `/experimental/worktree/*` |
| persistent protocol (v2) | bidirectional stream-json | `app-server` JSON-RPC (stdio/unix/ws) | `kiro-cli acp` (full ACP: `session/new\|prompt\|resume\|fork\|steer\|cancel`) | `opencode acp`, `opencode serve` (HTTP + SSE) |
| interrupt a running turn | — | app-server | **`session/steer`, `session/cancel`** | `POST /session/{id}/abort` |

Consequences that shape the design:

- Only Claude accepts a caller-supplied session id, so a shared id across all four is
  impossible. **The binding table is the single source of truth**; native titles are set
  where supported (`konvoy:<slug>`) purely as a human convenience.
- Three of four re-emit the session id on every event, so binding is "read the first line
  and store it" — no handshake protocol is needed.
- Effort vocabularies are model-dependent everywhere except Claude. A fixed mapping table
  would be wrong; konvoy clamps to the target's supported set and reports the clamp.
- Kiro's agent JSON accepts `prompt: "file:///abs/path.md"`. The prelude is *referenced*,
  not copied, so editing one file updates the agent on its next turn.

## 5. Concepts

**Session** — a named unit of work bound to a directory. Holds the goal, the bindings, the
ledger, the policy, and the turn history.

**Binding** — one row per agent: foreign session id, model, effort, permission profile,
worktree, status, turn count, cost. Created lazily on an agent's first turn.

**Ledger** — append-only shared memory, `.konvoy/<slug>/LEDGER.md`. Every line is stamped
with author and kind (`decision`, `finding`, `artifact`, `question`, `handoff`). Append-only
means four concurrent writers never need a merge.

**Brief** — `.konvoy/<slug>/CONTEXT.md`. The stable part: goal, constraints, conventions,
roster. Regenerated by konvoy whenever session config changes; agents reference it by path.

**Roster** — who is in the convoy right now, with effective model, effort and state.

**Role** — an optional label (`lead`, `implementer`, `reviewer`, `researcher`) mapped to an
agent. Roles are hints for delegation, not enforcement. The lead is the agent `konvoy run` addresses by default; with none configured it is the first enabled agent.

## 6. CLI surface

```
konvoy new [goal]              create a session in cwd, write brief, bind lazily
konvoy start                   alias of new
konvoy send <agent> "msg"      one headless turn against one agent
konvoy run "task"              lead agent runs the task with delegation enabled
konvoy attach <agent>          drop into that CLI's real interactive UI, same session
konvoy resume [session]        re-select a session, verify bindings, print roster
konvoy ls                      list konvoy sessions
konvoy roster                  per-agent: bound id, model, effort, permission, turns, cost
konvoy status                  roster + versions + auth + drift + warnings
konvoy ledger [-f]             read (or follow) the shared ledger
konvoy config get|set          layered config, single source of truth
konvoy doctor                  installed / authed / version / capability checks + fixes
konvoy update [--all]          update konvoy, and with --all the four CLIs
konvoy version                 konvoy + all four versions in one block
konvoy rm <session>            delete a session (bindings kept in the foreign CLIs)
konvoy mcp                     internal: stdio MCP server injected into agents
```

Every command takes `--session <slug>`; without it the session bound to cwd is used.

## 7. Architecture

```
cmd/            argument parsing, output formatting, exit codes
core/
  session.ts    lifecycle: new, resume, bind, close
  turn.ts       runs one turn: spawn → stream → normalize → persist → final
  ledger.ts     append-only reader/writer
  brief.ts      regenerates CONTEXT.md from config + roster
  policy.ts     delegation depth, cycles, budget, timeouts, permissions
  effort.ts     normalization + capability-aware clamping
  store.ts      bun:sqlite schema and queries
adapters/
  claude.ts  codex.ts  kiro.ts  opencode.ts
  types.ts      Adapter interface + normalized event union
mcp/
  server.ts     stdio MCP server exposing konvoy tools to agents
  tools.ts      tool definitions and handlers
```

### Adapter interface

```ts
interface Adapter {
  id: AgentId
  bin: string
  detect(): Promise<Detection>                  // installed, version, authed, caps
  turn(ctx: TurnContext): SpawnPlan             // headless one-shot (v1 path)
  parse(line: string): KonvoyEvent[]            // native JSONL → normalized (one line can carry several)
  attach(binding: Binding): SpawnPlan           // real interactive UI
  prepare?(ctx: SessionContext): Promise<void>  // generated agent def / config / MCP
  drive?(ctx: TurnContext): AsyncIterable<KonvoyEvent>  // v2: persistent protocol
}
```

`drive` is declared in v1 and implemented in v2 (ACP for kiro/opencode, app-server for
codex, bidirectional stream-json for claude). It is the only way to steer or cancel a
running turn, which one-shot execution cannot do. Declaring it now keeps the v2 upgrade
from reshaping the interface.

### Normalized event union

```ts
type KonvoyEvent =
  | { t: 'session'; foreignId: string }
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  | { t: 'tool'; name: string; input?: unknown; status: 'start'|'ok'|'error' }
  | { t: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { t: 'error'; message: string; kind: 'auth'|'rate'|'crash'|'unknown' }
  | { t: 'done'; final: string }
```

One union makes roster, cost accounting, the ledger and the MCP return values uniform
across four unrelated wire formats.

## 8. Binding protocol

1. `konvoy new` writes the session row, the brief and the ledger. No CLI is launched.
2. First turn against an agent:
   - claude: konvoy derives a UUIDv5 from the session id and passes `--session-id`. Bound
     before the process starts.
   - codex / kiro / opencode: konvoy starts the turn, reads the id off the stream
     (`session_meta.payload.id` / `sessionId` / `sessionID`), writes the binding on the
     first event, and continues.
3. Where a native title exists, konvoy sets `konvoy:<slug>` (opencode at create, kiro via a
   `/title` prompt). Codex titles itself; konvoy records whatever it chose.
4. Later turns resume by id. If a resume fails (session deleted, store migrated, CLI
   upgraded), konvoy rebinds: it starts a fresh foreign session, records the break in the
   ledger with the old id, and continues. A lost binding never blocks the convoy.

## 9. Context sharing

konvoy writes two files per session and injects a **prelude** that tells each agent:
what the session is, who else is in it, where the ledger is, and how to use the konvoy
tools. Injection uses each CLI's native surface so it costs nothing per turn:

- **claude** — `--append-system-prompt` with the prelude, `--add-dir` for the session dir.
- **codex** — prelude prepended on the first turn only; the session carries it afterwards.
- **kiro** — a generated agent `~/.kiro/agents/konvoy-<slug>.json` with
  `prompt: "file:///…/CONTEXT.md"`, `includeMcpJson: false`, and konvoy's MCP server inline.
- **opencode** — a generated config passed via `OPENCODE_CONFIG`, with `instructions`
  pointing at the brief and `mcp.konvoy` declared.

Generated files live under `.konvoy/<slug>/gen/` and are rewritten on every config change.
User config files are never edited.

## 10. Delegation

konvoy runs an MCP stdio server, injected into every agent as `konvoy`:

| tool | behaviour |
|---|---|
| `konvoy_delegate(to, task, schema?)` | runs the target to completion, returns its final answer; `schema` requests a structured return (native on codex via `--output-schema`, prompt-enforced elsewhere). Blocking. |
| `konvoy_handoff(to, summary)` | records the handoff, ends the caller's turn, konvoy continues with the target. Non-blocking — the right tool for long work. |
| `konvoy_ask(to, question)` | one cheap read-only turn against the target. |
| `konvoy_broadcast(question)` | asks every other bound agent in parallel, returns all answers. |
| `konvoy_ledger_append(kind, text)` / `konvoy_ledger_read(since?)` | shared memory. |
| `konvoy_roster()` | who is bound, with model, effort and state. |

Each CLI's own subagents continue to work underneath, unchanged, giving the
agent → subagent → sub-subagent depth for free.

**Guards.** Max delegation depth (default 3). Cycle detection on the delegation graph.
Per-session budget (turns and wall clock) with a hard stop. Per-turn timeout with kill and a
recorded partial. `konvoy_ask` targets run under the read-only permission profile regardless
of session settings.

## 11. Normalization

**Effort.** konvoy exposes `low | medium | high | max`. Each adapter maps it to the native
flag and clamps to what the *target model* supports, because the vocabulary is
model-dependent on three of four CLIs. A clamp is never silent: it shows in `konvoy status`.

**Permission.** konvoy exposes `safe | edit | yolo`:

| | safe | edit | yolo |
|---|---|---|---|
| claude | `--permission-mode manual` | `acceptEdits` | `bypassPermissions` |
| codex | `-s read-only` | `-s workspace-write` | `--dangerously-bypass-approvals-and-sandbox` |
| kiro | `--trust-tools=` | `--trust-tools=fs_read,fs_write,…` | `--trust-all-tools` |
| opencode | default (ask) | agent `permission` rules | `--auto` |

**Model diversity.** Kiro and codex can both run models that Claude Code also runs
(`claude-opus-5`, `gpt-5.6-*`). A convoy whose reviewer and implementer share one model is a
second opinion in name only, so `konvoy status` prints the *effective* model per agent and
`konvoy doctor` warns on duplicates.

## 12. Configuration

Layered, most specific wins:

1. `~/.config/konvoy/config.jsonc` — global defaults
2. `<project>/.konvoy/config.jsonc` — project overrides, committed with the repo
3. session overrides in the database (`konvoy config set --session …`)
4. command-line flags

`konvoy config get <key>` prints the resolved value *and its source*, so layering never
becomes drift.

```jsonc
{
  "defaults": { "effort": "high", "permission": "edit" },
  "agents": {
    "claude":   { "enabled": true, "model": "opus",        "effort": "max" },
    "codex":    { "enabled": true, "model": "gpt-6-astra", "effort": "high",
                  "subagentEffort": "max" },
    "kiro":     { "enabled": true, "model": "claude-sonnet-5", "engine": "v3" },
    "opencode": { "enabled": true, "model": "anthropic/claude-sonnet-5" }
  },
  "roles": { "lead": "claude", "implementer": "codex",
             "reviewer": "kiro", "researcher": "opencode" },
  "policy": {
    "maxDelegationDepth": 3,
    "budget": { "turns": 50, "wallClockMin": 60 },
    "turnTimeoutSec": 900,
    "isolation": "serial"
  },
  "hooks": { "setup": null, "archive": null }
}
```

`agents.<id>.effort` overrides `defaults.effort`; anything unset inherits. `subagentEffort`
maps to codex's own `[agents] default_subagent_reasoning_effort`, which governs the layer of
subagents *below* codex — the only CLI that exposes that dial today.

Validation is all-or-nothing: an unknown or malformed key is rejected with its full path,
and a config that fails to validate is never half-applied.

## 13. Concurrency and isolation

Default: **serialized**. One writer at a time; other agents queue. Simple, and correct for
the common case.

`--parallel`: each agent gets a git worktree (`codex --worktree` natively, a konvoy-created
worktree elsewhere), works on its own branch, and konvoy merges at the end, reporting
conflicts rather than resolving them. Borrowed from amux, which solves exactly this.

`--tmux` (optional): turns run inside tmux sessions named `konvoy_<slug>_<agent>` so a
running agent can be attached to mid-turn, not only resumed after. Also borrowed from amux.

## 14. Storage

`bun:sqlite`, WAL, at `~/.local/share/konvoy/konvoy.db`.

```sql
session(id, slug, goal, cwd, lead, status, created_at, updated_at)
binding(session_id, agent, foreign_id, model, effort, permission, worktree,
        status, turns, cost_usd, credits, last_seen, PRIMARY KEY(session_id, agent))
turn(id, session_id, agent, parent_turn_id, prompt, final, tokens_in, tokens_out,
     cost_usd, started_at, ended_at, exit_code, error)
event(turn_id, seq, type, payload, ts)
delegation(id, session_id, from_agent, to_agent, depth, turn_id, status, ts)
```

The ledger stays a Markdown file, not a table: agents read it directly, and a human can too.

## 15. Failure handling

| failure | behaviour |
|---|---|
| CLI not installed | marked unavailable in roster; delegation to it returns a clear error; doctor prints the install command |
| not authenticated | auth errors detected from the stream; binding marked `auth_required`; konvoy prints that CLI's own login command and continues with the rest |
| version drift | capabilities are re-detected per version; a missing flag degrades that feature (e.g. no `--effort`) and is reported, never fatal |
| stale/invalid foreign session | rebind with a fresh session, note the break in the ledger, keep the old id in history |
| unsupported effort on a model | clamp down, report in status |
| MCP server fails to start | that agent runs without konvoy tools; delegation from it is disabled and the degradation is stated |
| agent hangs | per-turn timeout, kill, persist the partial transcript |
| informational error on a successful run | codex emits `item.completed` errors (e.g. a skills-budget notice) on turns that exit 0, so the exit code decides failure, not the presence of an error event |
| delegation loop | depth and cycle guards stop it and record why |
| concurrent writes | serialized by default; `--parallel` isolates via worktrees |

## 16. Stack

Bun + TypeScript (strict). `bun:sqlite`, `Bun.spawn` (with `stdio: "inherit"` for attach and
the built-in PTY option for `--tmux`), `Bun.file`/`Bun.write`, `Bun.$`, `bun:test`,
`bun build --compile` for a single binary. No `node:*` imports; small local helpers cover
what would otherwise pull them in.

One runtime dependency: **zod** — it validates layered config *and* generates the JSON
Schemas the MCP tool definitions require, so it earns its place twice.

## 17. Testing

- Adapter parsers: table-driven tests over captured real JSONL from each CLI. No network.
- Policy: depth, cycle, budget and timeout guards as pure unit tests.
- Store: migration and query tests on an in-memory database.
- Binding: a fake adapter that emits scripted events, asserting bind/rebind behaviour.
- One opt-in integration test per CLI (`KONVOY_E2E=1`) that spends real credits, skipped by
  default.

## 18. Measured per-turn overhead

One-shot execution pays each CLI's startup context on every turn, so that cost was measured
rather than assumed. Each run below is a single turn whose entire task was to reply `OK`.

| | context loaded | cost of one trivial turn |
|---|---|---|
| claude, user's full setup | 112 tools, 13 MCP servers, 9 hook events, **42,098 cache-write tokens** | **$0.0850** |
| claude, minimal harness | 29 tools, 0 MCP servers, 0 hooks, **5,456 tokens** | **$0.0130** |
| codex, `--ignore-user-config` | 18,173 input tokens (6,656 cached) | — |
| kiro, v2 engine | — | 0.0667 credits |

A 7.7× difference in context and 6.5× in cost, before any work is done. A ten-turn
delegation chain therefore costs roughly $0.85 in pure startup on the full setup versus
$0.13 on a minimal one — and that gap widens on larger models.

**Decision: `harness` is a first-class setting, defaulting to `minimal`.**

| | minimal | inherit |
|---|---|---|
| claude | `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --setting-sources ''` | no extra flags |
| codex | `--ignore-user-config` (auth still resolves through `CODEX_HOME`, verified) | omitted |
| kiro | generated agent JSON with `includeMcpJson: false` | user's `mcp.json` merged |
| opencode | generated config via `OPENCODE_CONFIG` | user's config discovery |

`minimal` is not a degraded mode: konvoy supplies the context explicitly through the brief
and its own MCP server, so what is stripped is duplication, not capability. `inherit` exists
for sessions that genuinely need the user's skills and hooks, at the measured price.

Note that `claude --bare` looks like the obvious lever and is not usable here: it accepts
only `ANTHROPIC_API_KEY` or an `apiKeyHelper` and never reads OAuth or the keychain, so a
subscription login cannot authenticate under it. The flag combination above achieves the same
reduction while leaving authentication alone.

## 19. Trust boundary between agents

konvoy's purpose is moving text between agents, which means one agent's output becomes
another agent's input. Any agent that reads a hostile file, page or repository can therefore
try to steer the whole convoy, and the ledger — shared, writable by all — is the widest path
for it.

- **Agent-produced text is data, never instruction.** Every delegated task and every ledger
  excerpt reaches an agent inside an envelope that names its author and states plainly that
  the contents are a proposal to evaluate, carrying no authority over that agent's own rules.
- **konvoy never raises privilege.** A delegated turn runs at the session's permission level
  or lower, never higher; `konvoy_ask` is pinned to `safe` regardless of session settings.
- **The prelude says so explicitly.** Each agent is told that ledger entries and delegated
  tasks are untrusted input, and that a request to change permissions, disable guards, or act
  outside the session goal must be refused and recorded rather than followed.
- **The guards bound the blast radius.** Delegation depth, cycle detection and the session
  budget limit what a confused or compromised agent can set in motion.
- **konvoy holds no credentials**, so it cannot be used as a path to them.

## 20. Session locking and delegation leases

"Serialised by default" has to be enforced, not assumed: two terminals running `konvoy send`
in one session would otherwise put two agents in the same working tree at once.

```sql
lock(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL)
```

A turn acquires the lock with a fresh owner token and exports it to the agent as
`KONVOY_LEASE`. This matters because of a deadlock that the obvious design walks straight
into: konvoy's MCP server runs *inside* the agent, so `claude → konvoy_delegate → codex`
means a nested turn asking for a lock its own parent already holds.

- The MCP server inherits `KONVOY_LEASE` from the agent process and presents it when starting
  a delegated turn. A lease matching the current holder is admitted without re-acquiring.
- Delegation extends the chain rather than nesting locks; depth is tracked separately.
- A lock whose `pid` is no longer alive is reclaimed, so a crashed turn never wedges a session.
- `--parallel` (spec section 13) replaces the lock with one worktree per agent rather than
  removing the invariant.

## 21. Roadmap

**v1** — sessions, bindings, ledger, headless turns, attach, delegation over MCP, roster,
status, doctor, config, update.
**v2** — `drive()` over each CLI's persistent protocol: live streaming, steer, cancel.
**v3** — parallel worktrees by default with conflict-aware merge; tmux-backed live attach.
