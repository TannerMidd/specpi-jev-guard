/**
 * pi-auth.test.mjs — regression cover for reading pi's saved auth.
 *
 * The bug this guards: `/login openrouter` -> "Sign in with OpenRouter"
 * stores {type:"oauth", access} with no `key` field, so a reader that only
 * accepted {type:"api_key", key} silently found nothing and every probe
 * reported "no key" for a user who was signed in.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPiAuthKey } from "./pi-auth.mjs";
import { credentialKey } from "../extensions/pi-auth.ts";

let dir;
const saved = process.env.PI_CODING_AGENT_DIR;

function writeAuth(contents) {
  writeFileSync(join(dir, "auth.json"), contents, "utf-8");
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-auth-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});

after(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("readPiAuthKey", () => {
  it('reads "Use an API key" credentials', () => {
    writeAuth(JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-api" } }));
    assert.equal(readPiAuthKey("openrouter"), "sk-or-api");
  });

  it('reads "Sign in with OpenRouter" credentials, which have no key field', () => {
    writeAuth(
      JSON.stringify({
        openrouter: { type: "oauth", access: "sk-or-oauth", refresh: "", expires: Number.MAX_SAFE_INTEGER },
      }),
    );
    assert.equal(readPiAuthKey("openrouter"), "sk-or-oauth");
  });

  it("trims surrounding whitespace", () => {
    writeAuth(JSON.stringify({ openrouter: { type: "oauth", access: "  sk-or-pad  " } }));
    assert.equal(readPiAuthKey("openrouter"), "sk-or-pad");
  });

  it("returns undefined for a provider with no entry", () => {
    writeAuth(JSON.stringify({ openrouter: { type: "oauth", access: "sk-or-oauth" } }));
    assert.equal(readPiAuthKey("typesafe"), undefined);
  });

  it("returns undefined for a blank or missing credential value", () => {
    writeAuth(JSON.stringify({ openrouter: { type: "oauth", access: "   " } }));
    assert.equal(readPiAuthKey("openrouter"), undefined);
    writeAuth(JSON.stringify({ openrouter: { type: "api_key" } }));
    assert.equal(readPiAuthKey("openrouter"), undefined);
  });

  it("returns undefined for an unknown credential type", () => {
    writeAuth(JSON.stringify({ openrouter: { type: "device_code", access: "sk-or-oauth" } }));
    assert.equal(readPiAuthKey("openrouter"), undefined);
  });

  it("returns undefined rather than throwing on malformed or missing auth.json", () => {
    writeAuth("{ not json");
    assert.equal(readPiAuthKey("openrouter"), undefined);
    process.env.PI_CODING_AGENT_DIR = join(dir, "nope");
    assert.equal(readPiAuthKey("openrouter"), undefined);
    process.env.PI_CODING_AGENT_DIR = dir;
  });
});

describe("credentialKey config values", () => {
  it("interpolates $NAME and ${NAME} from the environment", () => {
    const env = { OR_KEY: "sk-or-env" };
    assert.equal(credentialKey({ type: "api_key", key: "$OR_KEY" }, env), "sk-or-env");
    assert.equal(credentialKey({ type: "api_key", key: "${OR_KEY}" }, env), "sk-or-env");
    assert.equal(credentialKey({ type: "api_key", key: "pre-${OR_KEY}-post" }, env), "pre-sk-or-env-post");
  });

  it("prefers the credential's own env overlay over the process env", () => {
    const cred = { type: "api_key", key: "$OR_KEY", env: { OR_KEY: "sk-or-overlay" } };
    assert.equal(credentialKey(cred, { OR_KEY: "sk-or-ambient" }), "sk-or-overlay");
  });

  it("declines when a referenced variable is unset, rather than sending a literal", () => {
    assert.equal(credentialKey({ type: "api_key", key: "$NOPE_NOT_SET" }, {}), undefined);
  });

  it("honours the $$ and $! escapes", () => {
    assert.equal(credentialKey({ type: "api_key", key: "sk-$$-literal" }, {}), "sk-$-literal");
    assert.equal(credentialKey({ type: "api_key", key: "$!not-a-command" }, {}), "!not-a-command");
  });

  it("leaves a lone $ that starts no valid name alone", () => {
    assert.equal(credentialKey({ type: "api_key", key: "sk-100$-x" }, {}), "sk-100$-x");
  });

  it("declines a !command key instead of sending the command text as a token", () => {
    assert.equal(credentialKey({ type: "api_key", key: "!op read op://vault/openrouter/key" }, {}), undefined);
  });

  it("does not interpolate an oauth access token", () => {
    assert.equal(credentialKey({ type: "oauth", access: "sk-or-$literal" }, {}), "sk-or-$literal");
  });

  it("returns undefined for junk input", () => {
    for (const junk of [undefined, null, "string", 42, {}, { type: "api_key", key: 7 }]) {
      assert.equal(credentialKey(junk, {}), undefined);
    }
  });
});
