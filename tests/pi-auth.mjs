/**
 * pi-auth.mjs — read a provider key from pi's saved auth.json.
 *
 * Lets `npm run live` / `npm run matrix` run off `/login openrouter` with no
 * .env file. The credential shapes are handled by extensions/pi-auth.ts, which
 * the extension shares; only locating auth.json is done here.
 *
 * The agent dir follows PI_CODING_AGENT_DIR when set, else ~/.pi/agent. A
 * rebranded pi build with its own configDir is not covered; set that env var
 * in that case. The extension delegates to pi's own readStoredCredential
 * instead, but importing the pi package costs ~16s of module load, which is
 * too much for a probe script.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { credentialKey } from "../extensions/pi-auth.ts";

function agentDir() {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".pi", "agent");
}

/** The saved key for `providerId`, or undefined when there is no usable one. */
export function readPiAuthKey(providerId) {
  try {
    const data = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf-8"));
    return credentialKey(data?.[providerId]);
  } catch {
    // No saved auth, or unreadable; fall through to no key.
  }
  return undefined;
}
