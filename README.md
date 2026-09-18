# specpi-jev-guard

A [Pi](https://pi.dev) extension that gates dangerous shell and file tool calls
with [Jev](https://openrouter.ai/~typesafe/jev-latest) — TypeSafe's fast,
decision-only classifier.

Rules settle the obvious cases locally in 0 ms. Everything else gets a Jev
danger probability in a few hundred milliseconds. High danger blocks, the
middle band asks you, low danger runs. No key, no network, or a garbled
verdict never silently waves a call through: the guard fails closed.

Two backends (default: OpenRouter):

| backend | how it reaches Jev | key |
|---|---|---|
| `openrouter` | OpenRouter decisions API (`POST /api/alpha/decisions`), model `~typesafe/jev-latest` | `OPENROUTER_API_KEY` |
| `typesafe` | TypeSafe API direct (`POST /v1/systemone`, native noul questions) | `TYPESAFE_API_KEY` |

> Status 2026-09-18: OpenRouter serves Jev as a decisions model via
> `POST /api/alpha/decisions` (same SystemOne state/questions shape as the
> TypeSafe direct backend). The old chat-completions path returns HTTP 400
> for these models, so this package now uses the decisions endpoint —
> verified live: safe commands score ~0.02-0.10, destructive or exfiltrating
> calls score ~0.93-0.95.

## Install

```bash
pi install git:github.com/TannerMidd/specpi-jev-guard
# or try it for one session:
pi -e git:github.com/TannerMidd/specpi-jev-guard
# or from a checkout:
pi -e ./extensions/jev-guard.ts
```

## Setup (2 minutes)

OpenRouter backend (default) — get a key at
[openrouter.ai/keys](https://openrouter.ai/keys):

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

TypeSafe-direct backend — get a key at
[console.typesafe.ai](https://console.typesafe.ai/settings/keys):

```bash
export TYPESAFE_API_KEY=...
```

...then point the guard at it once: `/jev-guard backend typesafe`.

Then run `/jev-guard setup` inside pi — it checks your key, offers a
backend switch, probes Jev live, and switches the guard on.

For development and live testing, copy the example env file instead —
`.env` is gitignored so keys never end up in history or chat:

```bash
cp .env.example .env   # then edit .env
npm run live                       # probe via OpenRouter
npm run live -- --backend typesafe # probe via TypeSafe direct
```

Without the active backend's key, unvouched calls are blocked with a message
telling you how to connect, switch backend, or disable the guard. Nothing is
ever allowed silently.

## How a call is decided

1. **Local rules first (no API call, Jev cannot overrule):**
   - hard-deny: `rm -rf /`-style root/home wipes, fork bombs, `mkfs`,
     raw disk writes, `chmod -R` on `/`, `curl … | sh`, drive wipes.
   - fast-pass: read-only commands and chains (`ls`, `git log/diff`,
     `cat`, …) pass with zero latency.
   - your lists: `disallowedCommands` block, `safeCommands` pass silently,
     `allowedCommands` pass with an audit entry.
2. **Jev via OpenRouter** (`~typesafe/jev-latest` by default, pinned
   `typesafe/jev-1.13` fallback) returns `danger` 0–1:
   - `danger ≥ blockThreshold` (default 0.8) → blocked.
   - `danger ≥ askThreshold` (default 0.35) → you're asked; without a UI
     it blocks instead (fail closed).
   - below → runs. Judged calls are logged to the session transcript.
3. **Writes/edits:** ordinary project files pass locally. Anything outside
   the workspace or matching `protectedPaths` (`.env*`, keys, `.ssh/`, …)
   goes to Jev.

Outbound payloads are bounded — command or path, working directory, your
latest prompt — and secrets (API keys, tokens, private-key blocks) are
redacted locally before anything leaves the machine. File contents are
never sent.

## Commands

```
/jev-guard                    status (backend, model, thresholds, key state, cache)
/jev-guard setup              guided first run: key check, backend, live self-test, on/off
/jev-guard on | off [--global]  enable/disable for this session (--global persists)
/jev-guard check <cmd>        classify one shell command, show danger + band
/jev-guard model <id>         switch classifier model for the active backend
/jev-guard backend <name>     switch backend: openrouter | typesafe
```

## Configuration

Global `~/.pi/agent/jev-guard.json`, optionally overridden per trusted
repository in `.pi/jev-guard.json`. Environment takes precedence for
connection settings (`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`,
`JEV_GUARD_BACKEND`, `JEV_GUARD_MODEL`, `JEV_GUARD_BASE_URL`,
`JEV_GUARD_TYPESAFE_MODEL`, `JEV_GUARD_TYPESAFE_BASE_URL`,
`JEV_GUARD_TIMEOUT_MS`).

```json
{
  "enabled": true,
  "backend": "openrouter",
  "model": "~typesafe/jev-latest",
  "typesafeModel": "jev-latest",
  "askThreshold": 0.35,
  "blockThreshold": 0.8,
  "uncertain": "ask",
  "safeCommands": ["uv run pytest*"],
  "allowedCommands": ["rm -rf build*"],
  "disallowedCommands": ["npm publish*"]
}
```

Tune thresholds with evidence, not intuition: run `/jev-guard check`
against commands you must stop and ones you must not, then place the
thresholds in the gap between the two groups.

## What it is not

- Not a sandbox. Approved commands run directly on your machine.
- It judges command text plus your latest prompt, not what a binary will
  actually do at runtime.
- Threshold defaults are starting points. Calibrate them (above) before
  trusting auto mode.

## Development

```bash
npm install
npm test        # offline rule-engine tests (no key needed)
npm run typecheck
npm run live    # needs .env with OPENROUTER_API_KEY
```

MIT.
