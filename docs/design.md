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
| CLI present but not on konvoy's PATH | a spawned process inherits konvoy's environment, not the user's interactive shell, so a CLI reachable in their terminal can be invisible to konvoy — observed on this machine, where `~/.opencode/bin` is added by `.zshrc` and was absent from a long-running process's PATH. `agents.<id>.bin` names the binary explicitly, and `doctor` prints the resolved path for each agent rather than assuming a lookup succeeded |
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

## 21. Inter-agent message protocol

Every delegation and handoff is a message from one agent into another's context window,
paid for at that agent's per-turn floor (section 18 measured it at roughly 5,400 tokens
minimal). A 2,000-token handoff is therefore not a rounding error — it is a third of the
turn's budget before any work begins. The protocol below is shaped by that arithmetic and by
one principle.

### Pointers, not payloads

The filesystem and git are already a shared channel between the four agents, with perfect
fidelity and zero token cost until something is read. Anything the receiver can fetch itself
travels as a reference; only what it cannot reconstruct travels as text.

| the receiver needs | how it arrives |
|---|---|
| the goal and constraints | pushed once into the session brief, free on every later turn |
| what changed on disk | commit shas and a `git diff --stat`, computed by konvoy — never pasted content |
| where to look | `file:line` pointers |
| **why it was done that way** | **text — this is the payload** |
| **what the sender could not settle** | **text — the most valuable part of a handoff** |
| the sender's full transcript | never; it is tens of thousands of tokens of tool calls the receiver does not need |

### Who writes the summary

konvoy has no model of its own, so it cannot summarise. It does not need to: the sending
agent already holds the context and can produce a handoff for a hundred output tokens, where
konvoy would pay an entire extra model call for a worse result. The sender writes intent;
**konvoy supplies the machine facts itself** — changed files, commit range, turn cost — from
git and its own store, so those can be neither forgotten nor misreported.

### The envelope

An agent ends a turn that hands work on by emitting one delimited block. Sentinels rather
than raw JSON: models reliably wrap JSON in prose or fences, and a missing field should
degrade to empty rather than fail a parse.

```
<<<konvoy
to: reviewer
task: check the refresh path for a race between expiry and retry
open:
- token storage on Android is unverified
decisions:
- refresh on 401 rather than on a timer, because the device clock drifts
>>>
```

konvoy normalises that, plus its own git facts, into one record:

```ts
interface Handoff {
  from: AgentId
  to: AgentId | Role          // a role resolves through config.roles
  task: string                // imperative, <= 1500 chars
  pointers: string[]          // file:line, commit sha, or a note path
  decisions: string[]         // why, not what
  open: string[]              // what the sender could not settle
  changed: string             // konvoy-computed git diff --stat, not agent-reported
  commits: string[]           // konvoy-computed
  schema?: unknown            // requested reply shape
}
```

When the block is absent, konvoy falls back to the final message text plus its own git facts.
The protocol never fails a turn for want of formatting.

### Size discipline

- `task` at most 1500 characters; a sender needing more writes
  `.konvoy/<slug>/notes/<id>.md` and passes the path as a pointer.
- Each list at most 5 items, each at most 200 characters.
- A reply returned through `konvoy_delegate` is capped at 2000 characters, overflowing to a
  file the caller can read.

Worst case is roughly 600 tokens, about a tenth of the per-turn floor. Truncation is always
visible: konvoy appends the note path, never silently drops text.

### Push versus pull

The brief is **pushed** — small, stable, injected once through each CLI's native config.
The ledger is **pulled** — it grows without bound, so it is never injected; agents read it
through `konvoy_ledger_read(since?)`, which defaults to entries since that agent's last turn
rather than the whole file. Pushing the ledger would multiply its size by four agents and
again by every turn.

### Structured replies

Codex can enforce a reply shape natively through `--output-schema`, so a delegation carrying
a `schema` uses it there. The other three are asked for the same shape in the prompt and
validated on arrival; a reply that fails validation is returned to the sender as a failed
delegation with the validation error, not silently accepted.

### Addressing

An agent may address a **role** (`reviewer`) or an **agent** (`kiro`). Roles are preferred
and resolve through `config.roles`, because the sender wants a reviewer, not a particular
binary — and the roster can change between sessions.

### Trust and idempotency

Every inbound payload is wrapped in the two-line envelope from section 19 naming its author
and stating that it is a proposal, not authority — fixed and short, because it is paid on
every call. Each delegation carries a call id; a repeated id inside one turn returns the
first result instead of running the target twice, so a sender's retry after a timeout cannot
duplicate work.

## 22. Cumulative efficiency

The convoy only justifies itself if it beats the best single agent on quality **and** costs
less than the sum of its parts. That is not automatic. It holds under four conditions, and
where they fail a convoy is simply N times the price:

1. **Decomposability** — the task splits into parts where different agents have a
   comparative advantage. A monolithic task gains nothing from being shared.
2. **Verification asymmetry** — checking is cheaper than producing. Verification prompts are
   short and their answers are short, so a verifying turn typically costs a fraction of a
   producing one.
3. **Error independence** — the agents must fail *differently*. Two agents on the same base
   model go blind in the same places, so the second one adds cost and no information. This is
   why `konvoy doctor` warns on duplicate effective models: model diversity is the
   precondition for the whole thesis, not a nicety.
4. **Cheap arbitration** — deciding who is right must cost less than doing the work twice.

### The five mechanisms

**Cheap-first escalation.** Send the work to the cheapest capable agent, run the objective
gate, and escalate only on failure, carrying the failure with it. Expected cost is
`c_cheap + p_fail × c_expensive`, which beats going straight to the expensive agent whenever
`p_fail` is low. The failed cheap attempt is not waste — it is reconnaissance the expensive
agent starts from.

**Routing by measured comparative advantage, not by belief.** konvoy already records tokens,
cost and exit code per turn. What turns that into routing is an **objective success signal**,
and in a project with a test or typecheck gate that signal is free and beyond argument.
`konvoy stats` reports `kind × agent → success rate, median cost` from the user's own
history. Routing policy consumes that table, with a small exploration budget so early noise
does not lock in a bad choice permanently.

**Verification asymmetry, exploited explicitly.** The verifier is a *different model*, run at
low effort under the read-only permission profile, asked a narrow question — "does this diff
satisfy X, and if not, name a failing input". Narrow question, short answer, small cost.

**Parallel attempts only where the gate is objective.** For a high-variance task with a real
test, running two agents and keeping whichever passes costs `2c` for a success rate of
`1 - (1-q)²`. Worth it when `q` is middling and `c` is small; never the default.

**Never re-derive shared context.** Section 18 measured the per-turn floor; if agent B has to
re-read the codebase because A did not say where to look, the convoy is strictly worse than
one agent. The pointer discipline of section 21 is what makes the total sublinear rather than
multiplicative.

### Two hard rules

**Vary the suffix, never the prefix.** Prompt caching charges 1.25× to write a prefix and
0.1× to read it. A stable prefix — same system prompt, same tool list, same brief, for the
whole session — is therefore roughly a tenfold discount on the largest part of every turn.
Injecting anything that changes per turn (most temptingly, the ledger) into the prefix
destroys that. This is the real reason the ledger is pull-only; tidiness is the lesser half
of the argument.

**Handoffs are expensive, so avoid chatter.** Every handoff costs a full turn's startup, so
three clarifying round-trips cost three floors. One fat, complete delegation beats a
conversation. The prelude says so explicitly: an agent does not hand off a second time
without producing an artifact.

### What is measured

The `turn` table carries `kind`, `input_tokens`, `output_tokens`, `cost_usd`, `credits` and
`gate_passed` — the last recorded separately from `exit_code`, because an agent can exit 0
and still leave the tests red. Those columns exist from the first migration precisely so the
routing table can be built from real history rather than retrofitted.

### When the convoy loses

For a vague design question with no objective gate, for a task too small to decompose, or for
a roster whose agents share one base model, a single agent is cheaper and no worse. konvoy
should say so — `doctor` warns about the model overlap, and `stats` will show a kind where no
agent beats the lead — rather than pretending that more agents is always better.

## 23. Parley: opt-in deliberation between agents

A **parley** is a bounded, rule-governed exchange between agents that disagree. It is the
multi-model analogue of extended thinking: instead of buying more tokens inside one model,
you buy more turns across several. The comparison is exact enough to be the mental model.

| extended thinking | parley |
|---|---|
| more tokens, one model | more turns, several models |
| budget in tokens | budget in rounds and share of session spend |
| for hard problems | for contested decisions |
| off unless asked for | off unless asked for |

**Parley is disabled by default.** One round costs one turn startup per participant, so a
three-round parley between two agents costs six — more than letting the strongest agent
decide alone. Worse, its failure mode is invisible: two agents that already agree will take
turns confirming each other, producing a plausible transcript and no information. A failure
mode that looks like success must be opt-in.

Enabling costs nothing by itself. It makes a parley *available*; a parley still only opens
when something triggers it.

```
konvoy new "<goal>" --parley        enable for a new session
konvoy config set parley.enabled true
konvoy parley status                whether it is on, and what it has cost so far
konvoy parley log                   past parleys with their verdicts and price
```

### What konvoy says when you enable it

The warnings are numeric, drawn from the user's own measured turn costs (section 18), not
generic caution:

1. **The price.** "Each round is one turn per participant. At this roster and effort that is
   about $X and ~Y tokens per round, capped at 2 rounds and 15% of the remaining session
   budget."
2. **The precondition.** If two participants resolve to the same effective model — the
   overlap `konvoy doctor` already detects — konvoy says so: a parley between one brain
   wearing two harnesses is theatre. Error independence is the precondition for the whole
   mechanism.
3. **The cheaper answer first.** If the project has an objective gate, konvoy says so and
   suggests `rule: gate`. Most disagreements about code are empirically decidable, and a test
   settles them for a fraction of an argument.

### When a parley opens

Only on a **conflict**: a reviewer's finding the producer disputes, two conflicting verdicts
from a `broadcast`, an objective gate that failed twice with different diagnoses, or an
explicit `konvoy_parley` call. An information gap is not a conflict — that is `ask`, one
read-only round. The fat-handoff discipline of section 21 removes most information gaps
before they can become exchanges.

`konvoy_parley(question, with, rule?, rounds?)` fixes three things before anyone speaks:

- **one question**, which cannot change;
- **a decision rule**, declared up front;
- **a round cap**, default 2, maximum 3.

Declaring the tiebreak in advance is what keeps parleys short: participants who know how it
ends stop performing. A parley without a pre-declared rule is an infinite-loop generator.

| rule | resolution |
|---|---|
| `gate` | run the objective gate on both proposals; the one that passes wins — preferred wherever a gate exists, because it is cheap and not a matter of opinion |
| `lead` | the session lead decides (default) |
| `cost` | the cheaper proposal wins |
| `human` | parked for the user |

### The governors

konvoy has no model of its own, so every control below is computable without one.

1. **Structural slot.** Every round must declare `agree | disagree | need-info` about the
   fixed question. A round that does not address it **does not count as a round**, and the
   agent is told so. Drift becomes structurally visible rather than a matter of judgement.
2. **New-pointer rule.** A productive round cites something — a file, a line, a test result,
   a command output. Zero new pointers and no new claim is noise, and `pointers[]` from
   section 21 already carries the evidence.
3. **Novelty check.** High lexical overlap with the previous round ("agreed, that makes
   sense") raises a warning and lowers the cap by one. Deliberately **not** a hard stop: the
   heuristic is crude, and a real objection phrased in similar words must not be silently
   killed.
4. **Budget share.** A parley consuming more than 15% of the session's remaining budget closes
   on its decision rule. This is the absolute backstop.

Depth is one: a parley cannot open inside a parley. One at a time per session, which the
session lock enforces anyway.

### The output is a record, not a transcript

```ts
interface Parley {
  question: string
  positions: { agent: AgentId; stance: string }[]
  verdict: string
  rationale: string
  decidedBy: 'agreement' | 'gate' | 'lead' | 'cost' | 'human'
  rounds: number
  costUsd: number
}
```

One ledger entry. The exchange itself stays in the database and never re-enters any agent's
context — a transcript that leaked forward would make every later turn pay for the argument.
`konvoy parley log` reads these back, so the feature can be judged the way everything else
here is judged: by whether its recorded verdicts were worth what they cost.

A parley round is an ordinary turn with one extra structural slot. No new transport, no
per-CLI work, nothing that can behave differently across the four harnesses.

## 24. Work allocation without negotiation

Letting agents negotiate who does what costs turns and risks both duplication and gaps. konvoy
combines three sources of knowledge instead, with zero negotiation rounds:

1. **The lead decomposes once.** It already holds the context, so one turn produces the
   subtask list with a suggested owner for each.
2. **The routing table corrects the owners.** The lead is guessing; `konvoy stats` is
   measuring. Where the two disagree, measured history wins, with the override recorded.
3. **A claim table gives each subtask exactly one owner**, and overlapping edits are
   prevented by the session lock — or, under `--parallel`, by per-agent worktrees.

One planning turn, no bargaining, and the lead's guesses corrected by the user's own data.

## 25. Formations

`parley` (section 23) is a tool an agent calls mid-turn: reactive, triggered by a conflict.
That is the right shape for "the reviewer disputes my finding". It is the wrong shape for
"design this refactor together", where deliberation is the point of the whole session rather
than an interruption to it — expressing that with repeated tool calls would be chatty and
expensive.

The missing layer is the **formation**: the shape a session travels in. A convoy has one.

| formation | behaviour |
|---|---|
| `solo` | one lead agent, the others reachable by delegation — today's behaviour, and the default |
| `parley` | every significant decision goes to several agents before it is acted on |
| `relay` | a pipeline: plan, implement, review, fix — a fixed chain with no negotiation |
| `race` | parallel attempts, with the objective gate picking the winner |

**`loop` is not a fifth formation; it is a combinator over them.** `loop(relay)` means "plan,
implement, review, fix, repeat until the gate is green or the budget is spent" — which is
exactly the process this project itself was built with.

A formation is a small state machine over primitives that already exist: the turn runner, the
delegation tools, the objective gate. It introduces no new transport and requires no adapter
changes. It sits above the session layer and consumes the same turns.

### The constraint this places on Plan B

Formations are deliberately **not** built in Plan A or Plan B — they rest on the gate and on
delegation, and building them before those exist would be building on air. But they impose one
requirement on Plan B, which is the reason this section is written now rather than later:

> The decision of *what happens next* must be a function on konvoy's side, not an instruction
> baked into the lead agent's prompt.

Telling the lead to "plan, then implement, then ask the reviewer" is the shortest path to
working software and it forecloses formations entirely: the flow then lives inside a model's
context, where konvoy cannot inspect it, vary it, or swap it. Keeping the next-step decision
in konvoy costs little now and is expensive to retrofit.

### Where skills fit

A skill like brainstorming shapes the work *inside* one agent's harness. A formation shapes
the work *between* agents. They are different axes and do not compete: an agent in a konvoy
session runs its own skills exactly as it would alone, and konvoy governs only the traffic
between agents. konvoy does not reimplement, override, or interfere with what a CLI's own
skills do.

## 26. Roadmap

**v1** — sessions, bindings, ledger, headless turns, attach, delegation over MCP, roster,
status, doctor, config, update.
**v2** — `drive()` over each CLI's persistent protocol: live streaming, steer, cancel.
**v3** — parallel worktrees by default with conflict-aware merge; tmux-backed live attach.
