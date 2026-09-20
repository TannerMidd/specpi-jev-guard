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

/** Commands that are read-only and side-effect free on their own. */
const SAFE_BINARIES = new Set([
  "ls",
  "dir",
  "cat",
  "type",
  "head",
  "tail",
  "more",
  "less",
  "pwd",
  "cd",
  "whoami",
  "hostname",
  "date",
  "uname",
  "echo",
  "printf",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "grep",
  "rg",
  "find",
  "fd",
  "lsd",
  "tree",
  "file",
  "stat",
  "df",
  "du",
  "free",
  "ps",
  "which",
  "where",
  "git",
  "hg",
  "svn",
]);

/** git subcommands that never mutate anything. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "ls-remote",
  "remote",
  "tag",
  "blame",
  "grep",
  "stash",
]);

// hg/svn have no per-command handling below, so — unlike git — a subcommand
// not listed here falls through to Jev instead of fast-passing. These are the
// read-only ones; anything else (hg purge, hg update -C, svn rm, svn export)
// mutates and must not be treated as a provably read-only chain.
const SAFE_HG_SUBCOMMANDS = new Set([
  "status", "st", "log", "diff", "cat", "annotate", "blame",
  "id", "root", "summary", "sum", "paths", "tags", "heads",
  "branches", "manifest", "files", "grep", "identify",
]);
const SAFE_SVN_SUBCOMMANDS = new Set([
  "status", "st", "log", "diff", "cat", "info", "list", "ls",
  "blame", "annotate", "praise", "propget", "pg", "proplist", "pl",
]);

/** Shell operators that make a command line non-trivial. */
const OPERATOR_RE = /(&&|\|\||[;|<>]|`|\$\(|\$\{)/;

/**
 * Top-level directories that belong to the system rather than to whoever is
 * running the command. Children are deliberately not included: /var/tmp/cache
 * is somebody's build output, /var is the machine.
 */
const SYSTEM_DIRS = new Set([
  "usr", "etc", "bin", "sbin", "lib", "lib64", "boot", "var", "opt", "srv", "home", "root",
  "system", "system32", "windows",
]);

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

/** Flags that turn an otherwise read-only binary into a writer, or a `git`
 *  subcommand that mutates refs. A matching segment falls through to Jev
 *  instead of fast-passing, so the zero-latency path stays provably read-only. */
function hasUnsafeReadOnlyFlag(bin: string, args: string[]): boolean {
  const nonFlag = args.filter((a) => !a.startsWith("-"));
  const flag = (re: RegExp): boolean => args.some((a) => re.test(a));
  switch (bin) {
    case "find":
      // -delete, -exec*, -ok*, -fprint* all mutate the filesystem.
      return flag(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/);
    case "sort":
      // sort -o file / --output=file overwrite the target.
      return flag(/^(-o.+|--output(=.*)?)$/) || args.includes("-o");
    case "uniq":
      // uniq IN OUT writes to OUT; one operand (or flags only) is read-only.
      return nonFlag.length >= 2;
    case "git":
      return isUnsafeGitArgs(args);
    default:
      return false;
  }
}

/** True when a `git` invocation mutates refs, history, remotes, or runs code. */
function isUnsafeGitArgs(args: string[]): boolean {
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1);
  const first = (rest[0] ?? "").toLowerCase();
  const anyFlag = (re: RegExp): boolean => rest.some((a) => re.test(a));
  switch (sub) {
    case "branch":
      // -d/-D delete, -m/-M move, -f/-C reset an existing branch to another
      // commit, which drops whatever was on it. Plain `git branch` and
      // `-a/-v/-r` only list. Creating a branch or a tag (a bare name operand)
      // writes a ref but loses nothing and is left on the fast-pass, so listing
      // forms like `git branch --format=...` are not dragged to Jev.
      return anyFlag(/^-[a-zA-Z]*[dDmMfC][a-zA-Z]*$/) || anyFlag(/^--(delete|move|force|copy)$/);
    case "tag":
      return anyFlag(/^-[a-zA-Z]*[dTf][a-zA-Z]*$/) || anyFlag(/^--(delete|force)$/);
    case "remote":
      // Mutating forms: add/remove/set-url/rename change config; update/prune
      // fetch or delete tracking refs. `git remote` / `-v` / `show` only read.
      return ["add", "remove", "rm", "set-url", "set-head", "set-branches", "rename", "prune", "update"].includes(first);
    case "stash":
      // Only listing/inspecting is read-only. Bare `git stash` (save),
      // push/pop/apply/drop/clear all mutate the working tree or stash.
      return !["list", "show"].includes(first);
    case "grep":
      // -O / --open-files-in-pager runs its argument as a shell command over
      // the matching files — arbitrary code execution, not a read.
      return rest.some((a) => /^-O/.test(a) || /^--open-files-in-pager(=.*)?$/.test(a));
    case "clean":
      return true;
    default:
      return false;
  }
}

/** True when a single chain segment is a provably read-only invocation. */
function isSafeSegment(segment: string): boolean {
  if (OPERATOR_RE.test(segment)) return false;
  const trimmed = segment.trim();
  const bin = binaryOf(trimmed);
  if (!SAFE_BINARIES.has(bin)) return false;
  if (bin === "git" || bin === "hg" || bin === "svn") {
    const sub = trimmed.split(/\s+/)[1]?.toLowerCase().replace(/^-+/, "") ?? "";
    const allow =
      bin === "git" ? SAFE_GIT_SUBCOMMANDS : bin === "hg" ? SAFE_HG_SUBCOMMANDS : SAFE_SVN_SUBCOMMANDS;
    if (!allow.has(sub)) return false;
  }
  if (hasUnsafeReadOnlyFlag(bin, trimmed.split(/\s+/).slice(1))) return false;
  // Assignment prefixes (FOO=bar cmd) and sudo/doas wrappers are not provably safe.
  if (/^\w+=/.test(trimmed) || bin === "sudo" || bin === "doas" || bin === "su") return false;
  return true;
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
