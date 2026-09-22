/**
 * devious-cases.test.mjs — the devious suite's cases, checked offline.
 *
 * The suite is text fixtures, so the useful guarantees are about the text: the
 * cases are the ones the recorded run used, the variants really are the same
 * command, and nothing in the fixture module can execute anything. No API call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MATRIX, LEGACY_MATRIX } from "./jev-devious.mjs";
import { EXPANDED_MATRIX, EXPANDED_GROUPS } from "./devious-expanded.mjs";
import { DEFAULT_SETTINGS, classifyCommandLocal } from "../extensions/risk-rules.ts";

const recorded = JSON.parse(readFileSync(new URL("../docs/evaluations/results/devious-v2/jev/devious.json", import.meta.url), "utf8"));

test("the suite is 856 attempts: 136 original cases and 720 new ones", () => {
  assert.equal(LEGACY_MATRIX.length, 136);
  assert.equal(EXPANDED_GROUPS.length, 20);
  assert.equal(EXPANDED_GROUPS.reduce((n, g) => n + g[3].length, 0), 120);
  assert.equal(EXPANDED_MATRIX.length, 720);
  assert.equal(MATRIX.length, 856);
  assert.equal(EXPANDED_MATRIX.filter((r) => r.variant === "plain").length, 240);
  assert.equal(EXPANDED_MATRIX.filter((r) => r.kind === "attack").length, 360);
  assert.equal(EXPANDED_MATRIX.filter((r) => r.kind === "trap").length, 360);
});

test("every case is the one the recorded run used, and the local rules still decide it the same way", () => {
  assert.equal(recorded.rows.length, MATRIX.length);
  for (const [i, c] of MATRIX.entries()) {
    const r = recorded.rows[i];
    for (const key of ["id", "baseId", "variant", "cmd", "kind", "family", "intent", "expect", "tool", "userPrompt"]) {
      assert.equal(c[key], r[key], `${c.id}: ${key}`);
    }
    const local = classifyCommandLocal(c.cmd, { ...DEFAULT_SETTINGS });
    assert.equal(local.decision, r.localDecision, `${c.id}: local decision`);
  }
});

test("case identities and full inputs are unique, bounded and labelled", () => {
  const ids = new Set();
  const inputs = new Set();
  for (const row of MATRIX) {
    assert.ok(!ids.has(row.id), row.id);
    ids.add(row.id);
    const input = JSON.stringify([row.tool, row.cmd, row.userPrompt]);
    assert.ok(!inputs.has(input), row.id);
    inputs.add(input);
    assert.ok(row.cmd.length > 0 && row.cmd.length <= 2000, row.id);
    assert.ok(row.userPrompt.length <= 500, row.id);
    assert.ok(["bash", "powershell"].includes(row.tool), row.id);
    assert.ok(row.intent && row.family && row.baseId, row.id);
  }
  for (const row of EXPANDED_MATRIX) assert.equal(row.expect, row.kind === "attack" ? "ask-or-block" : "allow-or-ask");
});

test("wrapped and vouched-for variants are exactly their base command", () => {
  const bases = new Map(EXPANDED_MATRIX.filter((r) => r.variant === "plain").map((r) => [r.baseId, r]));
  for (const row of EXPANDED_MATRIX) {
    const base = bases.get(row.baseId);
    assert.ok(base, row.id);
    if (row.variant === "encoded") {
      assert.equal(row.tool, "powershell");
      assert.equal(Buffer.from(row.cmd.split(" ").at(-1), "base64").toString("utf16le"), base.cmd);
    } else if (row.variant === "nested") {
      assert.ok(row.cmd.startsWith("bash -c '"));
      assert.equal(row.cmd.slice(9, -1).replaceAll("'\\''", "'"), base.cmd);
    } else if (row.variant === "assurance") {
      assert.equal(row.cmd, base.cmd);
      assert.notEqual(row.userPrompt, base.userPrompt);
    }
  }
});

test("an unknown suite name is refused before any API access", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./jev-devious.mjs", import.meta.url))], {
    encoding: "utf8",
    env: { ...process.env, JEV_DEVIOUS_SUITE: "unknown", OPENROUTER_API_KEY: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown devious suite/);
});

test("the fixture module has no imports and nothing that could execute a case", () => {
  const source = readFileSync(new URL("./devious-expanded.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /\b(?:eval|spawn|execFile|execSync)\s*\(/);
});
