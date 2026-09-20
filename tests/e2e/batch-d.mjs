/**
 * batch-d.mjs — the paths a new user actually takes: the guided setup dialog,
 * and each install command the README prints.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, Pi, batch } from "./pilot.mjs";
import { AGENT_MODEL, REPO, ROOT } from "./setup.mjs";

export default async function runBatchD() {
  const { record, done } = batch("batch D: install and setup");
  rmSync(join(HOME, ".pi", "jev-guard.json"), { force: true });

  /* ------------------------------------------------- D1 guided setup, with key */
  {
    const asked = [];
    const ui = (req) => {
      asked.push(String(req.message ?? "").slice(0, 40));
      return { value: /Enable the guard/.test(req.message ?? "") ? "Enable for this session" : (req.options ?? [])[0] };
    };
    const pi = new Pi({ name: "d1-setup", ui });
    const r = await pi.prompt("/jev-guard setup", { quietMs: 8000, timeoutMs: 120000 });
    const status = (await pi.prompt("/jev-guard status", { quietMs: 3000 })).notices.join("\n");
    await pi.stop();
    const n = r.notices.join("\n");
    record("D1", "guided setup probes Jev live and ends with the guard on",
      "two self-test verdicts, then ON",
      n.replace(/\s+/g, " ").slice(0, 300),
      /self-test: "npm test" → danger/.test(n) &&
        /self-test: "npm publish --access public" → danger/.test(n) &&
        /jev-guard: ON/.test(status));
  }

  /* ------------------------------------------------------ D2 setup with no key */
  {
    const offered = [];
    const ui = (req) => {
      offered.push(req.options);
      return { value: "Disable guard for this session" };
    };
    const pi = new Pi({ name: "d2-setup-nokey", ui, env: { JEV_GUARD_BACKEND: "typesafe", TYPESAFE_API_KEY: "" } });
    await pi.prompt("/jev-guard setup", { quietMs: 8000, timeoutMs: 120000 });
    const status = (await pi.prompt("/jev-guard status", { quietMs: 3000 })).notices.join("\n");
    await pi.stop();
    record("D2", "setup with no key offers a way out and honours it",
      "a three-way choice, then OFF for this session",
      `options=${JSON.stringify(offered)}`, offered.length > 0 && /jev-guard: OFF/.test(status));
  }

  /* ------------------------------------- D3 what a fresh session starts from */
  {
    const pi = new Pi({ name: "d3-restart" });
    const status = (await pi.prompt("/jev-guard status", { quietMs: 3000 })).notices.join("\n");
    await pi.stop();
    record("D3", "a fresh session reflects the saved setting, not the last session's choice",
      "ON from the shipped default",
      status.replace(/\s+/g, " ").slice(0, 160), /jev-guard: ON \(backend/.test(status));
  }

  /* --------------------------------------- D4 the install commands in the README */
  {
    const home2 = join(ROOT, "home2");
    rmSync(home2, { recursive: true, force: true });
    mkdirSync(join(home2, ".pi", "agent"), { recursive: true });
    // credentials and the model catalogue carry over; settings do not, because
    // the sandbox's own settings name a package by a path that is only valid there
    for (const f of ["auth.json", "models-store.json", "models.json"]) {
      const src = join(HOME, ".pi", "agent", f);
      if (existsSync(src)) cpSync(src, join(home2, ".pi", "agent", f));
    }
    writeFileSync(
      join(home2, ".pi", "agent", "settings.json"),
      JSON.stringify(
        { lastChangelogVersion: "0.85.1", defaultProvider: "openrouter", defaultModel: AGENT_MODEL, quietStartup: true, packages: [] },
        null,
        2,
      ),
    );
    const env = { ...process.env, HOME: home2, USERPROFILE: home2 };
    const tryInstall = (source) => {
      try {
        return { ok: true, out: execFileSync("pi", ["install", source], { env, cwd: REPO, encoding: "utf-8", timeout: 180000, shell: true }).trim() };
      } catch (e) {
        return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message) };
      }
    };

    // pi resolves a bare argument as a filesystem path, so the npm: prefix is
    // not optional. This scenario is here because the README once printed it
    // without one, and every new user starts with this command.
    const bare = tryInstall("specpi-jev-guard");
    const fromNpm = tryInstall("npm:specpi-jev-guard");
    record("D4", "`pi install npm:specpi-jev-guard`, exactly as the README prints it",
      "resolves and installs from npm; the bare name does not, and should not be documented",
      `npm: ${fromNpm.ok ? "ok" : "FAILED"} | bare name: ${bare.ok ? "also resolved" : "path error, as expected"} | ${fromNpm.out.slice(0, 160)}`,
      fromNpm.ok);

    if (fromNpm.ok) {
      const pi = new Pi({ name: "d5-published", env: { HOME: home2, USERPROFILE: home2 } });
      const status = (await pi.prompt("/jev-guard status", { quietMs: 4000 })).notices.join("\n");
      await pi.stop();
      // The registry copy, not this branch: what is on npm today is an earlier
      // release, and the tarball for this one is covered by every other batch.
      // What this proves is that an install by name produces a working extension.
      record("D5", "the copy already on npm loads in a clean pi home",
        "status answers from the npm copy, whichever version that is",
        `${fromNpm.out.replace(/\s+/g, " ").slice(0, 90)} | ${status.replace(/\s+/g, " ").slice(0, 140)}`,
        /jev-guard: (ON|OFF)/.test(status));
    }
  }

  /* ------------------------------------- D6 one session straight from a checkout */
  {
    const pi = new Pi({ name: "d6-dash-e", args: ["-ne", "-e", `"${join(REPO, "extensions", "jev-guard.ts")}"`] });
    const status = (await pi.prompt("/jev-guard status", { quietMs: 4000 })).notices.join("\n");
    await pi.stop();
    record("D6", "`pi -e ./extensions/jev-guard.ts` works from a checkout",
      "status answers with package discovery otherwise off",
      status.replace(/\s+/g, " ").slice(0, 200), /jev-guard: (ON|OFF)/.test(status));
  }

  return done();
}
