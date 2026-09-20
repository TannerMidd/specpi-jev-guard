/**
 * run.mjs — the whole end-to-end suite: build a sandbox pi, install the packed
 * extension into it, and drive four batches of scenarios through the real
 * agent loop. Writes tests/pi-e2e-results.json, which the Testing page reads.
 *
 *   npm run e2e                      # full run, about ten minutes
 *   npm run e2e -- a c               # only the batches you name
 *   JEV_E2E_MODEL=<slug> npm run e2e # drive it with a different agent model
 *
 * It needs an OpenRouter key (environment, .env, or a saved pi login) because
 * both halves are live: the agent that proposes the calls and the classifier
 * that judges them.
 */
import { writeFileSync } from "node:fs";
import { AGENT_MODEL, ROOT, buildSandbox, resetFixture, scrubSecrets } from "./setup.mjs";
import runBatchA from "./batch-a.mjs";
import runBatchB from "./batch-b.mjs";
import runBatchC from "./batch-c.mjs";
import runBatchD from "./batch-d.mjs";

const BATCHES = { a: runBatchA, b: runBatchB, c: runBatchC, d: runBatchD };
const pick = process.argv.slice(2).map((s) => s.toLowerCase()).filter((s) => s in BATCHES);
const chosen = pick.length > 0 ? pick : Object.keys(BATCHES);

const started = Date.now();
const { packed } = buildSandbox();

const rows = [];
for (const id of chosen) {
  console.log(`\n${"=".repeat(64)}\nbatch ${id.toUpperCase()}\n${"=".repeat(64)}`);
  resetFixture();
  rows.push(...(await BATCHES[id]()));
}

const passed = rows.filter((r) => r.pass).length;
const declined = rows.filter((r) => r.declined).length;
const payload = {
  meta: {
    stamp: new Date().toISOString().slice(0, 10),
    pi: process.env.JEV_E2E_PI_VERSION ?? null,
    agentModel: AGENT_MODEL,
    artifact: packed?.split(/[\\/]/).pop() ?? null,
    sandbox: ROOT, // replaced with a placeholder below; see the note on `portable`
    batches: chosen,
    scenarios: rows.length,
    passed,
    failed: rows.length - passed - declined,
    notExercised: declined,
    durationMs: Date.now() - started,
    note:
      "Every scenario runs against a sandboxed pi installation of the packed npm tarball, " +
      "with a real agent proposing the tool calls and the real classifier judging them. " +
      "No command in the suite can do damage if the guard fails: the devices do not exist, " +
      "the network targets refuse, and the working directory is a fixture.",
  },
  rows,
};
// The sandbox path is this machine, not the result. Anything that quotes it
// back (an error message, a `pi list` line) gets the same placeholder, so the
// committed artifact reads the same wherever it was produced.
const portable = JSON.stringify(payload, null, 2)
  .split(JSON.stringify(ROOT).slice(1, -1))
  .join("<sandbox>")
  .split(ROOT.replace(/\\/g, "/"))
  .join("<sandbox>");
writeFileSync(new URL("../pi-e2e-results.json", import.meta.url), portable + "\n", "utf-8");

console.log(`\n${"=".repeat(64)}`);
console.log(
  `end to end: ${passed}/${rows.length - declined} scenarios passed in ${Math.round((Date.now() - started) / 1000)}s` +
    (declined ? `, ${declined} not exercised because the agent declined` : ""),
);
for (const r of rows.filter((x) => !x.pass && !x.declined)) console.log(`  FAILED ${r.id}  ${r.title}`);
for (const r of rows.filter((x) => x.declined)) console.log(`  NOT EXERCISED ${r.id}  ${r.title}`);
scrubSecrets();
console.log("wrote tests/pi-e2e-results.json; the sandbox key has been removed");
