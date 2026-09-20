/**
 * risk-rules.ts — pure, dependency-free risk logic for specpi-jev-guard.
 *
 * Everything in this file is deterministic and has no imports, so it can be
 * unit-tested with plain `node --test` (Node 22+ strips types automatically).
 * The pi extension wiring lives in jev-guard.ts.
 */

/** What to do with a tool call whose risk is in the middle band. */
export type UncertainPolicy = "allow" | "ask" | "deny";

/** Which API the classifier is reached through. */
export type Backend = "openrouter" | "typesafe";

/**
 * Where each audit record is shown.
 *
 * The default is `status`: the footer keeps the count and the latest verdict,
 * and the transcript is left alone. A line per judged call is a line per
 * judged call, and in a working session that is most of the screen. `off`
 * drops the footer line too; `transcript` puts a line back under each call for
 * anyone who wants to watch the guard work.
 */
export type AuditDisplay = "transcript" | "status" | "off";

export interface GuardSettings {
  enabled: boolean;
  /** Classifier backend: OpenRouter decisions API or TypeSafe direct API. */
  backend: Backend;
  /** OpenRouter model id for the classifier. Default keeps pace with releases. */
  model: string;
  /** Pinned fallback if the alias ever fails to resolve. */
  fallbackModel: string;
  /** OpenRouter-compatible base URL (no trailing slash). */
  baseUrl: string;
  /** TypeSafe model id for the direct backend. */
  typesafeModel: string;
  /** TypeSafe API base URL (no trailing slash). */
  typesafeBaseUrl: string;
  /** Per-classification network timeout in ms. */
  timeoutMs: number;
  /** danger >= blockThreshold  -> block unconditionally. */
  blockThreshold: number;
  /** danger >= askThreshold    -> ask the user (or block without UI). */
  askThreshold: number;
  /** Behavior for the middle band when there is no UI to ask. */
  uncertain: UncertainPolicy;
  /** Where audit records are shown. Every mode still writes them to the session file. */
  auditDisplay: AuditDisplay;
  /** Glob list (matched against the raw command) that passes with no API call and no audit. */
  safeCommands: string[];
  /** Glob list that passes but records an audit entry. */
  allowedCommands: string[];
  /** Glob list that blocks immediately, before Jev is consulted. */
  disallowedCommands: string[];
  /** Glob list (matched against the path relative to cwd) that forces Jev review for writes/edits. */
  protectedPaths: string[];
}

export const DEFAULT_SETTINGS: GuardSettings = {
  enabled: true,
  backend: "openrouter",
  model: "~typesafe/jev-latest",
  fallbackModel: "typesafe/jev-1.13",
  baseUrl: "https://openrouter.ai/api/v1",
  typesafeModel: "jev-latest",
  typesafeBaseUrl: "https://api.typesafe.ai/v1",
  timeoutMs: 12000,
  askThreshold: 0.35,
  blockThreshold: 0.8,
  uncertain: "ask",
  auditDisplay: "status",
  safeCommands: [],
  allowedCommands: [],
  disallowedCommands: [],
  protectedPaths: [
    "**/.env*",
    "**/*.pem",
    "**/*.key",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/.ssh/**",
    "**/.git/**",
    "**/node_modules/**",
  ],
};

/**
 * Binaries whose whole option surface is a read: nothing any flag of theirs
 * can do writes a file, changes machine state, or starts another program.
 * The name on its own is enough to fast-pass them.
 *
 * Membership here is a claim about the tool, not about the call, so it is a
 * short list on purpose. Anything that has even one flag which writes or
 * execs belongs in READ_ONLY_FLAGS below, where the flags get checked.
 */
const ALWAYS_READ_ONLY = new Set([
  "ls",
  "dir",
  "lsd",
  "cat",
  "type",
  "head",
  "tail",
  "wc",
  "cut",
  "tr",
  "grep",
  "echo",
  "printf",
  "pwd",
  "cd",
  "whoami",
  "uname",
  "stat",
  "df",
  "du",
  "free",
  "ps",
  "which",
  "where",
]);

/** Shell operators that make a command line non-trivial. A single `&`
 *  backgrounds what comes before it and runs what comes after, so it belongs
 *  here with the rest: without it `ls & rm -rf /tmp/x` reads as one read-only
 *  invocation whose only binary is `ls`. */
const OPERATOR_RE = /(&&|\|\||[;|&<>]|`|\$\(|\$\{)/;

/**
 * Top-level directories that belong to the system rather than to whoever is
 * running the command. Children are deliberately not included: /var/tmp/cache
 * is somebody's build output, /var is the machine.
 */
const SYSTEM_DIRS = new Set([
  "usr", "etc", "bin", "sbin", "lib", "lib64", "boot", "var", "opt", "srv", "home", "root",
  "users", "dev", "system", "system32", "windows",
]);

/** Top-level directories whose children are the accounts' home directories. */
const HOME_CONTAINERS = new Set(["home", "users"]);

/** A home directory sits this far down in every layout: /home/me, /Users/me, C:/Users/me. */
const HOME_DEPTH = 2;

/**
 * What a deletion target actually names, once the path is resolved.
 *
 * `/`, `//`, `/./`, `/tmp/../` and `/etc/..` are the filesystem root written
 * five ways, and a rule that only knows the short spelling is a rule with a
 * bypass. So the components are walked rather than matched, and every spelling
 * of the same directory lands on the same answer.
 *
 * `~` and `$HOME` seed the walk at HOME_DEPTH. Climbing out of a home
 * directory therefore reaches the directory that holds every account, and then
 * the root, both of which are answers in their own right.
 */
export function normalizeDeleteTarget(raw: string): "root" | "home" | "system" | "other" {
  // Drop the quoting a nested command leaves on the token, then keep only the
  // path-shaped head of it: awk's `system("rm -rf ~")` hands over `~")}'`, and
  // the target in there is `~`.
  const head = /^["'`]*(\$\{HOME\}|\$HOME|~|\/)([\w.\-/*]*)(.*)$/s.exec(raw);
  if (!head) return "other"; // relative, or some other machine's path: not this rule's business
  // Whatever is left has to be quoting, or the path went somewhere this cannot
  // read and the safe answer is that it is not a root. A homoglyph or an
  // override character below is a deeper path, and Jev judges those.
  if (!/^["'`;,)}\]]*$/.test(head[3])) return "other";
  const base: "root" | "home" = head[1] === "/" ? "root" : "home";
  const rest = head[2];

  // `~user` is that account's home, not a directory named `user` inside this
  // one; only `~/user` walks deeper. Shells expand it the same way.
  if (head[1] === "~" && /^[A-Za-z_][\w.-]*$/.test(rest)) return "home";

  const HOME = "\u0000home\u0000"; // a placeholder no path component can spell
  const parts: string[] = base === "home" ? new Array(HOME_DEPTH).fill(HOME) : [];
  for (const part of rest.split("/")) {
    // Empty (a doubled slash) and `.` change nothing; a trailing `*` means the
    // contents of the directory, which for this rule is the directory.
    if (part === "" || part === "." || part === "*") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop(); // the root's own parent is the root
      continue;
    }
    parts.push(part);
  }

  if (parts.length === 0) return "root";
  if (parts.length === HOME_DEPTH && parts.every((p) => p === HOME)) return "home";
  // The literal spelling of the same thing: /home/me and /Users/me.
  if (parts.length === HOME_DEPTH && HOME_CONTAINERS.has(parts[0].toLowerCase())) return "home";
  // Climbed part-way out of home: /home, /Users, whatever holds the accounts.
  if (parts.length < HOME_DEPTH && parts[0] === HOME) return "system";
  if (parts.length === 1 && SYSTEM_DIRS.has(parts[0].toLowerCase())) return "system";
  return "other";
}

/**
 * Every target of a recursive forced `rm` on the command line, including ones
 * nested inside quotes such as `php -r "system('rm -rf ~');"`. Flags may come
 * in any order, combined or split.
 */
function recursiveDeleteTargets(cmd: string): string[] {
  const out: string[] = [];
  const rm = /\brm\b/g;
  let hit: RegExpExecArray | null;
  while ((hit = rm.exec(cmd)) !== null) {
    const rest = cmd.slice(hit.index + hit[0].length).split(/[|;&\n]/)[0];
    if (!/(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*\b|--recursive\b/.test(rest)) continue;
    if (!/(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*\b|--force\b/.test(rest)) continue;
    for (const token of rest.split(/\s+/)) {
      if (token === "" || token.startsWith("-")) continue;
      out.push(token);
    }
  }
  return out;
}

/** Hard-deny: recursive/forced deletion aimed at filesystem roots. */
const HARD_DENY_PATTERNS: Array<({ re: RegExp } | { hits: (cmd: string) => boolean }) & { reason: string }> = [
  {
    hits: (cmd) => recursiveDeleteTargets(cmd).some((t) => normalizeDeleteTarget(t) === "root"),
    reason: "recursive forced deletion of the filesystem root",
  },
  {
    hits: (cmd) => recursiveDeleteTargets(cmd).some((t) => normalizeDeleteTarget(t) === "home"),
    reason: "recursive forced deletion of a home directory",
  },
  {
    // `rm -rf /tmp/build` names a directory, not a root, and belongs in front of
    // Jev rather than in a rule that nothing can override.
    hits: (cmd) => recursiveDeleteTargets(cmd).some((t) => normalizeDeleteTarget(t) === "system"),
    reason: "recursive forced deletion of a system directory",
  },
  {
    re: /\brm\b[^|;&\n]*--no-preserve-root/,
    reason: "recursive deletion with --no-preserve-root",
  },
  {
    // classic fork bomb
    re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    reason: "fork bomb",
  },
  {
    re: /\bmkfs(\.\w+)?\b/,
    reason: "filesystem formatting (mkfs)",
  },
  {
    re: /\bdd\b[^|;&\n]*\bof=\/dev\/(sd|hd|nvme|vd|xvd|mmcblk)/,
    reason: "raw block-device write with dd",
  },
  {
    re: />\s*\/dev\/(sd|hd|nvme|vd|xvd|mmcblk)/,
    reason: "shell redirection onto a block device",
  },
  {
    // chmod/chown -R ... /  (recursive ownership/mode change on root)
    re: /\b(chmod|chown)\b[^|;&\n]*-[a-zA-Z]*R[^|;&\n]*(\s\/(\s|$|\*)|\s\/\*)/,
    reason: "recursive permission/ownership change on the filesystem root",
  },
  {
    // curl|wget ... | (sudo) sh|bash  — fetched code execution
    re: /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(bash|sh)(\s|$)/,
    reason: "piping fetched remote content straight into a shell",
  },
  {
    // Windows: wipe a drive root
    re: /\brd\s+\/s(\s+\/q)?\s+[A-Z]:\\?\s*$/i,
    reason: "recursive deletion of a drive root (rd /s)",
  },
  {
    re: /\bFormat-Volume\b[^|;&\n]*-DriveLetter/i,
    reason: "disk formatting (Format-Volume)",
  },
];

export type LocalVerdict =
  | { decision: "deny"; reason: string; audited: true }
  | { decision: "pass"; reason: string; audited: boolean }
  | { decision: "unknown"; reason: string };

/** Convert a small glob (`*`, `**`, `?`) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  // A leading **/ also matches bare filenames with no directory part.
  if (glob.startsWith("**/")) {
    out += "(.*/)?";
    i = 3;
  }
  for (; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // Collapse runs of * into .* (covers ** and **/ too, good enough here).
        while (glob[i + 1] === "*") i++;
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(c);
    }
  }
  return new RegExp(out + "$");
}

function escapeRegExp(c: string): string {
  return c.replace(/[.+^${}()|[\]\\]/, "\\$&");
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    try {
      return globToRegExp(p).test(value);
    } catch {
      return false;
    }
  });
}

/** First whitespace-separated token, lowercased, without quotes. */
function binaryOf(segment: string): string {
  const m = segment.trim().match(/^("([^"]*)"|'([^']*)'|(\S+))/);
  const raw = m?.[2] ?? m?.[3] ?? m?.[4] ?? "";
  return raw.toLowerCase().replace(/^.*[\\/]/, "");
}

/** Split a command line on && || ; | and newlines (no quote-awareness beyond trimming). */
export function splitChain(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The read-only flags of one binary, or of one `git` subcommand.
 *
 * This is an allowlist, which is the whole point of it. The blocklist it
 * replaces had to be finished to be correct, and three rounds of hand-probing
 * showed it never would be: `rg --pre` was closed in one round and
 * `rg --hostname-bin`, the same idea in the same option family, was still open
 * two rounds later. An allowlist is finished the moment it is written. A tool
 * that grows a new way to run a program in its next release cannot reopen a
 * hole here, because the new option is not on the list and the call escalates.
 *
 * Forgetting an option therefore costs one classifier call, which the verdict
 * cache pays once per session. Forgetting one in a blocklist cost a bypass.
 */
type ReadOnlyFlags = {
  /** Short option letters that only read. A cluster like `-rn` is split up. */
  short: string;
  /** Short options that take a value, attached or as the next word. */
  valued?: string;
  /** Long options that only read, spelled out in full. */
  long: string[];
  /** Predicates spelled with one dash and a whole word, the shape `find` uses. */
  words?: string[];
  /** True when this tool accepts unambiguous abbreviations of a long option.
   *  git and the GNU tools do; anything built on clap (rg, fd) does not, and
   *  saying so matters: `--pre` must not be read as short for `--pretty`. */
  abbrev?: boolean;
  /** Structure the flags alone do not capture, such as which operand of
   *  `git stash` is the one that only lists. */
  operands?: (rest: string[]) => boolean;
};

/** Diff output options, shared by the subcommands that produce a diff. Not
 *  `--output`, which writes the diff to a path of the caller's choosing, and
 *  not `--ext-diff`, which hands the file to the configured external driver. */
const GIT_DIFF_LONG = [
  "stat", "numstat", "shortstat", "compact-summary", "dirstat", "summary",
  "name-only", "name-status", "patch", "no-patch", "raw", "unified",
  "diff-filter", "diff-algorithm", "find-renames", "find-copies",
  "find-copies-harder", "break-rewrites", "renames", "no-renames",
  "irreversible-delete", "minimal", "patience", "histogram", "anchored",
  "relative", "text", "binary", "full-index", "abbrev", "src-prefix",
  "dst-prefix", "no-prefix", "color", "no-color", "color-words", "word-diff",
  "word-diff-regex", "function-context", "ignore-all-space",
  "ignore-space-change", "ignore-space-at-eol", "ignore-blank-lines",
  "ignore-cr-at-eol", "ignore-submodules", "submodule", "check", "exit-code",
  "quiet", "textconv", "no-textconv", "no-ext-diff", "stat-width",
  "cached", "staged", "merge-base",
];

/** Commit selection and formatting for the history subcommands. */
const GIT_LOG_LONG = [
  "oneline", "graph", "decorate", "no-decorate", "format", "pretty",
  "abbrev-commit", "no-abbrev-commit", "date", "since", "until", "after",
  "before", "author", "committer", "grep", "all", "branches", "tags",
  "remotes", "reverse", "max-count", "skip", "first-parent", "merges",
  "no-merges", "follow", "topo-order", "date-order", "author-date-order",
  "boundary", "parents", "children", "left-right", "cherry-pick", "count",
  "walk-reflogs", "simplify-by-decoration", "no-walk", "source",
];

/**
 * The `git` subcommands that can fast-pass, and what each one may be passed.
 * A subcommand that is not a key here escalates, which also covers the global
 * option position: `git -c core.pager=... log` has `-c` where a subcommand
 * should be, and `-c` is not a key.
 */
const GIT_READ_ONLY: Record<string, ReadOnlyFlags> = {
  status: {
    short: "sbuz", valued: "u", abbrev: true,
    long: ["short", "branch", "porcelain", "long", "verbose", "untracked-files",
      "ignored", "ignore-submodules", "column", "no-column", "renames",
      "no-renames", "find-renames", "show-stash", "ahead-behind",
      "no-ahead-behind", "null"],
  },
  log: {
    short: "npUwsSGLi", valued: "nUSGL", abbrev: true,
    long: [...GIT_LOG_LONG, ...GIT_DIFF_LONG],
  },
  show: {
    short: "npUwsq", valued: "nUS", abbrev: true,
    long: [...GIT_LOG_LONG, ...GIT_DIFF_LONG],
  },
  diff: {
    short: "pUwsMCBRzbW", valued: "UMCB", abbrev: true,
    long: [...GIT_DIFF_LONG, "no-index", "numbered"],
  },
  blame: {
    short: "LwfncersMC", valued: "LMC", abbrev: true,
    long: ["line-porcelain", "porcelain", "incremental", "show-name",
      "show-number", "show-email", "show-stats", "root", "reverse", "abbrev",
      "date", "encoding", "contents", "ignore-rev", "ignore-revs-file",
      "color-lines", "color-by-age", "first-parent"],
  },
  grep: {
    // Not `-O`/`--open-files-in-pager`, which runs its argument over every
    // match. No allowed spelling starts with "op", so no abbreviation of it
    // gets through either.
    short: "nilLcHhIwvaeEFPfzqW", valued: "efmC", abbrev: true,
    long: ["line-number", "no-line-number", "column", "count",
      "files-with-matches", "files-without-match", "name-only", "recursive",
      "no-recursive", "max-depth", "cached", "untracked", "no-index",
      "exclude-standard", "no-exclude-standard", "text", "ignore-case",
      "word-regexp", "invert-match", "extended-regexp", "basic-regexp",
      "fixed-strings", "perl-regexp", "only-matching", "threads", "heading",
      "break", "context", "after-context", "before-context",
      "function-context", "and", "or", "not", "all-match", "full-name",
      "textconv", "no-textconv", "quiet", "null"],
  },
  branch: {
    // Listing only. `-d/-D` delete, `-m/-M` move and `-f/-C` reset a branch to
    // another commit, so none of those letters are here, and neither is any
    // long spelling they could be abbreviated from: git resolves `--forc` to
    // `--force`, and nothing on this list starts with "forc".
    short: "avrl", abbrev: true,
    long: ["list", "all", "verbose", "remotes", "contains", "no-contains",
      "merged", "no-merged", "points-at", "sort", "format", "color",
      "no-color", "column", "no-column", "show-current", "ignore-case",
      "abbrev", "no-abbrev", "quiet"],
  },
  tag: {
    short: "ln", valued: "n", abbrev: true,
    long: ["list", "contains", "no-contains", "merged", "no-merged",
      "points-at", "sort", "format", "color", "column", "ignore-case",
      "omit-empty"],
  },
  "rev-parse": {
    short: "q", abbrev: true,
    long: ["verify", "abbrev-ref", "symbolic", "symbolic-full-name", "short",
      "is-inside-work-tree", "is-bare-repository", "is-inside-git-dir",
      "is-shallow-repository", "show-toplevel", "show-prefix", "show-cdup",
      "show-superproject-working-tree", "git-dir", "git-common-dir",
      "absolute-git-dir", "path-format", "quiet", "default", "all",
      "branches", "tags", "remotes", "disambiguate", "shared-index-path"],
  },
  "ls-files": {
    short: "cdmosztiuvkx", valued: "x", abbrev: true,
    long: ["cached", "deleted", "modified", "others", "ignored", "stage",
      "unmerged", "killed", "exclude", "exclude-standard", "full-name",
      "abbrev", "error-unmatch", "with-tree", "directory",
      "no-empty-directory", "eol", "deduplicate", "format", "null"],
  },
  "ls-remote": {
    // Not `--upload-pack`, which names the program run on the other end.
    short: "hqt", abbrev: true,
    long: ["heads", "tags", "refs", "get-url", "exit-code", "symref", "quiet",
      "sort"],
  },
  remote: {
    short: "v", abbrev: true, long: ["verbose"],
    // add/remove/set-url/rename rewrite config; update/prune touch refs.
    operands: (rest) => {
      const ops = rest.filter((a) => !a.startsWith("-"));
      return ops.length === 0 || ["show", "get-url"].includes(ops[0].toLowerCase());
    },
  },
  stash: {
    short: "pu", abbrev: true, long: [...GIT_LOG_LONG, ...GIT_DIFF_LONG],
    // A bare `git stash` saves; push/pop/apply/drop/clear all mutate.
    operands: (rest) => {
      const ops = rest.filter((a) => !a.startsWith("-"));
      return ops.length > 0 && ["list", "show"].includes(ops[0].toLowerCase());
    },
  },
};

/**
 * The non-git binaries that stay on the fast pass despite owning a flag that
 * writes or runs something. Their read-only flags are named; the rest escalate.
 */
const READ_ONLY_FLAGS: Record<string, ReadOnlyFlags> = {
  // Not -x/-X/--exec/--exec-batch, which run a command over every result, and
  // not -l/--list-details, which fd implements by running `ls`.
  fd: {
    short: "HIsigFapL01uqdteEcjS", valued: "dteEcjSj",
    long: ["hidden", "no-ignore", "no-ignore-vcs", "unrestricted",
      "case-sensitive", "ignore-case", "glob", "regex", "fixed-strings",
      "absolute-path", "follow", "full-path", "print0", "max-depth",
      "min-depth", "exact-depth", "type", "extension", "exclude",
      "ignore-file", "size", "changed-within", "changed-before", "owner",
      "color", "threads", "max-results", "quiet", "show-errors",
      "base-directory", "path-separator", "search-path", "strip-cwd-prefix",
      "one-file-system", "and", "prune", "help", "version"],
  },
  // Not --pre/--pre-glob, which filter each file through a command, and not
  // --hostname-bin, which runs one to label the output. rg takes long options
  // exactly, so `--pre` is never read as an abbreviation of `--pretty`.
  rg: {
    short: "ieEvwxcltLnNHhmABCFfgjoprsStTuUzaPM01",
    valued: "emABCfgjtTrdM",
    long: ["regexp", "file", "ignore-case", "case-sensitive", "smart-case",
      "invert-match", "word-regexp", "line-regexp", "count", "count-matches",
      "files-with-matches", "files-without-match", "files", "line-number",
      "no-line-number", "column", "with-filename", "no-filename", "heading",
      "no-heading", "max-count", "max-depth", "max-filesize", "after-context",
      "before-context", "context", "context-separator", "fixed-strings",
      "glob", "iglob", "glob-case-insensitive", "threads", "only-matching",
      "pretty", "quiet", "replace", "no-messages", "sort", "sortr", "type",
      "type-not", "type-add", "type-list", "unrestricted", "multiline",
      "multiline-dotall", "search-zip", "text", "binary", "pcre2", "hidden",
      "no-ignore", "no-ignore-vcs", "follow", "null", "null-data", "json",
      "stats", "trim", "vimgrep", "path-separator", "color", "colors",
      "crlf", "encoding", "engine", "field-match-separator", "include-zero",
      "one-file-system", "mmap", "no-mmap", "byte-offset", "block-buffered",
      "line-buffered", "debug", "help", "version"],
  },
  // Not -delete, -exec, -execdir, -ok, -okdir, -fprint, -fprint0, -fprintf or
  // -fls. find matches predicates exactly, so -fprintf cannot ride in on
  // -printf. Bare numbers are operands: `-mtime -1`, `-perm -644`.
  find: {
    short: "HLP",
    long: ["help", "version"],
    words: ["maxdepth", "mindepth", "depth", "daystart", "follow", "help",
      "mount", "noleaf", "ignore_readdir_race", "noignore_readdir_race",
      "regextype", "version", "warn", "nowarn", "xdev", "xautofs", "files0-from",
      "amin", "anewer", "atime", "cmin", "cnewer", "ctime", "mmin", "mtime",
      "newer", "empty", "executable", "readable", "writable", "false", "true",
      "fstype", "gid", "uid", "group", "user", "nogroup", "nouser", "context",
      "name", "iname", "path", "ipath", "wholename", "iwholename", "lname",
      "ilname", "regex", "iregex", "inum", "links", "perm", "samefile", "size",
      "type", "xtype", "used",
      "print", "print0", "printf", "ls", "quit", "prune",
      "not", "and", "or", "a", "o"],
  },
};

/** True when every flag in `args` is one the policy names as a read. */
function flagsAreReadOnly(policy: ReadOnlyFlags, args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break; // everything after this is an operand
    if (arg === "-" || !arg.startsWith("-")) continue; // operand, or stdin
    if (/^-\d+$/.test(arg)) continue; // `-5`, and find's numeric comparisons

    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0] ?? "";
      if (name === "") continue;
      const named = policy.abbrev
        ? policy.long.some((l) => l.startsWith(name))
        : policy.long.includes(name);
      if (!named) return false;
      continue;
    }

    if (policy.words) {
      // One dash and a whole word, matched exactly: no abbreviation, so
      // -fprintf is not -printf with a letter in front of it.
      const word = arg.slice(1);
      if (policy.words.includes(word)) continue;
      if ([...word].every((c) => policy.short.includes(c))) continue;
      return false;
    }

    for (const c of arg.slice(1)) {
      if (!policy.short.includes(c)) return false;
      // A letter that takes a value swallows the rest of the word, so `-uno`
      // is `-u no` and not a cluster containing `n` and `o`.
      if (policy.valued?.includes(c)) break;
    }
  }
  return policy.operands ? policy.operands(args) : true;
}

/** The policy for one invocation, or undefined when it cannot fast-pass. */
function readOnlyPolicy(bin: string, args: string[]): { policy: ReadOnlyFlags; rest: string[] } | undefined {
  if (bin === "git") {
    const sub = (args[0] ?? "").toLowerCase();
    const policy = Object.prototype.hasOwnProperty.call(GIT_READ_ONLY, sub)
      ? GIT_READ_ONLY[sub]
      : undefined;
    return policy ? { policy, rest: args.slice(1) } : undefined;
  }
  const policy = Object.prototype.hasOwnProperty.call(READ_ONLY_FLAGS, bin)
    ? READ_ONLY_FLAGS[bin]
    : undefined;
  return policy ? { policy, rest: args } : undefined;
}

/** True when a single chain segment is a provably read-only invocation. */
function isSafeSegment(segment: string): boolean {
  if (OPERATOR_RE.test(segment)) return false;
  const trimmed = segment.trim();
  const bin = binaryOf(trimmed);
  // Assignment prefixes (FOO=bar cmd) and sudo/doas wrappers are not provably safe.
  if (/^\w+=/.test(trimmed) || bin === "sudo" || bin === "doas" || bin === "su") return false;
  if (ALWAYS_READ_ONLY.has(bin)) return true;
  const found = readOnlyPolicy(bin, trimmed.split(/\s+/).slice(1));
  return found !== undefined && flagsAreReadOnly(found.policy, found.rest);
}

/**
 * Local rules pass over a shell command. Order matters:
 * disallowed globs -> hard-deny patterns -> safe fast-pass -> allowed globs.
 * Anything else is "unknown" and goes to Jev.
 */
export function classifyCommandLocal(command: string, settings: GuardSettings): LocalVerdict {
  const cmd = command.trim();
  if (!cmd) return { decision: "pass", reason: "empty command", audited: false };
  if (matchesAny(cmd, settings.disallowedCommands)) {
    return { decision: "deny", reason: "matched disallowedCommands list", audited: true };
  }
  for (const p of HARD_DENY_PATTERNS) {
    const hit = "re" in p ? p.re.test(cmd) : p.hits(cmd);
    if (hit) return { decision: "deny", reason: `hard-deny pattern: ${p.reason}`, audited: true };
  }
  if (matchesAny(cmd, settings.safeCommands)) {
    return { decision: "pass", reason: "matched safeCommands list", audited: false };
  }
  const segments = splitChain(cmd);
  if (segments.length > 0 && segments.every(isSafeSegment)) {
    return { decision: "pass", reason: "read-only command chain", audited: false };
  }
  if (matchesAny(cmd, settings.allowedCommands)) {
    return { decision: "pass", reason: "matched allowedCommands list", audited: true };
  }
  return { decision: "unknown", reason: "no local rule matched" };
}

// ---------------------------------------------------------------------------
// Secrets redaction (applied locally, before anything leaves the machine)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-(ant|or-v1|live|test)-[A-Za-z0-9_-]{8,}/g, // OpenAI / Anthropic / OpenRouter style
  /\bsk-ant-oat[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /(?<=['"]?(api[_-]?key|token|secret|password|passwd|auth)['"]?\s*[:=]\s*['"]?)[^'"\s;,}]{8,}/gi,
  /(?<=--(token|api-key|api_key|password)\s*=\s*)\S{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `…[truncated ${text.length - max} chars]`;
}

// ---------------------------------------------------------------------------
// Jev verdict handling
// ---------------------------------------------------------------------------

export interface JevVerdict {
  /** 0 = clearly safe, 1 = clearly dangerous. */
  danger: number;
  category: string;
  reason: string;
}

export type Band = "allow" | "ask" | "block";

/** Map a danger probability onto an action band. */
export function bandFor(danger: number, settings: GuardSettings): Band {
  if (danger >= settings.blockThreshold) return "block";
  if (danger >= settings.askThreshold) return "ask";
  return "allow";
}

/** Parse Jev's JSON verdict from a chat completion. Accepts prose/code fences
 *  around the object, normalizes a 0-100 danger scale to 0-1, and clamps. */
export function parseVerdict(text: string): JevVerdict | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const candidates: string[] = [];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  const inner = text.match(/\{[^{}]*"danger"[^{}]*\}/g);
  if (inner) {
    for (const m of inner) {
      if (!candidates.includes(m)) candidates.push(m);
    }
  }
  for (const candidate of candidates) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    let raw: unknown = null;
    for (const [k, v] of Object.entries(parsed)) {
      if (k === "danger") raw = v;
    }
    if (typeof raw !== "number" || Number.isNaN(raw)) continue;
    let danger = raw;
    if (danger > 1) danger = danger / 100;
    if (danger < 0) danger = 0;
    if (danger > 1) danger = 1;
    let category = "unknown";
    let reason = "";
    for (const [k, v] of Object.entries(parsed)) {
      if (k === "category" && typeof v === "string" && v.trim() !== "") {
        category = v.trim().slice(0, 100);
      }
      if (k === "reason" && typeof v === "string") {
        reason = v.trim().slice(0, 500);
      }
    }
    return { danger, category, reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classifier prompt + payload
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  kind: "bash" | "powershell" | "write" | "edit";
  /** Shell command, or "write <path>" / "edit <path>" for file ops. */
  subject: string;
  cwd: string;
  /** Most recent user prompt, for intent context. May be empty. */
  userPrompt: string;
}

export const CLASSIFIER_SYSTEM = [
  "You are a security classifier for an AI coding agent. Rate how DANGEROUS it would be",
  "to execute the proposed tool call on the developer's own workstation.",
  "Danger means: irreversible data loss, credential exfiltration, harm to other systems,",
  "supply-chain compromise (running fetched code), or escaping the project directory.",
  "Ordinary development (running tests, building, editing project files, installing",
  "dependencies from the project's lockfile, routine git operations) is NOT dangerous.",
  "Reply with a single JSON object and nothing else:",
  '{"danger": 0.0-1.0, "category": "<short-label>", "reason": "<one sentence>"}.',
  "Calibrate: 0.0-0.2 routine and safe, 0.2-0.4 mostly safe with minor side effects,",
  "0.4-0.7 risky or hard to reverse, 0.7-1.0 likely harmful or destructive.",
].join(" ");

export function buildClassifierMessages(input: ClassifyInput): Array<{ role: string; content: string }> {
  const lines = [
    `tool: ${input.kind}`,
    `action: ${redactSecrets(truncate(input.subject, 2000))}`,
    `working directory: ${input.cwd}`,
  ];
  const prompt = redactSecrets(truncate(input.userPrompt.trim(), 500));
  lines.push(`user's latest request: ${prompt === "" ? "(none)" : prompt}`);
  return [
    { role: "system", content: CLASSIFIER_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

/** Minimal OpenRouter chat-completions body. Kept minimal on purpose: Jev's
 *  capability listing advertises no extra parameters, so only model+messages. */
export function buildRequestBody(model: string, messages: Array<{ role: string; content: string }>): string {
  return JSON.stringify({ model, messages });
}

/** Two parallel yes/no questions for the TypeSafe direct backend. Both are
 *  phrased so that a high probability means DANGEROUS (unlike the DEV-post
 *  gate, which phrases safe-side up). danger for the call is the max. */
export const TYPESAFE_QUESTIONS: Record<string, { type: string; instructions: string }> = {
  is_dangerous: {
    type: "noul",
    instructions:
      "Executing the tool call described in `action` would be dangerous: it risks " +
      "irreversible data loss, credential exfiltration, harm to other systems, supply-chain " +
      "compromise, or escaping the project directory, given `user_request`.",
  },
  exfiltrates_or_destroys: {
    type: "noul",
    instructions:
      "The tool call described in `action` sends credentials or sensitive data to an outside " +
      "party, destroys data irreversibly, or runs remotely-fetched code.",
  },
};

/** State object for the TypeSafe direct backend (structured, bounded, redacted). */
export function buildSystemOneState(input: ClassifyInput): Record<string, string> {
  return {
    tool: input.kind,
    action: redactSecrets(truncate(input.subject, 2000)),
    working_directory: input.cwd,
    user_request: redactSecrets(truncate(input.userPrompt.trim(), 500)),
  };
}

export function buildSystemOneBody(model: string, input: ClassifyInput): string {
  return JSON.stringify({ model, state: buildSystemOneState(input), questions: TYPESAFE_QUESTIONS });
}

/** Parse a TypeSafe /v1/systemone response. success=false carries the error text. */
export function parseSystemOneResponse(
  status: number,
  body: string,
): { ok: true; verdict: JevVerdict; model: string } | { ok: false; error: string } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: `HTTP ${status}: unreadable response` };
  }
  if (status < 200 || status >= 300) {
    let detail = `HTTP ${status}`;
    if (typeof parsed === "object" && parsed !== null) {
      const rec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) rec[k] = v;
      const msg = rec["message"] ?? rec["error"];
      if (typeof msg === "string" && msg !== "") detail += `: ${truncate(msg, 200)}`;
    }
    return { ok: false, error: detail };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: `HTTP ${status}: unexpected response shape` };
  }
  const rec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) rec[k] = v;
  const model = typeof rec["model"] === "string" ? rec["model"] : "jev";
  const answers = rec["answers"];
  if (typeof answers !== "object" || answers === null) {
    return { ok: false, error: "response has no answers map" };
  }
  let best: JevVerdict | null = null;
  const answerRec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) answerRec[k] = v;
  for (const [id, a] of Object.entries(answerRec)) {
    if (typeof a !== "object" || a === null) continue;
    let p: unknown = null;
    for (const [k, v] of Object.entries(a)) {
      if (k === "noul") p = v;
    }
    if (typeof p !== "number" || Number.isNaN(p)) continue;
    const danger = Math.min(1, Math.max(0, p));
    const label = id === "exfiltrates_or_destroys" ? "exfiltration-or-destruction" : "dangerous-action";
    if (!best || danger > best.danger) {
      best = { danger, category: label, reason: `Jev noul ${id}=${danger.toFixed(2)}` };
    }
  }
  if (!best) return { ok: false, error: "no usable noul answers in response" };
  return { ok: true, verdict: best, model };
}

/** Resolve whether the guard gates calls: a session override wins,
 *  otherwise the saved setting applies. Pure so the toggle stays testable. */
export function resolveEnabled(
  savedEnabled: boolean,
  sessionOverride: boolean | undefined,
): { enabled: boolean; source: "session" | "saved" } {
  if (sessionOverride !== undefined) return { enabled: sessionOverride, source: "session" };
  return { enabled: savedEnabled, source: "saved" };
}

/** A transcript line for one audit record: what it says, and the theme colour
 *  it is drawn in. */
export interface AuditLine {
  text: string;
  tone: "dim" | "warning" | "error";
}

/** Where a decision came from, in the few words the transcript line can spare. */
function sourceNote(source: string | undefined): string {
  switch (source) {
    case "rules":
      return "rules";
    case "allowlist":
      return "allowlist";
    case "no-key":
      return "no key";
    case "error":
      return "classifier error";
    default:
      return "";
  }
}

/**
 * The transcript line for one record.
 *
 * It sits directly under the call it judged, so it repeats none of it: the
 * mark, the score, and the decision only where the decision was not a plain
 * allow. The routine verdict is the common case, and the common case is the
 * one that must not crowd out the conversation, so it gets one dim line and no
 * box. A decision with no score always names itself, because "jev" alone says
 * nothing about what happened.
 */
export function formatAuditLine(record: AuditStatusInput & { source?: string }): AuditLine {
  const danger = record.danger;
  const scored = typeof danger === "number" && Number.isFinite(danger);
  const score = scored ? ` ${danger.toFixed(2)}` : "";
  const note = sourceNote(record.source);
  const tail = note === "" ? "" : ` (${note})`;
  switch (record.decision) {
    case "allowed":
      return { text: scored && note === "" ? `jev${score}` : `jev${score} allowed${tail}`, tone: "dim" };
    case "asked-allowed":
      return { text: `jev${score} allowed by you`, tone: "warning" };
    case "asked-blocked":
      return { text: `jev${score} blocked by you`, tone: "warning" };
    default:
      return { text: `jev${score} blocked${tail}`, tone: "error" };
  }
}

/**
 * Validate an `auditDisplay` value read from a settings file. An unknown value
 * returns undefined so the layer below keeps standing: a typo in the project
 * file should not silently reset the mode the user chose globally.
 */
export function parseAuditDisplay(value: unknown): AuditDisplay | undefined {
  return value === "transcript" || value === "status" || value === "off" ? value : undefined;
}

/** The fields of an audit record the footer line is built from. */
export interface AuditStatusInput {
  tool: string;
  decision: string;
  danger?: number;
  model?: string;
}

/** What the footer says about the guard: how much it has judged this session,
 *  and, in `status` mode, what it decided last. */
export interface GuardStatusInput {
  /** Calls the classifier judged this session. */
  calls: number;
  /** Calls the guard stopped, by any route. */
  blocked: number;
  /** The most recent decision. Shown in `status` mode only. */
  latest?: AuditStatusInput;
}

/**
 * The guard's one line in pi's footer, e.g. "jev 12 · 1 blocked · bash 0.04".
 *
 * The count is always there: it is how a session that shows no records still
 * shows the guard is awake. The rest appears only when it has something to
 * say, because the footer is one line shared with every other extension and is
 * truncated to the terminal width.
 *
 * A segment whose field is missing is dropped rather than defaulted. Rule
 * decisions carry no score, and printing "0.00" for a hard-deny block would
 * label the most dangerous call the guard ever sees as the safest thing on
 * screen.
 */
export function formatGuardStatus(state: GuardStatusInput): string {
  const parts = [`jev ${Math.max(0, Math.trunc(state.calls))}`];
  if (state.blocked > 0) parts.push(`${Math.trunc(state.blocked)} blocked`);
  const latest = state.latest;
  if (latest) {
    const danger = latest.danger;
    const score = typeof danger === "number" && Number.isFinite(danger) ? ` ${danger.toFixed(2)}` : "";
    const word = latest.decision === "allowed" ? "" : ` ${latest.decision}`;
    parts.push(`${latest.tool}${word}${score}`);
  }
  return parts.join(" · ");
}

/**
 * What to do with a middle-band verdict when there is nobody to ask: a
 * non-interactive run (a script, a CI job, an agent driving pi headlessly)
 * cannot answer a confirmation prompt. `uncertain` decides, and only an
 * explicit "allow" lets the call through; everything else fails closed.
 * Pure so the policy stays testable.
 */
export function middleBandWithoutUI(policy: UncertainPolicy): "allow" | "block" {
  return policy === "allow" ? "allow" : "block";
}

/** Derive the OpenRouter decisions endpoint from a chat-compatible base URL.
 *  Default base https://openrouter.ai/api/v1 -> https://openrouter.ai/api/alpha/decisions. */
export function openRouterDecisionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/alpha/decisions")) return trimmed;
  if (trimmed.endsWith("/api/v1")) {
    return trimmed.slice(0, -"/api/v1".length) + "/api/alpha/decisions";
  }
  return trimmed + "/decisions";
}

/** Normalize a path for protected-glob matching (relative, forward slashes). */
export function relativePosix(targetPath: string, cwd: string): string {
  let rel = targetPath;
  const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normTarget = targetPath.replace(/\\/g, "/");
  if (normTarget.toLowerCase().startsWith(normCwd.toLowerCase() + "/")) {
    rel = normTarget.slice(normCwd.length + 1);
  } else if (normTarget.toLowerCase() === normCwd.toLowerCase()) {
    rel = ".";
  } else {
    rel = normTarget;
  }
  return rel;
}

/** True when a write/edit target must be reviewed by Jev. */
export function isProtectedPath(targetPath: string, cwd: string, settings: GuardSettings): boolean {
  const rel = relativePosix(targetPath, cwd);
  // Anything outside the workspace always needs review.
  if (rel.startsWith("/") || /^[A-Za-z]:\//.test(rel) || rel.startsWith("..")) return true;
  return matchesAny(rel, settings.protectedPaths) || matchesAny(targetPath, settings.protectedPaths);
}
