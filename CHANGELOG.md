# Changelog

## Unreleased

### Fixed

- **The read-only fast pass could be beaten with a second command or a flag.**
  A lone `&` hid a destructive tail behind a safe head (`ls & rm -rf /tmp/x`),
  and several read-only names turned out to run code or write files:
  `fd -x/--exec`, `rg --pre`, `sort --compress-program`, `git diff/show/log
  --output`, `tree -o`, and `hg status --config`. All of these now fall through
  to Jev instead of skipping it, the read-only forms still fast-pass, and unit
  tests cover both sides.
- **Long-option abbreviations reopened the same holes.** `git tag --del`,
  `git grep --op=`, and `sort --out` matched no rule. Unambiguous long-option
  prefixes of the destructive flags are now escalated like the full spelling.

## 0.2.0 (2026-09-20)

### Fixed

- **`pi install specpi-jev-guard` did not work.** pi resolves a bare argument as
  a filesystem path and failed with `Error: Path does not exist`. That was the
  first command in the README and the copy button on the site. Both now print
  `pi install npm:specpi-jev-guard`.
- **`uncertain` was dead config.** It was documented, listed in
  `/jev-guard status`, and read by nothing: the no-UI path was hard-coded to
  fail closed, so `"uncertain": "allow"` did the opposite of what it said. It is
  honoured now.
- **The `rm -rf` hard deny matched any absolute path.** `rm -rf /tmp/nope` and
  `rm -rf /var/tmp/build-cache` were refused as filesystem-root wipes, and a
  hard deny cannot be overridden by `safeCommands` or `allowedCommands`. The
  rule now resolves the target first, so it covers `/`, `//`, `/tmp/../`,
  `/etc/..`, `~/..` and the rest of the ways to spell a root, while a named
  directory goes to the classifier like anything else.
- **An unknown subcommand printed the status block**, so `/jev-guard chekc ...`
  looked like it had answered. It now reports the typo and prints usage.
- **`git branch -f` and `git branch -C` fast-passed as read-only.** Both reset
  an existing branch to another commit and drop what was on it. `--force` was
  already caught; the short forms were not.

### Added

- The classifier key is read from pi's saved auth, so `/login openrouter` is
  enough and no `.env` file is needed.
- `npm run e2e`: packs the extension, installs that tarball into a throwaway pi
  home, and drives 48 scenarios through real sessions over pi's RPC protocol,
  with a live agent proposing the calls and the live classifier judging them.
- `npm run devious`, `npm run redteam` and `npm run compare`: a fixed
  adversarial set, a live adversary model, and a head-to-head against
  `@gotgenes/pi-permission-system`. None of them executes a command.
- Documentation site rebuilt as plain HTML with charts generated from the
  recorded runs, and a Testing page for the end-to-end suite.

## 0.1.0

First release.
