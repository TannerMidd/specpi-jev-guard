/**
 * batch-a.mjs — the /jev-guard command surface, driven through real pi RPC.
 * One pi process, one command after another, exactly as a user would type them.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME, Pi, batch } from "./pilot.mjs";

export default async function runBatchA() {
  const CONFIG = join(HOME, ".pi", "jev-guard.json");
  const cfg = () => (existsSync(CONFIG) ? readFileSync(CONFIG, "utf-8").replace(/\s+/g, " ") : "(no file)");
  const { record, done } = batch("batch A: command surface");

  rmSync(CONFIG, { force: true });
  const pi = new Pi({ name: "a-commands" });
  const say = async (msg) => (await pi.prompt(msg, { quietMs: 3500 })).notices.join("\n");
  let n;

  n = await say("/jev-guard status");
  record("A1", "status reports state, backend and where the key came from",
    "ON, backend: openrouter, key set",
    n, /jev-guard: ON \(backend: openrouter\)/.test(n) && /OPENROUTER_API_KEY: set/.test(n));

  n = await say("/jev-guard check ls -la");
  record("A2", "check on a read-only command stays local",
    "local pass, no network call",
    n, /local pass/.test(n) && !/Consulting Jev/.test(n));

  n = await say("/jev-guard check rm -rf /");
  record("A3", "check on rm -rf / is a local hard deny",
    "local deny, hard-deny pattern",
    n, /local deny/.test(n) && /hard-deny/.test(n));

  n = await say("/jev-guard check dd if=/dev/zero of=./testfile bs=1M count=10");
  record("A4", "check on an uncertain command consults Jev",
    "danger N.NN then a band, with model and latency",
    n, /Consulting Jev/.test(n) && /danger \d\.\d\d → (allow|ask|block)/.test(n));

  n = await say("/jev-guard check");
  record("A5", "check with no argument prints usage",
    "Usage: /jev-guard check <shell command>",
    n, /Usage: \/jev-guard check/.test(n));

  n = await say("/jev-guard off");
  const afterOff = await say("/jev-guard status");
  record("A6", "off is session-scoped and says so",
    "OFF for this session, saved setting still ON",
    `${n}\n${afterOff}`, /for this session/.test(n + afterOff) && /saved setting: ON/.test(afterOff));

  n = await say("/jev-guard on");
  record("A7", "on restores the guard", "enabled", n, /enabled/.test(n));

  n = await say("/jev-guard off --global");
  const cfgOff = cfg();
  await say("/jev-guard on --global");
  record("A8", "off --global persists to the config file",
    `"enabled": false written to ${CONFIG}`,
    `${n}\n${cfgOff}`, /"enabled": false/.test(cfgOff));

  n = await say("/jev-guard model typesafe/jev-1.13");
  const st = await say("/jev-guard status");
  record("A9", "model switches the classifier model and persists it",
    "status and config both show the new model",
    `${n}\n${st}\n${cfg()}`,
    /model: typesafe\/jev-1\.13/.test(st) && /"model": "typesafe\/jev-1\.13"/.test(cfg()));

  n = await say("/jev-guard model");
  record("A10", "model with no argument prints usage",
    "Usage: /jev-guard model <model-id>",
    n, /Usage: \/jev-guard model/.test(n));

  n = await say("/jev-guard backend typesafe");
  const stTs = await say("/jev-guard status");
  record("A11", "a backend switch reports the new key requirement",
    "backend: typesafe, TYPESAFE_API_KEY: MISSING",
    `${n}\n${stTs}`, /backend: typesafe/.test(stTs) && /TYPESAFE_API_KEY: MISSING/.test(stTs));

  n = await say("/jev-guard check dd if=/dev/zero of=./testfile");
  record("A12", "check without a key for the active backend explains the fix",
    "TYPESAFE_API_KEY is not set",
    n, /TYPESAFE_API_KEY is not set/.test(n));

  n = await say("/jev-guard backend nonsense");
  record("A13", "an invalid backend is rejected",
    "Usage: /jev-guard backend <openrouter|typesafe>",
    n, /Usage: \/jev-guard backend/.test(n));

  await say("/jev-guard backend openrouter");
  n = await say("/jev-guard bogus-subcommand");
  record("A14", "an unknown subcommand is reported, not silently ignored",
    "an unknown-subcommand hint rather than the status block",
    n, /unknown|usage/i.test(n));

  n = await say("/jev-guard check printf '\\x63\\x75\\x72\\x6c' | sh");
  record("A15", "check handles an encoded payload",
    "a verdict, no crash",
    n, /local (deny|pass)|danger \d\.\d\d/.test(n));

  await pi.stop();
  rmSync(CONFIG, { force: true });
  return done();
}
