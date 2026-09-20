/**
 * audit-display.test.mjs — the wiring `rules.test.mjs` cannot reach.
 *
 * `auditDisplay` is decided in jev-guard.ts, not in the pure rules module: the
 * entry renderer gets no context and reads a cached mode, and the footer line
 * is written from inside `audit()`. So this drives the real extension against
 * a fake pi host and a hard-deny command, which needs no key and no network.
 *
 * The claim under test, in every mode: the record still reaches the session
 * file. Only its display moves.
 */
import { describe, it, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point homedir() at a scratch directory before the extension is imported, so
// the global settings file under test is ours and not the developer's.
const HOME = mkdtempSync(join(tmpdir(), "jev-guard-home-"));
process.env["HOME"] = HOME;
process.env["USERPROFILE"] = HOME;
mkdirSync(join(HOME, ".pi"), { recursive: true });
const SETTINGS = join(HOME, ".pi", "jev-guard.json");

const THEME = {
  bg: (_key, text) => text,
  fg: (_key, text) => text,
  bold: (text) => text,
};

let extension;

/** A pi host that records what the extension does to it. */
function fakeHost() {
  const host = {
    entries: [],
    entryLog: [],
    statuses: [],
    notices: [],
    handlers: new Map(),
    command: undefined,
    renderer: undefined,
    api: undefined,
    ctx: undefined,
  };
  host.api = {
    on: (event, handler) => host.handlers.set(event, handler),
    registerCommand: (_name, spec) => (host.command = spec),
    registerEntryRenderer: (_type, renderer) => (host.renderer = renderer),
    appendEntry: (customType, data) => host.entries.push({ customType, data }),
  };
  host.ctx = {
    cwd: HOME,
    hasUI: true,
    signal: undefined,
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [], getEntries: () => host.entryLog },
    ui: {
      setStatus: (key, text) => host.statuses.push({ key, text }),
      notify: (message, level) => host.notices.push({ message, level }),
      select: async () => undefined,
    },
  };
  return host;
}

function settings(patch) {
  writeFileSync(SETTINGS, JSON.stringify(patch, null, 2) + "\n", "utf-8");
}

/** Boot a host with the extension loaded and session_start already fired. */
async function boot(patch) {
  settings(patch);
  const host = fakeHost();
  extension(host.api);
  await host.handlers.get("session_start")({ type: "session_start", reason: "startup" }, host.ctx);
  return host;
}

/** A hard-deny command: decided by local rules, so no key and no network. */
async function denyOneCall(host) {
  return await host.handlers.get("tool_call")(
    { toolName: "bash", input: { command: "rm -rf /" } },
    host.ctx,
  );
}

function render(host) {
  const entry = { customType: "jev-guard", data: host.entries.at(-1).data };
  return host.renderer(entry, { expanded: false }, THEME);
}

before(async () => {
  extension = (await import("../extensions/jev-guard.ts")).default;
});

beforeEach(() => {
  if (existsSync(SETTINGS)) rmSync(SETTINGS);
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("auditDisplay", () => {
  it("defaults to the line in the transcript it has always had", async () => {
    const host = await boot({});
    await denyOneCall(host);
    assert.equal(host.entries.length, 1);
    assert.notEqual(render(host), undefined);
    assert.equal(host.statuses.at(-1).text, "jev 0 · 1 blocked", "the footer counts but does not narrate");
  });

  it("status mode writes one footer line and nothing in the transcript", async () => {
    const host = await boot({ auditDisplay: "status" });
    await denyOneCall(host);
    assert.equal(host.entries.length, 1, "the record still reaches the session file");
    assert.equal(render(host), undefined, "nothing is added to the transcript");
    assert.equal(host.statuses.at(-1).text, "jev 0 · 1 blocked · bash blocked");
  });

  it("off mode shows no record anywhere, and still records", async () => {
    const host = await boot({ auditDisplay: "off" });
    await denyOneCall(host);
    assert.equal(host.entries.length, 1);
    assert.equal(render(host), undefined);
    assert.equal(host.statuses.at(-1).text, "jev 0 · 1 blocked", "the count is not a record");
  });

  it("blocks stay loud in every mode", async () => {
    for (const mode of ["transcript", "status", "off"]) {
      const host = await boot({ auditDisplay: mode });
      const verdict = await denyOneCall(host);
      assert.equal(verdict.block, true, mode);
      assert.ok(
        host.notices.some((n) => n.level === "error" && n.message.includes("blocked")),
        `${mode}: no notification`,
      );
    }
  });

  it("reads a settings file that Notepad or PowerShell wrote, BOM and all", async () => {
    // A UTF-8 BOM makes JSON.parse throw. Without stripping it the whole file
    // is dropped, silently, and every setting in it with it.
    const host = fakeHost();
    writeFileSync(SETTINGS, "﻿" + JSON.stringify({ auditDisplay: "off" }), "utf-8");
    extension(host.api);
    await host.handlers.get("session_start")({ type: "session_start", reason: "startup" }, host.ctx);
    await denyOneCall(host);
    assert.equal(render(host), undefined, "the BOM hid the setting");
  });

  it("an unknown value in the settings file leaves the default standing", async () => {
    const host = await boot({ auditDisplay: "footer" });
    await denyOneCall(host);
    assert.notEqual(render(host), undefined);
  });

  it("the latest verdict replaces the last one rather than stacking up", async () => {
    const host = await boot({ auditDisplay: "status" });
    await denyOneCall(host);
    await denyOneCall(host);
    assert.equal(host.entries.length, 2);
    assert.equal(host.statuses.at(-1).text, "jev 0 · 2 blocked · bash blocked");
    const keys = new Set(host.statuses.map((s) => s.key));
    assert.equal(keys.size, 1, "one key, so the footer overwrites instead of growing");
  });
});

describe("the footer counter", () => {
  it("counts classifier calls apart from the calls it stopped", async () => {
    const host = fakeHost();
    host.entryLog = [
      { type: "custom", customType: "jev-guard", data: { tool: "bash", decision: "allowed", source: "jev", danger: 0.02 } },
      { type: "custom", customType: "jev-guard", data: { tool: "bash", decision: "blocked", source: "jev", danger: 0.93 } },
      { type: "custom", customType: "jev-guard", data: { tool: "bash", decision: "blocked", source: "rules" } },
      { type: "message", message: { role: "user" } },
    ];
    settings({});
    extension(host.api);
    await host.handlers.get("session_start")({ type: "session_start", reason: "resume" }, host.ctx);
    // Two calls reached the classifier; three decisions, two of them stops.
    assert.equal(host.statuses.at(-1).text, "jev 2 · 2 blocked");
  });

  it("is gone while the guard is off, and back when it is on", async () => {
    const host = await boot({});
    await host.command.handler("off", host.ctx);
    assert.equal(host.statuses.at(-1).text, undefined);
    await host.command.handler("on", host.ctx);
    assert.equal(host.statuses.at(-1).text, "jev 0");
  });
});

describe("/jev-guard audit", () => {
  it("saves the mode and applies it without a restart", async () => {
    const host = await boot({});
    await host.command.handler("audit off", host.ctx);
    assert.equal(JSON.parse(readFileSync(SETTINGS, "utf-8")).auditDisplay, "off");
    await denyOneCall(host);
    assert.equal(host.entries.length, 1);
    assert.equal(render(host), undefined);
  });

  it("drops the verdict but keeps the count when leaving status mode", async () => {
    const host = await boot({ auditDisplay: "status" });
    await denyOneCall(host);
    assert.ok(host.statuses.at(-1).text.includes("bash blocked"));
    await host.command.handler("audit transcript", host.ctx);
    assert.equal(host.statuses.at(-1).text, "jev 0 · 1 blocked", "no verdict outlives its call");
  });

  it("clears the footer when the guard is switched off", async () => {
    const host = await boot({ auditDisplay: "status" });
    await denyOneCall(host);
    await host.command.handler("off", host.ctx);
    assert.equal(host.statuses.at(-1).text, undefined);
  });

  it("rejects a mode it does not have", async () => {
    const host = await boot({});
    await host.command.handler("audit footer", host.ctx);
    assert.ok(host.notices.some((n) => n.level === "error" && n.message.includes("Usage:")));
    assert.equal(existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf-8")).auditDisplay : undefined, undefined);
  });
});
