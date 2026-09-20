# Changelog

## Unreleased

### Changed

- **A judged call no longer marks the transcript at all.** Every gated call
  used to append a padded, coloured box, so the guard's routine traffic was the
  loudest thing on screen and the conversation it protects scrolled away under
  it. A gated session now reads like an ungated one: the record goes to the
  session file and to one line in the footer, and nowhere else.

  Set `"auditDisplay": "transcript"` to put a mark back under each judged call.
  It is a dim `jev 0.02` now rather than a box, a block is drawn in the error
  colour and names itself, a call you were asked about says who decided, and
  expanding it still gives the command, the category, the model and the
  latency.

### Added

- **A counter in pi's footer: `jev 12`, and `jev 12 · 1 blocked` once the guard
  has stopped something, and the latest verdict after that.** It is what makes
  a quiet transcript readable rather than uninformative: the records can move
  out of the way without the guard going silent. The count comes from the
  session's own records, so a resumed session keeps its total, and the line
  goes away while the guard is off.

- **`auditDisplay` decides where a record shows: `status`, `transcript`, or
  `off`.** `status` is the default described above. `off` drops the footer line
  too, for a session that should look untouched. Every mode still writes every
  record to the session file, so the audit trail does not move, and blocks stay
  loud in all three: they raise a notification and their reason goes back to
  the model.

  Set it in `~/.pi/jev-guard.json` or a trusted project file, or run
  `/jev-guard audit <status|transcript|off>` to save it. `/jev-guard status`
  reports the current mode.

  Thanks to @toorop for the report and the design (#5).

### Fixed

- **A settings file with a UTF-8 BOM is no longer ignored in full.** Notepad
  and PowerShell's `Set-Content` both write one, `JSON.parse` throws on it, and
  the read falls back to defaults without a word, so every setting in the file
  went missing at once. Found while screenshotting the new modes: the settings
  file written by PowerShell had no effect at all.

## 0.3.0 (2026-09-20)

### Changed

- **The read-only fast pass now names the flags that are reads, instead of the
  ones that are dangerous.** It used to allowlist a binary by name and then
  blocklist the flags of it that write a file, set machine state, or run a
  program. A blocklist has to be finished to be correct, and three rounds of
  hand-probing showed this one never would be: `rg --pre`, which pipes every
  file through a command of the caller's choosing, was closed in the first
  round, and `--hostname-bin`, which runs a command for the same reason in the
  same part of the same help text, was still open two rounds later. Now 24
  binaries with no such flag in any spelling pass on the name alone; `git`,
  `rg`, `fd` and `find` have their read-only flags named one at a time; and
  anything else escalates, including an option the list has never heard of. A
  tool that grows a new way to run a program in its next release can no longer
  reopen a hole.
- **Ten binaries came off the fast pass:** `svn`, `hg`, `sort`, `uniq`, `tree`,
  `file`, `date`, `hostname`, `less` and `more`. Each has at least one flag that
  writes, sets state, or execs, and none is common enough in an agent loop to be
  worth the surface. They are classified like any other command now, which costs
  one call per distinct command per session, not one per invocation: the verdict
  cache pays it once.

  Worth knowing before you upgrade: the guard fails closed, so with no reachable
  classifier those ten now stop instead of running. `tree src` and `svn status`
  used to survive a bad key or an outage on the strength of their name. They no
  longer do. Everyday `git`, `ls`, `cat`, `grep`, `rg`, `fd` and `find` work is
  unaffected, and `safeCommands` still passes anything you name yourself.

### Fixed

- **A lone `&` hid a destructive tail behind a safe head.** `ls & rm -rf /tmp/x`
  read as one read-only invocation whose only binary was `ls`. A single `&` is a
  chain separator now.
- **Long-option abbreviations reopened closed holes.** `git tag --del` and
  `git grep --op=` matched no rule, because git resolves any unambiguous prefix.
  Prefixes are resolved now, and only for the tools that accept them: `rg` takes
  its long options exactly, so `--pre` is never read as short for `--pretty`.
- **The home-directory hard deny only knew `~` and `$HOME`.** Literal
  `/home/me` and `/Users/me` were not hard-denied, and `/Users` and `/dev` were
  not treated as system directories. The same rules now recognise the literal
  spellings, so those wipes stop at the local layer instead of relying on Jev.

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
