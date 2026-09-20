/**
 * setup.mjs — build a throwaway pi installation to test the packed extension in.
 *
 * Nothing here touches your real ~/.pi: the sandbox gets its own HOME, its own
 * settings, its own session store, and a fixture project to work in. The
 * extension under test is the npm tarball, not the working tree, so what is
 * tested is what would ship.
 *
 *   node tests/e2e/setup.mjs            # -> %TEMP%/jev-guard-e2e
 *   JEV_E2E_DIR=/some/path node tests/e2e/setup.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readPiAuthKey } from "../pi-auth.mjs";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const ROOT = process.env.JEV_E2E_DIR || join(tmpdir(), "jev-guard-e2e");
export const HOME = join(ROOT, "home");
export const PROJ = join(ROOT, "proj");
export const PKG = join(ROOT, "pkg");
export const LOGS = join(ROOT, "logs");
export const SESSIONS = join(ROOT, "sessions");

/** The agent pi drives during the run. Not the classifier: that is Jev. */
export const AGENT_MODEL = process.env.JEV_E2E_MODEL || "deepseek/deepseek-v4.1-flash";

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf-8", shell: true, timeout: 300000, ...opts });

/** OpenRouter key: environment first, then .env, then pi's own saved auth. */
export function resolveKey() {
  const fromEnv = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const envFile = join(REPO, ".env");
  if (existsSync(envFile)) {
    const m = /^\s*OPENROUTER_API_KEY=(.+)$/m.exec(readFileSync(envFile, "utf-8"));
    if (m) return m[1].trim();
  }
  return readPiAuthKey("openrouter") ?? "";
}

const MARKER = "jev-guard-e2e.marker";

/**
 * The sandbox is deleted and rebuilt on every run, so refuse to point that at
 * anything that is not already a sandbox. JEV_E2E_DIR=$HOME should be a clear
 * error, not a wiped home directory.
 */
function assertDisposable(dir) {
  const resolved = resolve(dir);
  const forbidden = [resolve(homedir()), resolve(REPO), parse(resolved).root];
  if (forbidden.some((f) => resolve(f) === resolved)) {
    throw new Error(`refusing to use ${resolved} as the e2e sandbox: it is your home, the repo, or a drive root`);
  }
  if (relative(parse(resolved).root, resolved).split(sep).filter(Boolean).length < 2) {
    throw new Error(`refusing to use ${resolved} as the e2e sandbox: too close to the drive root`);
  }
  if (existsSync(resolved) && !existsSync(join(resolved, MARKER))) {
    throw new Error(
      `${resolved} already exists and was not created by this harness (no ${MARKER}). ` +
        `Delete it yourself, or point JEV_E2E_DIR somewhere else.`,
    );
  }
}

/**
 * The sandbox keeps a real OpenRouter key on disk so pi can log in as itself.
 * Take it back out when the run is over; the logs and the results are what is
 * worth keeping.
 */
export function scrubSecrets() {
  for (const f of [join(HOME, ".pi", "agent", "auth.json"), join(ROOT, "home2", ".pi", "agent", "auth.json")]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

/**
 * Windows holds a handle on a directory that is some process's cwd, so the
 * fixture is emptied from the inside rather than deleted, with a short retry
 * for the moment after a pi child exits.
 */
function rmRetry(target, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === tries - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
}

/** A small, realistic project: something to build, something worth protecting. */
function writeFixture() {
  mkdirSync(PROJ, { recursive: true });
  for (const entry of readdirSync(PROJ)) rmRetry(join(PROJ, entry));
  mkdirSync(join(PROJ, "src"), { recursive: true });
  mkdirSync(join(PROJ, "dist"), { recursive: true });
  mkdirSync(join(PROJ, ".ssh"), { recursive: true });
  const files = {
    "package.json": JSON.stringify(
      { name: "demo-app", version: "1.0.0", type: "module", scripts: { build: "node src/build.js", test: "node --test" } },
      null,
      2,
    ),
    "README.md": "# demo-app\nA tiny project used to exercise the jev-guard extension.\n",
    "src/index.js": "export function greet(name) {\n  return `hello ${name}`;\n}\n",
    "src/build.js": 'console.log("built");\n',
    "dist/old.js": "stale\n",
    ".env": "API_TOKEN=sk-live-FAKE-not-a-real-secret-0000\nDB_URL=postgres://user:pw@localhost/db\n",
    ".ssh/id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEYMATERIALFORTESTINGONLY\n-----END OPENSSH PRIVATE KEY-----\n",
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(PROJ, rel), body, "utf-8");
}

export function buildSandbox({ quiet = false } = {}) {
  const say = (m) => !quiet && console.log(m);
  const key = resolveKey();
  if (!key) {
    console.error(
      "No OpenRouter key found. Set OPENROUTER_API_KEY, add it to .env, or run /login openrouter in pi first.",
    );
    process.exit(1);
  }

  assertDisposable(ROOT);
  rmRetry(ROOT);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, MARKER), "created by tests/e2e/setup.mjs; safe to delete\n");
  for (const d of [join(HOME, ".pi", "agent"), PKG, LOGS, SESSIONS]) mkdirSync(d, { recursive: true });

  // 1. the artefact under test: exactly what `npm publish` would upload
  say("packing the extension...");
  const packed = sh("npm", ["pack", "--pack-destination", `"${ROOT}"`], { cwd: REPO })
    .trim()
    .split("\n")
    .at(-1)
    .trim();
  sh("tar", ["-xzf", `"${packed}"`, "-C", `"${PKG}"`, "--strip-components=1"], { cwd: ROOT });

  // 2. a pi home of its own
  writeFileSync(join(HOME, ".pi", "agent", "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key } }, null, 2));
  writeFileSync(
    join(HOME, ".pi", "agent", "settings.json"),
    JSON.stringify(
      {
        lastChangelogVersion: "0.85.1",
        defaultProvider: "openrouter",
        defaultModel: AGENT_MODEL,
        defaultThinkingLevel: "off",
        quietStartup: true,
        packages: [],
      },
      null,
      2,
    ),
  );
  // reuse the real model catalogue when there is one, so the sandbox can stay offline for it
  for (const f of ["models-store.json", "models.json"]) {
    const src = join(homedir(), ".pi", "agent", f);
    if (existsSync(src)) cpSync(src, join(HOME, ".pi", "agent", f));
  }

  writeFixture();

  // 3. install the packed extension into that home
  say("installing the packed extension into the sandbox...");
  const env = { ...process.env, HOME, USERPROFILE: HOME };
  sh("pi", ["install", `"${PKG}"`], { cwd: PROJ, env });
  const listed = sh("pi", ["list"], { cwd: PROJ, env });
  if (!listed.includes("pkg")) throw new Error(`extension did not install:\n${listed}`);

  say(`sandbox ready at ${ROOT}`);
  return { ROOT, HOME, PROJ, PKG, LOGS, SESSIONS, packed };
}

/** Reset the fixture between batches without reinstalling anything. */
export function resetFixture() {
  writeFixture();
  rmSync(join(HOME, ".pi", "jev-guard.json"), { force: true });
  if (existsSync(SESSIONS)) for (const d of readdirSync(SESSIONS)) rmRetry(join(SESSIONS, d));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) buildSandbox();
