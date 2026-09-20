/**
 * pi-auth.ts — pure, dependency-free reading of a pi saved credential.
 *
 * Like risk-rules.ts this file has no imports, so the probe scripts can share
 * it with the extension and `node --test` can cover it directly. Reading
 * auth.json off disk stays with the caller: the extension delegates to pi's
 * own readStoredCredential (which honours the configured agent dir), while the
 * probe scripts read the file themselves rather than pay ~16s of module load
 * to import the pi package.
 *
 * Two credential shapes matter, and both come from `/login openrouter`:
 *   "Use an API key"          -> {type:"api_key", key, env?}
 *   "Sign in with OpenRouter" -> {type:"oauth", access, refresh, expires}
 * The OAuth option is not a bearer token that expires; OpenRouter's PKCE flow
 * exchanges the code for a permanent API key, which pi stores in `access` with
 * no `key` field at all.
 */

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function field(input: unknown, name: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  for (const [k, v] of Object.entries(input)) {
    if (k === name) return v;
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function lookupEnv(name: string, overlay: Record<string, string>, env: Record<string, string | undefined>): string | undefined {
  return overlay[name] || env[name] || undefined;
}

/**
 * Interpolate the `$NAME` / `${NAME}` references pi supports in a stored
 * api_key, mirroring resolveConfigValue: `$$` escapes a literal `$`, `$!`
 * escapes a literal `!`, a `$` that starts no valid name stays literal, and a
 * reference to an unset variable makes the whole value unresolvable.
 */
function interpolate(
  config: string,
  overlay: Record<string, string>,
  env: Record<string, string | undefined>,
): string | undefined {
  let out = "";
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf("$", index);
    if (dollar < 0) {
      out += config.slice(index);
      break;
    }
    out += config.slice(index, dollar);
    const next = config[dollar + 1];
    if (next === "$" || next === "!") {
      out += next;
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", dollar + 2);
      if (end < 0) {
        out += "$";
        index = dollar + 1;
        continue;
      }
      const name = config.slice(dollar + 2, end);
      if (ENV_VAR_NAME_RE.test(name)) {
        const value = lookupEnv(name, overlay, env);
        if (value === undefined) return undefined;
        out += value;
      } else {
        out += config.slice(dollar, end + 1);
      }
      index = end + 1;
      continue;
    }
    const match = config.slice(dollar + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      const value = lookupEnv(match[0], overlay, env);
      if (value === undefined) return undefined;
      out += value;
      index = dollar + 1 + match[0].length;
      continue;
    }
    out += "$";
    index = dollar + 1;
  }
  return out;
}

function envOverlay(credential: unknown): Record<string, string> {
  const raw = field(credential, "env");
  if (typeof raw !== "object" || raw === null) return {};
  const overlay: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") overlay[k] = v;
  }
  return overlay;
}

/**
 * The usable key in a stored pi credential, or undefined when there is none.
 *
 * A `!command` api_key is declined rather than sent as a literal: pi resolves
 * those by shelling out, which is not something to do inline on a gated tool
 * call, and passing the raw string through would ship the command text to the
 * classifier host as a bearer token. Declining surfaces an honest "no key"
 * instead of an opaque 401.
 */
export function credentialKey(
  credential: unknown,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const type = field(credential, "type");
  if (type === "oauth") return nonEmpty(field(credential, "access"));
  if (type !== "api_key") return undefined;
  const raw = nonEmpty(field(credential, "key"));
  if (raw === undefined || raw.startsWith("!")) return undefined;
  return nonEmpty(interpolate(raw, envOverlay(credential), env));
}
