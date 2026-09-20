# konvoy

One session across Claude Code, Codex, Kiro CLI and opencode. konvoy binds a foreign
session per CLI, keeps them on one shared brief, and lets you move between them without
re-explaining anything.

## Install

```bash
bun install
bun run build          # produces ./dist/konvoy
```

## Use

```bash
konvoy new "refactor the auth layer"
konvoy send codex "start with the token refresh path"
konvoy ls
konvoy resume                  # make a session current again and show its roster
konvoy roster
konvoy usage --all --chart     # GATE reads as a dash until a `gate` command is configured
konvoy status
konvoy attach codex    # drops you into the real Codex TUI, same session
konvoy doctor
konvoy update --all    # konvoy itself, plus every agent CLI
konvoy rm stale-slug --yes
konvoy version
konvoy dashboard --port 4000  # local page with the same numbers as `usage --chart`
```

## Configure

Global `~/.config/konvoy/config.jsonc`, per project `.konvoy/config.jsonc`. The project
file wins. `konvoy config get` shows each agent's resolved settings and whether a value came
from that agent, from `defaults`, or from konvoy's own built-in.

```jsonc
{
  "defaults": { "effort": "high", "permission": "edit" },
  "agents": {
    "claude": { "model": "opus", "effort": "max" },
    "codex":  { "model": "gpt-6-astra" }
  },
  "roles": { "lead": "claude", "reviewer": "kiro" }
}
```

`effort` is one scale — `low | medium | high | max` — mapped onto each CLI's own dial and
clamped to what the target model actually supports.

If a CLI is not on your `PATH`, point konvoy at it directly and every command — `doctor`,
`status`, `send`, `attach`, `update` — uses that path:

```jsonc
{ "agents": { "opencode": { "bin": "~/.opencode/bin/opencode" } } }
```

`konvoy config set <key> <value> [--global]` rewrites the layer it touches as plain JSON, so
any comments in that file are lost — `--global` targets the global file instead of the
project one. Hand-edit the file instead when you want to keep them.

Name a `failover` chain and konvoy follows it when an agent can't work, instead of asking:

```jsonc
{ "failover": { "chain": ["codex", "claude", "kiro"], "upstreamRetries": 3 } }
```

A rate limit or an auth failure moves to the next agent in the chain at once. An upstream
error (a reachable-but-refusing API) retries the same agent with backoff up to
`upstreamRetries` times before moving on. A crash, a timeout, or an interrupted turn never
moves the chain — the fault is in the work, and the next agent would just fail the same way.
There is no failback: once konvoy moves, it stays moved. An empty chain (the default) turns
the feature off.

Set `style: "brief"` to have an agent lead with the action, number multi-step work, and skip
preamble and pleasantries — it shapes the answer you read, not what agents send each other:

```jsonc
{ "defaults": { "style": "brief" }, "agents": { "kiro": { "style": null } } }
```

Name a `gate` command — your test suite, a linter, whatever exits non-zero on bad work — and
konvoy runs it after each turn that produced something, recording a pass or fail against that
turn. A command that can't even be spawned records nothing, and a failed turn is never gated:

```jsonc
{ "gate": { "command": "bun test" } }
```

`gate` is privileged like `bin`, `permission` and `harness` — only the global config may set
it, since a gate runs on every turn with no per-turn opt-in, unlike an agent binary the user
chose to run. That also means one gate command serves every project; there's no per-project
override yet.

## Requirements

Bun 1.4+, and whichever of `claude`, `codex`, `kiro-cli`, `opencode` you want in the convoy.
Each authenticates itself; konvoy never handles credentials.
