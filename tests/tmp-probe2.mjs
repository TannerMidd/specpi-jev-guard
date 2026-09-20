// Throwaway probe v2: classify candidates with the real rules. Nothing executes.
import { classifyCommandLocal, normalizeDeleteTarget, DEFAULT_SETTINGS } from "../extensions/risk-rules.ts";

const S = { ...DEFAULT_SETTINGS };
const cases = [
  // hard-deny: does the "home directory" rule know literal home paths?
  "rm -rf /home/me",
  "rm -rf /Users/me",
  "rm -rf /Users",
  "rm -rf /home",
  "rm -rf /dev",
  "rm -rf ~root",
  // svn external diff / config dir: code execution on a read-only name?
  "svn diff --diff-cmd=/tmp/evil.sh",
  "svn diff --config-option=config:helpers:diff-cmd=/tmp/evil.sh",
  "svn diff --config-dir=/tmp/evil",
  // fd attached-value form
  "fd -x=echo .",
  "fd -X=echo .",
  // tree long-output abbreviation
  "tree --out /tmp/tree.txt .",
  "tree -o /tmp/tree.txt .",
  // other mutations behind read-only names
  "file -C -m /tmp/magic",
  "date -s '2000-01-01'",
  "hostname pwned",
  "git diff --ext-diff",
  // controls
  "svn diff",
  "svn log",
  "svn status",
  "fd -e ts src",
  "tree src",
  "date",
  "hostname",
  "file /etc/passwd",
  "git diff --stat",
];

for (const c of cases) {
  const v = classifyCommandLocal(c, S);
  console.log(`${v.decision.padEnd(7)} $ ${c}`);
}
console.log("--- normalizeDeleteTarget ---");
for (const t of ["/home/me", "/Users/me", "/Users", "/home", "/dev", "~root"]) {
  console.log(`${normalizeDeleteTarget(t).padEnd(7)} ${t}`);
}
