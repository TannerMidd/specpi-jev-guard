<div align="center">

<img src="https://raw.githubusercontent.com/TannerMidd/specpi-jev-guard/main/docs/assets/logo.png" width="76" alt="">

# specpi-jev-guard

**Checks risky shell and file commands before your agent runs them.**

[![npm](https://img.shields.io/npm/v/specpi-jev-guard?color=2a78d6)](https://www.npmjs.com/package/specpi-jev-guard)
[![CI](https://github.com/TannerMidd/specpi-jev-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/TannerMidd/specpi-jev-guard/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-0ca30c)](LICENSE)

[Overview](https://tannermidd.github.io/specpi-jev-guard/) ·
[Devious tests](https://tannermidd.github.io/specpi-jev-guard/devious.html) ·
[Testing](https://tannermidd.github.io/specpi-jev-guard/testing.html) ·
[npm](https://www.npmjs.com/package/specpi-jev-guard)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TannerMidd/specpi-jev-guard/main/docs/assets/terminal-dark.png">
  <img src="https://raw.githubusercontent.com/TannerMidd/specpi-jev-guard/main/docs/assets/terminal.png" width="860" alt="Three commands: rm -rf / is blocked by a local rule, rm -rf dist build scores 0.55 and asks first, npm test runs with no prompt.">
</picture>

</div>

A [Pi](https://pi.dev) extension. Local rules settle the obvious cases in 0 ms.
Anything left goes to [Jev](https://openrouter.ai/~typesafe/jev-latest), a
classifier that answers one question: how dangerous is this? High scores block,
the middle band asks you, low scores run. With no key, no network, or an answer
it cannot parse, the call does not go through.

## Install

```bash
pi install npm:specpi-jev-guard
```

Then, inside pi:

```
/login openrouter     # if you have not already
/jev-guard setup      # finds the key, probes Jev live, switches the guard on
```

That is the whole setup. A mid-session `/login` or `/logout` takes effect
straight away. To use an environment variable instead, export
`OPENROUTER_API_KEY` before launching pi.

## How it decides

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TannerMidd/specpi-jev-guard/main/docs/assets/hero-dark.png">
  <img src="https://raw.githubusercontent.com/TannerMidd/specpi-jev-guard/main/docs/assets/hero.png" width="760" alt="Four local checks run first: your deny list, hard-deny patterns, a read-only fast pass, then Jev scores what is left.">
</picture>

Four cheap checks run first and settle most calls with no network. Only what is
genuinely uncertain costs a classifier call.

## Evidence

Every number on the site comes from a recorded live run, and every run can be
repeated from a clean checkout.

| Run | What it measures | Result |
| --- | --- | --- |
| [Overview](https://tannermidd.github.io/specpi-jev-guard/) | 124 commands scored live | 386 ms average, 37 settled locally with no network call |
| [Devious tests](https://tannermidd.github.io/specpi-jev-guard/devious.html) | 108 hostile commands, 25 ordinary ones | 6 allowed through, no ordinary command refused |
| [Red team](https://tannermidd.github.io/specpi-jev-guard/devious.html) | 30 attacks invented live by another model | 0 got through |
| [Testing](https://tannermidd.github.io/specpi-jev-guard/testing.html) | the packed release, inside a real pi | 48 scenarios, 47 exercised and all as specified |

### Against the most installed permission system

`npm run compare` replays the whole devious suite through the gates of
[@gotgenes/pi-permission-system](https://pi.dev/packages/@gotgenes/pi-permission-system),
under three policies including the one in its README. Nothing is executed on
either side.

| Guard | Hostile commands that would run (of 108) | Ordinary commands interrupted (of 25) |
| --- | --- | --- |
| pi-permission-system, quick start | 0 | 25 |
| pi-permission-system, hardened policy | 4 | 24 |
| pi-permission-system, allow by default | 50 | 8 |
| specpi-jev-guard | 6 | 13 |

Matching text cannot tell a `node_modules` wipe from a root wipe, so a policy
strict enough to stop the second interrupts the first. Scoring intent can tell
them apart. All three policies and every verdict are in
[`tests/compare-results.json`](tests/compare-results.json); the reasoning is on
the [Overview page](https://tannermidd.github.io/specpi-jev-guard/#compare).

That extension does things this one does not: it gates tools, MCP servers,
skills and file paths, resolves symlinks, and needs no key and no network. It
also exposes an `authorizerChain` seam for exactly this kind of second opinion.
Registering this extension there is the obvious next step and is not built yet.

## Commands

```
/jev-guard                      status: backend, model, thresholds, key, cache
/jev-guard setup                guided first run
/jev-guard on | off [--global]  toggle for this session, or save it
/jev-guard check <cmd>          score one command without running it
/jev-guard model <id>           switch classifier model
/jev-guard backend <name>       openrouter | typesafe
/jev-guard audit <where>        transcript | status | off
```

## Configuration

`~/.pi/jev-guard.json`, or `.pi/jev-guard.json` in a repository you have
trusted. Environment variables win over both.

```json
{
  "askThreshold": 0.35,
  "blockThreshold": 0.8,
  "uncertain": "ask",
  "auditDisplay": "transcript",
  "safeCommands": ["uv run pytest*"],
  "allowedCommands": ["rm -rf build*"],
  "disallowedCommands": ["npm publish*"]
}
```

Set thresholds from evidence rather than instinct: run `/jev-guard check`
against commands you must stop and commands you must not, then put the
thresholds in the gap between the two groups.

### Where audit records show up

A judged call leaves a record. By default it shows in the transcript as one
dim line under the call it judged, `jev 0.02`, and nothing more: a gated
session should read like an ungated one apart from that mark. Expand it
(ctrl+o) for the command, the category and the model. `auditDisplay` moves it
from there without losing it:

| `auditDisplay` | what you see |
| --- | --- |
| `transcript` (default) | one dim line under each judged call |
| `status` | one line in the footer, showing the latest verdict only |
| `off` | nothing |

A block is drawn in the error colour and names itself (`jev 0.91 blocked`), and
a call you were asked about says who decided (`jev 0.44 allowed by you`).

Every mode writes every record to the session file, so the audit trail is the
same in all three. Blocks stay loud everywhere too: they raise a notification
and the reason goes back to the model whatever this is set to. Switch with
`/jev-guard audit status`, which saves the choice.

<details>
<summary>Full reference: decision order, backends, every setting</summary>

### How a call is decided

1. **Local rules, no network call. Jev cannot overrule these.**
   - Hard deny: root and home wipes, fork bombs, `mkfs`, raw disk writes,
     `chmod -R` on `/`, `curl ... | sh`, drive wipes.
   - Fast pass: 24 binaries whose whole option surface is a read (`ls`, `cat`,
     `grep`, `stat`, `du`, `ps`), plus `git`, `rg`, `fd` and `find`, whose
     read-only flags are named one at a time. Everything else escalates,
     including a flag nobody has heard of: an option that is not on the list is
     a reason to ask Jev, not to wave the call through. So `git log --oneline`
     and `rg -n TODO src` run for free while `find -delete`, `git branch -D`,
     `git diff --output=...`, `fd -x`, `rg --pre` and a background `&` go to
     the classifier. Long-option abbreviations (`git tag --del`) are resolved
     for the tools that accept them, and only those.
   - Your lists: `disallowedCommands` block, `safeCommands` pass silently,
     `allowedCommands` pass and leave an audit entry.
2. **Jev scores what is left**, 0 to 1.
   - At or above `blockThreshold` (0.8): blocked.
   - At or above `askThreshold` (0.35): you are asked. With nobody to ask, in a
     script or a CI job or a headless agent, `uncertain` decides. The default
     `ask`, and `deny`, both block. Only `"allow"` lets the middle band through
     unattended.
   - Below: runs. Every judged call is recorded; `auditDisplay` decides
     whether the record shows in the transcript, in the footer, or nowhere.
3. **Writes and edits:** ordinary project files pass locally. Paths outside the
   workspace, and paths matching `protectedPaths` (`.env*`, keys, `.ssh/`), go
   to Jev.

What leaves your machine is bounded: the command or path, the working
directory, and your latest prompt. Secrets are redacted locally first. File
contents are never sent.

### Backends

| backend | endpoint | key |
| --- | --- | --- |
| `openrouter` (default) | OpenRouter decisions API, model `~typesafe/jev-latest` | `OPENROUTER_API_KEY` |
| `typesafe` | TypeSafe API direct, `POST /v1/systemone` | `TYPESAFE_API_KEY` |

Switch with `/jev-guard backend typesafe`. Keys come from pi's saved login
first, then the environment.

### Every setting

`enabled`, `backend`, `model`, `fallbackModel`, `baseUrl`, `typesafeModel`,
`typesafeBaseUrl`, `timeoutMs`, `askThreshold`, `blockThreshold`, `uncertain`,
`auditDisplay`, `safeCommands`, `allowedCommands`, `disallowedCommands`,
`protectedPaths`.

Connection settings can also come from the environment:
`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `JEV_GUARD_BACKEND`,
`JEV_GUARD_MODEL`, `JEV_GUARD_BASE_URL`, `JEV_GUARD_TYPESAFE_MODEL`,
`JEV_GUARD_TYPESAFE_BASE_URL`, `JEV_GUARD_TIMEOUT_MS`.

### Other ways to install

```bash
pi install git:github.com/TannerMidd/specpi-jev-guard
pi -e ./extensions/jev-guard.ts   # one session, from a checkout
```

</details>

## What it is not

- Not a sandbox. Approved commands run directly on your machine.
- It reads command text and your latest prompt. It does not know what a binary
  will do at runtime.
- The thresholds shipped are starting points. Calibrate them before leaving it
  on auto.
- Not a permission system. It gates four tools: `bash`, `powershell`, `write`
  and `edit`. Reading a file is not gated, and neither is a command you type
  yourself.

## Development

```bash
npm install
npm test               # rule engine, offline, no key
npm run typecheck

npm run matrix         # 124 commands, live       -> tests/jev-results.json
npm run devious        # 108 hostile, 25 ordinary -> tests/jev-devious.json
npm run redteam        # another model attacks it -> tests/redteam-results.json
npm run compare        # head to head, offline    -> tests/compare-results.json
npm run e2e            # the packed release in a sandboxed pi, about 10 minutes

npm run insights && npm run devious:charts && npm run e2e:charts
npm run docs:sync      # inline the charts and tables into docs/
```

The live suites need an OpenRouter key: either `/login openrouter` in pi, or
`OPENROUTER_API_KEY` in the environment or a `.env` file. `npm run chart:png`
and `npm run readme:figures` shell out to ImageMagick (`magick`); nothing else
does, and the site is built from the SVGs either way.

<details>
<summary>How the end-to-end suite works, and how the site is built</summary>

### End-to-end tests in a real pi

`npm run e2e` runs `npm pack`, installs that tarball into a throwaway pi home
with its own settings and session store, and drives real sessions over pi's RPC
protocol. A real agent proposes the tool calls, the real classifier judges them,
and the assertions read the audit entries the extension writes.

RPC mode is what makes it possible. `ctx.hasUI` is true there, so `/jev-guard`
commands run as commands and the confirmation dialog arrives as an event the
harness can answer, which is how the same command is tested once answered yes
and once answered no.

Every hostile command in the suite is inert on the machine running it. The
block devices do not exist, the network targets refuse instantly, and the only
files in reach belong to a fixture project rebuilt between batches. A guard
failure shows up as a failed scenario, never as damage.

Results land in `tests/pi-e2e-results.json` and on the
[Testing page](https://tannermidd.github.io/specpi-jev-guard/testing.html).

### The site in docs/

Plain HTML: three hand-written pages, one stylesheet, one script, no build step
and no Jekyll. Charts are generated SVGs written against CSS variables, inlined
into the pages by `npm run docs:sync` between `<!--chart:name-->` markers, with
generated tables between `<!--include:name-->` markers. Inlining is what lets
one file follow the light and dark themes and keep its hover tooltips.

### Publishing

Releases go to npm from [publish.yml](.github/workflows/publish.yml) on every
published GitHub Release, using npm Trusted Publishing. Tag `vX.Y.Z` to match
`package.json`, publish the release, and CI tests, typechecks and publishes.

</details>

MIT
