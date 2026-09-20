/**
 * jev-guard — Pi extension: fast dangerous-command classification with Jev.
 *
 * Cascade per tool call (bash / powershell / write / edit):
 *   1. Local rules first (instant, offline): hard-deny list, read-only
 *      fast-pass, user safe/allowed/disallowed lists. Jev is never consulted
 *      for these, so it cannot overrule them.
 *   2. Everything else goes to Jev via OpenRouter (`~typesafe/jev-latest`
 *      by default) which returns a danger probability. High danger blocks,
 *      middle band asks the user, low danger runs.
 *   3. Fail closed: no API key, network error, or unparseable verdict never
 *      silently passes an unvouched call.
 *
 * The classifier key comes from pi's saved auth (auth.json via
 * `/login openrouter`) or the environment, resolved fresh on every call —
 * a mid-session /login or /logout takes effect with no restart.
 *
 * Outbound payloads are bounded (command/path + cwd + latest user prompt)
 * and secrets are redacted locally before anything leaves the machine.
 */

import { CONFIG_DIR_NAME, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { credentialKey } from "./pi-auth.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  bandFor,
  buildSystemOneBody,
  classifyCommandLocal,
  formatAuditLine,
  formatGuardStatus,
  isProtectedPath,
  middleBandWithoutUI,
  openRouterDecisionsUrl,
  parseAuditDisplay,
  parseSystemOneResponse,
  relativePosix,
  resolveEnabled,
  truncate,
} from "./risk-rules.ts";
import type { AuditDisplay, Backend, ClassifyInput, GuardSettings, JevVerdict } from "./risk-rules.ts";

const SETTINGS_FILE = "jev-guard.json";
const AUDIT_TYPE = "jev-guard";
const GATED_TOOLS = new Set(["bash", "powershell", "write", "edit"]);
/** Anything else after /jev-guard is a typo, not a request for status. */
const KNOWN_SUBCOMMANDS = new Set(["status", "setup", "on", "off", "check", "model", "backend", "audit"]);
const CACHE_LIMIT = 200;

interface AuditRecord {
  tool: string;
  subject: string;
  decision: string;
  source: string;
  danger?: number;
  category?: string;
  detail?: string;
  model?: string;
  latencyMs?: number;
  at: number;
}

interface JevOutcome {
  verdict: JevVerdict | null;
  modelUsed?: string;
  latencyMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Small untyped-access helpers (avoid casts; keep tsc happy without tool types)
// ---------------------------------------------------------------------------

function field(input: unknown, name: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  for (const [k, v] of Object.entries(input)) {
    if (k === name) return v;
  }
  return undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string") {
        parts.push(p.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Most recent user message text on the active branch (for intent context). */
function lastUserPrompt(ctx: ExtensionContext): string {
  try {
    const branch: unknown = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) return "";
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (typeof entry !== "object" || entry === null || !("message" in entry)) continue;
      const message = entry.message;
      if (typeof message !== "object" || message === null) continue;
      if (!("role" in message) || message.role !== "user") continue;
      if (!("content" in message)) continue;
      const text = contentToText(message.content).trim();
      if (text !== "") return truncate(text, 500);
    }
  } catch {
    // Intent context is best-effort; never break the gate on it.
  }
  return "";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readJsonFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    // Strip a UTF-8 BOM: Notepad and PowerShell's Set-Content write one, and
    // JSON.parse throws on it, which would silently drop the whole file.
    const text = readFileSync(path, "utf-8").replace(/^﻿/, "");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) out[k] = v;
      return out;
    }
  } catch {
    // Corrupt settings files fall back to defaults rather than breaking runs.
  }
  return {};
}

function globalSettingsPath(): string {
  return join(homedir(), CONFIG_DIR_NAME, SETTINGS_FILE);
}

function applyPatch(target: GuardSettings, patch: Record<string, unknown>): void {
  if (typeof patch["enabled"] === "boolean") target.enabled = patch["enabled"];
  if (patch["backend"] === "openrouter" || patch["backend"] === "typesafe") {
    target.backend = patch["backend"];
  }
  if (typeof patch["model"] === "string" && patch["model"] !== "") target.model = patch["model"];
  if (typeof patch["fallbackModel"] === "string" && patch["fallbackModel"] !== "") {
    target.fallbackModel = patch["fallbackModel"];
  }
  if (typeof patch["baseUrl"] === "string" && patch["baseUrl"] !== "") {
    target.baseUrl = patch["baseUrl"].replace(/\/+$/, "");
  }
  if (typeof patch["typesafeModel"] === "string" && patch["typesafeModel"] !== "") {
    target.typesafeModel = patch["typesafeModel"];
  }
  if (typeof patch["typesafeBaseUrl"] === "string" && patch["typesafeBaseUrl"] !== "") {
    target.typesafeBaseUrl = patch["typesafeBaseUrl"].replace(/\/+$/, "");
  }
  if (typeof patch["timeoutMs"] === "number" && patch["timeoutMs"] > 0) {
    target.timeoutMs = Math.min(60000, patch["timeoutMs"]);
  }
  if (typeof patch["askThreshold"] === "number") target.askThreshold = clamp01(patch["askThreshold"]);
  if (typeof patch["blockThreshold"] === "number") target.blockThreshold = clamp01(patch["blockThreshold"]);
  if (patch["uncertain"] === "allow" || patch["uncertain"] === "ask" || patch["uncertain"] === "deny") {
    target.uncertain = patch["uncertain"];
  }
  const display = parseAuditDisplay(patch["auditDisplay"]);
  if (display) target.auditDisplay = display;
  for (const key of ["safeCommands", "allowedCommands", "disallowedCommands", "protectedPaths"] as const) {
    const value = patch[key];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      target[key] = [...value];
    }
  }
}

function clamp01(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function loadSettings(ctx: ExtensionContext): GuardSettings {
  const settings: GuardSettings = {
    ...DEFAULT_SETTINGS,
    safeCommands: [...DEFAULT_SETTINGS.safeCommands],
    allowedCommands: [...DEFAULT_SETTINGS.allowedCommands],
    disallowedCommands: [...DEFAULT_SETTINGS.disallowedCommands],
    protectedPaths: [...DEFAULT_SETTINGS.protectedPaths],
  };
  applyPatch(settings, readJsonFile(globalSettingsPath()));
  if (ctx.isProjectTrusted()) {
    applyPatch(settings, readJsonFile(join(ctx.cwd, CONFIG_DIR_NAME, SETTINGS_FILE)));
  }
  const env = process.env;
  if (env["JEV_GUARD_BACKEND"] === "openrouter" || env["JEV_GUARD_BACKEND"] === "typesafe") {
    settings.backend = env["JEV_GUARD_BACKEND"];
  }
  if (typeof env["JEV_GUARD_MODEL"] === "string" && env["JEV_GUARD_MODEL"] !== "") {
    settings.model = env["JEV_GUARD_MODEL"];
  }
  if (typeof env["JEV_GUARD_BASE_URL"] === "string" && env["JEV_GUARD_BASE_URL"] !== "") {
    settings.baseUrl = env["JEV_GUARD_BASE_URL"].replace(/\/+$/, "");
  }
  if (typeof env["JEV_GUARD_TYPESAFE_MODEL"] === "string" && env["JEV_GUARD_TYPESAFE_MODEL"] !== "") {
    settings.typesafeModel = env["JEV_GUARD_TYPESAFE_MODEL"];
  }
  if (typeof env["JEV_GUARD_TYPESAFE_BASE_URL"] === "string" && env["JEV_GUARD_TYPESAFE_BASE_URL"] !== "") {
    settings.typesafeBaseUrl = env["JEV_GUARD_TYPESAFE_BASE_URL"].replace(/\/+$/, "");
  }
  if (typeof env["JEV_GUARD_TIMEOUT_MS"] === "string" && env["JEV_GUARD_TIMEOUT_MS"] !== "") {
    const n = Number(env["JEV_GUARD_TIMEOUT_MS"]);
    if (Number.isFinite(n) && n > 0) settings.timeoutMs = Math.min(60000, n);
  }
  if (settings.askThreshold > settings.blockThreshold) {
    settings.askThreshold = settings.blockThreshold;
  }
  return settings;
}

function saveGlobalSettings(patch: Record<string, unknown>): void {
  const path = globalSettingsPath();
  const current = readJsonFile(path);
  for (const [k, v] of Object.entries(patch)) current[k] = v;
  mkdirSync(join(homedir(), CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n", "utf-8");
}

function readEnvKey(name: string): string | undefined {
  const key = process.env[name];
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

/** Where the classifier key came from (shown in status/setup). */
type KeySource = "env" | "pi-auth";

/** A resolved classifier key plus where it came from. */
type ResolvedKey = { key: string | undefined; source: KeySource | "none" };

function providerIdFor(backend: Backend): string {
  return backend === "typesafe" ? "typesafe" : "openrouter";
}

/** Synchronous read of pi's saved auth.json (no registry needed). */
function storedApiKey(providerId: string): string | undefined {
  try {
    return credentialKey(readStoredCredential(providerId));
  } catch {
    // Saved-auth read is best-effort; fall through to no key.
  }
  return undefined;
}

/**
 * Resolve the classifier key for the active backend. Pi's own registry
 * (auth.json login + env + refresh) is tried first so the guard uses the
 * same credential as the chat model. That order is pi's own rule, not an
 * inversion of it: "a stored credential owns the provider; ambient/env is
 * consulted only when nothing is stored" (pi-ai resolveProviderAuth). A
 * saved /login therefore beats an exported key, as it does everywhere else
 * in pi. Env and a direct auth.json read are
 * fallbacks for contexts without a registry (and for the typesafe backend,
 * which has no pi provider). Resolved per call, never cached, so a
 * mid-session /login or /logout takes effect immediately.
 */
async function resolveActiveKey(
  ctx: ExtensionContext,
  settings: GuardSettings,
): Promise<ResolvedKey> {
  const providerId = providerIdFor(settings.backend);
  const envName = keyEnvName(settings.backend);
  try {
    const viaRegistry = await ctx.modelRegistry?.getApiKeyForProvider(providerId);
    if (typeof viaRegistry === "string" && viaRegistry.trim() !== "") {
      const trimmed = viaRegistry.trim();
      const envKey = readEnvKey(envName);
      return { key: trimmed, source: envKey !== undefined && trimmed === envKey ? "env" : "pi-auth" };
    }
  } catch {
    // Fall through to env + stored reads below.
  }
  const envKey = readEnvKey(envName);
  if (envKey !== undefined) return { key: envKey, source: "env" };
  const stored = storedApiKey(providerId);
  if (stored !== undefined) return { key: stored, source: "pi-auth" };
  return { key: undefined, source: "none" };
}

function keyEnvName(backend: Backend): string {
  return backend === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
}

// ---------------------------------------------------------------------------
// Jev via OpenRouter (decisions endpoint, same SystemOne state/questions shape
// as the TypeSafe direct backend)
// ---------------------------------------------------------------------------

async function postDecisions(
  settings: GuardSettings,
  model: string,
  input: ClassifyInput,
  key: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const response = await fetch(openRouterDecisionsUrl(settings.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pi.dev",
      "X-Title": "specpi-jev-guard",
    },
    body: buildSystemOneBody(model, input),
    signal,
  });
  return { status: response.status, body: await response.text() };
}

function decisionsOutcome(status: number, body: string, startedAt: number): JevOutcome {
  const parsed = parseSystemOneResponse(status, body);
  if (!parsed.ok) return { verdict: null, latencyMs: Date.now() - startedAt, error: parsed.error };
  return { verdict: parsed.verdict, modelUsed: parsed.model, latencyMs: Date.now() - startedAt };
}

function shouldRetryWithFallback(model: string, settings: GuardSettings, outcome: JevOutcome): boolean {
  return (
    model !== settings.fallbackModel &&
    typeof outcome.error === "string" &&
    /404|no such model|model .* not found|model .* does not exist/i.test(outcome.error)
  );
}

async function classifyViaOpenRouter(
  settings: GuardSettings,
  input: ClassifyInput,
  key: string,
  signal: AbortSignal,
  startedAt: number,
): Promise<JevOutcome> {
  const first = await postDecisions(settings, settings.model, input, key, signal);
  const outcome = decisionsOutcome(first.status, first.body, startedAt);
  if (!outcome.verdict && shouldRetryWithFallback(settings.model, settings, outcome)) {
    const second = await postDecisions(settings, settings.fallbackModel, input, key, signal);
    return decisionsOutcome(second.status, second.body, startedAt);
  }
  return outcome;
}

async function classifyViaTypesafe(
  settings: GuardSettings,
  input: ClassifyInput,
  key: string,
  signal: AbortSignal,
  startedAt: number,
): Promise<JevOutcome> {
  const response = await fetch(`${settings.typesafeBaseUrl}/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: buildSystemOneBody(settings.typesafeModel, input),
    signal,
  });
  const body = await response.text();
  const parsed = parseSystemOneResponse(response.status, body);
  if (!parsed.ok) return { verdict: null, latencyMs: Date.now() - startedAt, error: parsed.error };
  return { verdict: parsed.verdict, modelUsed: parsed.model, latencyMs: Date.now() - startedAt };
}

async function classifyWithJev(
  settings: GuardSettings,
  input: ClassifyInput,
  key: string,
  parentSignal: AbortSignal | undefined,
): Promise<JevOutcome> {
  const signals: AbortSignal[] = [AbortSignal.timeout(settings.timeoutMs)];
  if (parentSignal) signals.push(parentSignal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const startedAt = Date.now();
  try {
    if (settings.backend === "typesafe") {
      return await classifyViaTypesafe(settings, input, key, signal, startedAt);
    }
    return await classifyViaOpenRouter(settings, input, key, signal, startedAt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = signal.aborted || /abort|timeout/i.test(message);
    return {
      verdict: null,
      latencyMs: Date.now() - startedAt,
      error: timedOut ? `request timed out after ${settings.timeoutMs}ms` : `request failed: ${truncate(message, 160)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Guided in-session setup: key check -> backend -> live self-test -> on/off.
// ---------------------------------------------------------------------------

function keySetupHelp(backend: Backend): string {
  const need = keyEnvName(backend);
  const login =
    backend === "openrouter"
      ? `Fastest: in pi, run /login openrouter and pick "Sign in with OpenRouter" (or "Use an API key").\n` +
        `The key is saved in pi's auth.json and the guard picks it up immediately, no restart needed.\n\nAlternatively, set ${need}`
      : `Set ${need}`;
  return (
    `${login} in pi's environment before launching pi (a .env file is not picked up):\n` +
    `  bash/macOS:  export ${need}="..."   (persist: ~/.bashrc or ~/.zshrc)\n` +
    `  PowerShell:  $env:${need}="..."     (persist: $PROFILE, or setx ${need} "...")\n` +
    `Going the env route means restarting pi, then re-run /jev-guard setup.\n` +
    `Never paste the key into chat.`
  );
}

async function setupSelfTest(
  ctx: ExtensionContext,
  settings: GuardSettings,
  key: string | undefined,
): Promise<void> {
  if (!key) {
    ctx.ui.notify(
      "Skipping live self-test (no key). Without a key the guard fails closed: unvouched calls block with setup hints instead of running silently.",
      "warning",
    );
    return;
  }
  ctx.ui.notify("Probing Jev with two sample commands…", "info");
  for (const cmd of ["npm test", "npm publish --access public"]) {
    const outcome = await classifyWithJev(
      settings,
      { kind: "bash", subject: cmd, cwd: ctx.cwd, userPrompt: "" },
      key,
      ctx.signal ?? undefined,
    );
    if (!outcome.verdict) {
      ctx.ui.notify(
        `self-test: Jev unreachable on "${cmd}" (${outcome.error ?? "unknown error"}): the guard will fail closed.`,
        "error",
      );
      return;
    }
    const band = bandFor(outcome.verdict.danger, settings);
    ctx.ui.notify(
      `self-test: "${cmd}" → danger ${outcome.verdict.danger.toFixed(2)} (${band})` +
        `[${outcome.modelUsed ?? "?"} ${outcome.latencyMs}ms]`,
      band === "allow" ? "info" : "warning",
    );
  }
}

async function runSetup(ctx: ExtensionContext, session: { enabled: boolean | undefined }): Promise<void> {
  const stateLines = (s: GuardSettings, resolved: ResolvedKey): string[] => {
    const eff = resolveEnabled(s.enabled, session.enabled);
    const keyState = resolved.key ? `set (${resolved.source === "env" ? "env" : "pi auth"})` : "MISSING";
    return [
      `backend: ${s.backend} (needs ${keyEnvName(s.backend)}: ${keyState})`,
      `guard: ${eff.enabled ? "ON" : "OFF"}${eff.source === "session" ? " for this session" : " (saved)"}`,
      `thresholds: ask ≥ ${s.askThreshold}, block ≥ ${s.blockThreshold}`,
    ];
  };

  if (!ctx.hasUI) {
    // No interactive prompts available: walk through linearly.
    const s = loadSettings(ctx);
    const resolved = await resolveActiveKey(ctx, s);
    ctx.ui.notify(["jev-guard setup", "", ...stateLines(s, resolved)].join("\n"), "info");
    if (!resolved.key) {
      ctx.ui.notify(keySetupHelp(s.backend), "info");
    } else {
      await setupSelfTest(ctx, s, resolved.key);
    }
    ctx.ui.notify("Toggle anytime: /jev-guard on | off (session), add --global to persist.", "info");
    return;
  }

  let s = loadSettings(ctx);
  let resolved = await resolveActiveKey(ctx, s);
  ctx.ui.notify(`jev-guard setup\n\n${stateLines(s, resolved).join("\n")}`, "info");

  if (!resolved.key) {
    const choice = await ctx.ui.select(
      `No classifier key found (${keyEnvName(s.backend)} is MISSING).\n\n${keySetupHelp(s.backend)}\n\nHow do you want to proceed?`,
      ["Switch backend", "Continue without a key", "Disable guard for this session"],
    );
    if (choice === "Switch backend") {
      const other = s.backend === "openrouter" ? "typesafe" : "openrouter";
      saveGlobalSettings({ backend: other });
      s = loadSettings(ctx);
      resolved = await resolveActiveKey(ctx, s);
      ctx.ui.notify(`Backend switched to ${other}; it needs ${keyEnvName(other)}.`, "info");
    } else if (choice === "Disable guard for this session") {
      session.enabled = false;
      ctx.ui.notify("jev-guard disabled for this session. Re-run /jev-guard setup anytime.", "info");
      return;
    }
    // "Continue without a key": the enabled guard fails closed with setup hints.
  }

  await setupSelfTest(ctx, s, resolved.key);

  const final = await ctx.ui.select("Enable the guard?", ["Enable for this session", "Disable for this session"]);
  session.enabled = final === "Enable for this session";
  // Only re-check when we think there is no key: the user was just shown how to
  // connect one and may have done it in another pane mid-dialog.
  const finalKey = resolved.key ?? (await resolveActiveKey(ctx, loadSettings(ctx))).key;
  if (session.enabled && !finalKey) {
    ctx.ui.notify(
      "jev-guard enabled without a key: unvouched calls will block until you connect a key (run /login openrouter, or set the key and restart pi). Bypass anytime with /jev-guard off.",
      "warning",
    );
  } else {
    ctx.ui.notify(
      session.enabled
        ? "jev-guard is ON for this session. Toggle anytime: /jev-guard off."
        : "jev-guard is OFF for this session (re-enables on next launch unless saved OFF). Toggle anytime: /jev-guard on.",
      "info",
    );
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const verdictCache = new Map<string, JevOutcome & { verdict: JevVerdict }>();
  // Session-scoped on/off switch. Bare on/off flips it for this session only
  // (safe default: the guard comes back next launch); --global also persists.
  const session = { enabled: undefined as boolean | undefined };

  // Where audit records are shown. The entry renderer is handed no context and
  // so cannot read settings itself, which is why the mode is cached here:
  // refreshed on every settings load, and primed at session_start, which pi
  // awaits before it renders a resumed transcript.
  let auditDisplay: AuditDisplay = DEFAULT_SETTINGS.auditDisplay;

  // What the footer reports. Counted per session and recounted from the
  // session's own entries on resume, so the number survives a restart the way
  // the records themselves do.
  const tally = { calls: 0, blocked: 0, latest: undefined as AuditRecord | undefined };

  /** Load settings, keep the cached display mode in step with them, and put
   *  the footer where the current state says it belongs. */
  function settingsFor(ctx: ExtensionContext): GuardSettings {
    const settings = loadSettings(ctx);
    auditDisplay = settings.auditDisplay;
    // A guard that is not gating must not leave a line in the footer claiming
    // otherwise.
    if (resolveEnabled(settings.enabled, session.enabled).enabled) showStatus(ctx);
    else clearAuditStatus(ctx);
    return settings;
  }

  /**
   * The footer line: the running count in every mode, plus the last verdict in
   * `status` mode. A count with no records to read is the point of the thing,
   * so it is shown whether or not the transcript is.
   */
  function showStatus(ctx: ExtensionContext): void {
    try {
      ctx.ui.setStatus(
        AUDIT_TYPE,
        formatGuardStatus({
          calls: tally.calls,
          blocked: tally.blocked,
          latest: auditDisplay === "status" ? tally.latest : undefined,
        }),
      );
    } catch {
      // The footer line is cosmetic; never let it break the gate.
    }
  }

  function clearAuditStatus(ctx: ExtensionContext): void {
    try {
      ctx.ui.setStatus(AUDIT_TYPE, undefined);
    } catch {
      // The footer line is cosmetic; never let it break the gate.
    }
  }

  /** Count what the guard has done, for the footer. A classifier verdict is a
   *  "jev call"; a rules block never reached the classifier but did stop something. */
  function count(data: AuditRecord): void {
    if (data.source === "jev") tally.calls++;
    if (data.decision.endsWith("blocked")) tally.blocked++;
    tally.latest = data;
  }

  /** Recount from the session itself, so a resumed session keeps its total. */
  function recount(ctx: ExtensionContext): void {
    tally.calls = 0;
    tally.blocked = 0;
    tally.latest = undefined;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (typeof entry !== "object" || entry === null) continue;
        if (!("type" in entry) || entry.type !== "custom") continue;
        if (!("customType" in entry) || entry.customType !== AUDIT_TYPE) continue;
        const data = "data" in entry ? (entry.data as AuditRecord | undefined) : undefined;
        if (data && typeof data.decision === "string") count(data);
      }
    } catch {
      // A session we cannot read just starts the count at zero.
    }
  }

  /**
   * Record one decision. The session file always gets it: that is the durable
   * audit trail, and the e2e suite reads it. Where it is *shown* is the user's
   * call, because a routine "allowed" box on every judged call buries the
   * conversation it is supposed to protect.
   */
  function audit(ctx: ExtensionContext, data: AuditRecord): void {
    try {
      pi.appendEntry(AUDIT_TYPE, { ...data });
    } catch {
      // Auditing must never break the gate itself.
    }
    count(data);
    showStatus(ctx);
  }

  function cacheGet(key: string): (JevOutcome & { verdict: JevVerdict }) | undefined {
    const hit = verdictCache.get(key);
    if (hit) {
      // Refresh LRU position.
      verdictCache.delete(key);
      verdictCache.set(key, hit);
    }
    return hit;
  }

  function cacheSet(key: string, value: JevOutcome & { verdict: JevVerdict }): void {
    verdictCache.delete(key);
    verdictCache.set(key, value);
    while (verdictCache.size > CACHE_LIMIT) {
      const oldest = verdictCache.keys().next();
      if (oldest.done) break;
      verdictCache.delete(oldest.value);
    }
  }

  async function gateViaJev(
    ctx: ExtensionContext,
    settings: GuardSettings,
    tool: string,
    input: ClassifyInput,
    cacheable: boolean,
  ): Promise<{ block: true; reason: string; terminate?: boolean } | undefined> {
    const subject = input.subject;
    const shortSubject = truncate(subject, 160).replace(/\n/g, " ");
    // Cache first: a hit needs no credential at all, and resolving one can
    // re-read and parse auth.json. getApiKeyForProvider takes no options, so
    // ctx.signal cannot reach it and the user could not cancel that wait.
    const cacheKey = `${settings.backend}\n${settings.backend === "typesafe" ? settings.typesafeModel : settings.model}\n${tool}\n${input.cwd}\n${subject}`;
    const cached = cacheable ? cacheGet(cacheKey) : undefined;

    let outcome: JevOutcome;
    if (cached) {
      outcome = cached;
    } else {
      const { key } = await resolveActiveKey(ctx, settings);
      if (!key) {
        const need = keyEnvName(settings.backend);
        const hasPiProvider = settings.backend === "openrouter";
        const fix = hasPiProvider ? `run /login openrouter in pi, set ${need}` : `set ${need}`;
        audit(ctx, {
          tool,
          subject: shortSubject,
          decision: "blocked",
          source: "no-key",
          detail: hasPiProvider
            ? `${need} is not set and no saved pi auth found (backend: ${settings.backend})`
            : `${need} is not set (backend: ${settings.backend})`,
          at: Date.now(),
        });
        return {
          block: true,
          reason:
            `jev-guard: unvouched ${tool} call blocked: no classifier key ` +
            `(backend: ${settings.backend}). To fix: ${fix}, switch backend with ` +
            `/jev-guard backend <openrouter|typesafe>, or run /jev-guard off to disable the guard. ` +
            `Call: ${shortSubject}`,
        };
      }
      outcome = await classifyWithJev(settings, input, key, ctx.signal ?? undefined);
    }

    if (!outcome.verdict) {
      // Fail closed: an unreachable or incoherent classifier must not wave calls through.
      audit(ctx, {
        tool,
        subject: shortSubject,
        decision: "blocked",
        source: "error",
        detail: outcome.error ?? "unknown classifier error",
        model: outcome.modelUsed,
        latencyMs: outcome.latencyMs,
        at: Date.now(),
      });
      return {
        block: true,
        reason:
          `jev-guard: classifier unreachable (${outcome.error ?? "unknown error"}): ` +
          `failing closed on ${tool} call. Retry, or run /jev-guard off to bypass (not recommended). ` +
          `Call: ${shortSubject}`,
      };
    }
    if (!cached && cacheable) cacheSet(cacheKey, outcome as JevOutcome & { verdict: JevVerdict });

    const danger = outcome.verdict.danger;
    const band = bandFor(danger, settings);
    const where = outcome.modelUsed ? ` [${outcome.modelUsed} ${outcome.latencyMs}ms]` : "";

    if (band === "block") {
      audit(ctx, {
        tool,
        subject: shortSubject,
        decision: "blocked",
        source: "jev",
        danger,
        category: outcome.verdict.category,
        detail: outcome.verdict.reason,
        model: outcome.modelUsed,
        latencyMs: outcome.latencyMs,
        at: Date.now(),
      });
      if (ctx.hasUI) {
        ctx.ui.notify(
          `jev-guard blocked ${tool} (danger ${danger.toFixed(2)}: ${outcome.verdict.category})`,
          "error",
        );
      }
      return {
        block: true,
        reason:
          `jev-guard: blocked ${tool} call with danger ${danger.toFixed(2)} ` +
          `(${outcome.verdict.category}: ${outcome.verdict.reason})${where}. ` +
          `To allow similar calls, add a pattern to allowedCommands in ${SETTINGS_FILE}. ` +
          `Call: ${shortSubject}`,
        terminate: true,
      };
    }

    if (band === "ask") {
      if (!ctx.hasUI) {
        // Nobody to ask: `uncertain` decides, and only an explicit allow passes.
        const headless = middleBandWithoutUI(settings.uncertain);
        audit(ctx, {
          tool,
          subject: shortSubject,
          decision: headless === "allow" ? "allowed" : "blocked",
          source: "jev",
          danger,
          category: outcome.verdict.category,
          detail:
            `middle-band verdict with no UI to confirm; uncertain=${settings.uncertain}` +
            (headless === "allow" ? "" : ", failed closed"),
          model: outcome.modelUsed,
          latencyMs: outcome.latencyMs,
          at: Date.now(),
        });
        if (headless === "allow") return undefined;
        return {
          block: true,
          reason:
            `jev-guard: ${tool} call scored danger ${danger.toFixed(2)} ` +
            `(${outcome.verdict.category}) with no UI available to confirm, failing closed ` +
            `(uncertain=${settings.uncertain}; set "uncertain": "allow" in ${SETTINGS_FILE} to let the middle band through unattended). ` +
            `Call: ${shortSubject}`,
        };
      }
      const choice = await ctx.ui.select(
        `jev-guard: ${tool} call scored danger ${danger.toFixed(2)} (${outcome.verdict.category})${where}\n\n  ${shortSubject}\n\n${outcome.verdict.reason}\n\nAllow this call?`,
        ["Yes, run it", "No, block it"],
      );
      const allowed = choice === "Yes, run it";
      audit(ctx, {
        tool,
        subject: shortSubject,
        decision: allowed ? "asked-allowed" : "asked-blocked",
        source: "jev",
        danger,
        category: outcome.verdict.category,
        detail: outcome.verdict.reason,
        model: outcome.modelUsed,
        latencyMs: outcome.latencyMs,
        at: Date.now(),
      });
      if (!allowed) {
        return { block: true, reason: `jev-guard: blocked by user after Jev scored danger ${danger.toFixed(2)}.` };
      }
      return undefined;
    }

    audit(ctx, {
      tool,
      subject: shortSubject,
      decision: "allowed",
      source: "jev",
      danger,
      category: outcome.verdict.category,
      detail: outcome.verdict.reason,
      model: outcome.modelUsed,
      latencyMs: outcome.latencyMs,
      at: Date.now(),
    });
    return undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    // Pi awaits session_start before it renders a resumed transcript, so
    // historical audit entries obey the setting too.
    try {
      recount(ctx);
      settingsFor(ctx);
    } catch {
      // Priming is cosmetic: a bad read leaves the shipped default standing
      // rather than reporting an extension error at startup.
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!GATED_TOOLS.has(event.toolName)) return undefined;
    const settings = settingsFor(ctx);
    if (!resolveEnabled(settings.enabled, session.enabled).enabled) return undefined;

    if (event.toolName === "bash" || event.toolName === "powershell") {
      const command = asText(field(event.input, "command"));
      const local = classifyCommandLocal(command, settings);
      const short = truncate(command.trim(), 160).replace(/\n/g, " ");
      if (local.decision === "deny") {
        audit(ctx, { tool: event.toolName, subject: short, decision: "blocked", source: "rules", detail: local.reason, at: Date.now() });
        if (ctx.hasUI) ctx.ui.notify(`jev-guard blocked ${event.toolName}: ${local.reason}`, "error");
        return { block: true, reason: `jev-guard: blocked. ${local.reason}. Call: ${short}`, terminate: true };
      }
      if (local.decision === "pass") {
        if (local.audited) {
          audit(ctx, { tool: event.toolName, subject: short, decision: "allowed", source: "allowlist", detail: local.reason, at: Date.now() });
        }
        return undefined;
      }
      const input: ClassifyInput = {
        kind: event.toolName === "powershell" ? "powershell" : "bash",
        subject: command,
        cwd: ctx.cwd,
        userPrompt: lastUserPrompt(ctx),
      };
      return await gateViaJev(ctx, settings, event.toolName, input, true);
    }

    // write / edit
    const target = asText(field(event.input, "path"));
    const rel = relativePosix(target === "" ? ctx.cwd : target, ctx.cwd);
    if (target !== "" && !isProtectedPath(target, ctx.cwd, settings)) {
      return undefined; // ordinary project file: no API call needed.
    }
    const input: ClassifyInput = {
      kind: event.toolName === "edit" ? "edit" : "write",
      subject: `${event.toolName} ${target === "" ? "(missing path)" : rel}`,
      cwd: ctx.cwd,
      userPrompt: lastUserPrompt(ctx),
    };
    // File targets vary per call; still cacheable on the exact subject.
    return await gateViaJev(ctx, settings, event.toolName, input, true);
  });

  pi.registerCommand("jev-guard", {
    description: "Jev dangerous-command guard: setup | on | off | status | check <cmd> | model <id> | backend <name> | audit <where>",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["setup", "on", "off", "status", "check ", "model ", "backend ", "audit "];
      const items = subs
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const space = trimmed.indexOf(" ");
      const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
      const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();

      if (sub === "on" || sub === "off") {
        const enable = sub === "on";
        session.enabled = enable;
        const saved = settingsFor(ctx);
        if (rest.split(/\s+/).includes("--global")) {
          saveGlobalSettings({ enabled: enable });
          ctx.ui.notify(`jev-guard ${enable ? "enabled" : "disabled"} and saved (${globalSettingsPath()}).`, "info");
        } else {
          let msg = `jev-guard ${enable ? "enabled" : "disabled"} for this session.`;
          if (enable !== saved.enabled) {
            msg += ` Saved setting is still ${saved.enabled ? "ON" : "OFF"}. Add --global to persist.`;
          }
          ctx.ui.notify(msg, "info");
        }
        return;
      }
      if (sub === "setup") {
        await runSetup(ctx, session);
        return;
      }
      if (sub === "model") {
        if (rest === "") {
          ctx.ui.notify("Usage: /jev-guard model <model-id>", "error");
          return;
        }
        const settings = settingsFor(ctx);
        if (settings.backend === "typesafe") {
          saveGlobalSettings({ typesafeModel: rest });
        } else {
          saveGlobalSettings({ model: rest });
        }
        ctx.ui.notify(`jev-guard model set to ${rest} (backend: ${settings.backend})`, "info");
        return;
      }
      if (sub === "backend") {
        if (rest !== "openrouter" && rest !== "typesafe") {
          ctx.ui.notify("Usage: /jev-guard backend <openrouter|typesafe>", "error");
          return;
        }
        saveGlobalSettings({ backend: rest });
        ctx.ui.notify(
          rest === "openrouter"
            ? `jev-guard backend set to openrouter; run /login openrouter or set OPENROUTER_API_KEY`
            : `jev-guard backend set to typesafe; needs TYPESAFE_API_KEY`,
          "info",
        );
        return;
      }
      if (sub === "audit") {
        const mode = parseAuditDisplay(rest);
        if (!mode) {
          ctx.ui.notify("Usage: /jev-guard audit <transcript|status|off>", "error");
          return;
        }
        saveGlobalSettings({ auditDisplay: mode });
        settingsFor(ctx);
        const kept = "Every decision is still written to the session file.";
        ctx.ui.notify(
          mode === "transcript"
            ? "jev-guard audit records show as a box in the transcript."
            : mode === "status"
              ? `jev-guard audit records show as one line in the footer. ${kept}`
              : `jev-guard audit records are hidden. ${kept}`,
          "info",
        );
        return;
      }
      if (sub === "check") {
        if (rest === "") {
          ctx.ui.notify("Usage: /jev-guard check <shell command>", "info");
          return;
        }
        const settings = settingsFor(ctx);
        const local = classifyCommandLocal(rest, settings);
        if (local.decision !== "unknown") {
          ctx.ui.notify(`local ${local.decision}: ${local.reason}`, "info");
          return;
        }
        const { key } = await resolveActiveKey(ctx, settings);
        if (!key) {
          ctx.ui.notify(
            settings.backend === "openrouter"
              ? `No classifier key found. Run /login openrouter in pi, or set ${keyEnvName(settings.backend)} before launching pi.`
              : `${keyEnvName(settings.backend)} is not set; cannot consult Jev.`,
            "error",
          );
          return;
        }
        ctx.ui.notify("Consulting Jev…", "info");
        const outcome = await classifyWithJev(
          settings,
          { kind: "bash", subject: rest, cwd: ctx.cwd, userPrompt: "" },
          key,
          ctx.signal ?? undefined,
        );
        if (!outcome.verdict) {
          ctx.ui.notify(`Jev error: ${outcome.error ?? "unknown"}`, "error");
          return;
        }
        const band = bandFor(outcome.verdict.danger, settings);
        ctx.ui.notify(
          `danger ${outcome.verdict.danger.toFixed(2)} → ${band} ` +
            `(${outcome.verdict.category}: ${outcome.verdict.reason})` +
            (outcome.modelUsed ? ` [${outcome.modelUsed} ${outcome.latencyMs}ms]` : ""),
          band === "allow" ? "info" : "warning",
        );
        return;
      }
      if (sub !== "" && !KNOWN_SUBCOMMANDS.has(sub)) {
        ctx.ui.notify(
          `Unknown subcommand "${sub}". Usage: /jev-guard [status | setup | on | off | check <cmd> | model <id> | backend <openrouter|typesafe> | audit <transcript|status|off>]`,
          "error",
        );
        return;
      }

      // status (default)
      const settings = settingsFor(ctx);
      const need = keyEnvName(settings.backend);
      const { key: statusKey, source: statusSource } = await resolveActiveKey(ctx, settings);
      const keyState = statusKey ? `set (${statusSource === "env" ? "env" : "pi auth"})` : "MISSING";
      const eff = resolveEnabled(settings.enabled, session.enabled);
      const stateLine =
        `jev-guard: ${eff.enabled ? "ON" : "OFF"}` +
        `${eff.source === "session" ? " for this session" : ""} (backend: ${settings.backend})`;
      const savedLine =
        eff.source === "session" ? `saved setting: ${settings.enabled ? "ON" : "OFF"}` : null;
      const modelLine =
        settings.backend === "typesafe"
          ? `model: ${settings.typesafeModel} @ ${settings.typesafeBaseUrl}`
          : `model: ${settings.model} (fallback ${settings.fallbackModel}) @ ${settings.baseUrl}`;
      ctx.ui.notify(
        [
          stateLine,
          ...(savedLine ? [savedLine] : []),
          modelLine,
          `thresholds: ask ≥ ${settings.askThreshold}, block ≥ ${settings.blockThreshold}, uncertain=${settings.uncertain}`,
          `audit display: ${settings.auditDisplay}`,
          `${need}: ${keyState}`,
          `cached verdicts this session: ${verdictCache.size}`,
          `config: ${globalSettingsPath()}`,
          `setup: /jev-guard setup · toggle: /jev-guard on | off (--global to persist)`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerEntryRenderer(AUDIT_TYPE, (entry, opts, theme) => {
    // Settings are unreachable from here, so the cached mode decides. Returning
    // undefined keeps the entry out of the transcript entirely; the record was
    // written to the session file either way.
    if (auditDisplay !== "transcript") return undefined;
    const data = entry.data as AuditRecord | undefined;
    // No background and no padded block: the verdict belongs to the tool call
    // above it and should read as a footnote to it, not as a second event.
    const box = new Box(1, 0);
    const line = data ? formatAuditLine(data) : { text: "jev", tone: "dim" as const };
    box.addChild(new Text(theme.fg(line.tone, line.text)));
    if (opts.expanded && data) {
      if (data.subject) box.addChild(new Text(theme.fg("dim", `call: ${truncate(data.subject, 200)}`)));
      if (data.category || data.detail) {
        box.addChild(new Text(theme.fg("dim", `${data.category ?? ""}: ${data.detail ?? ""}`.trim())));
      }
      if (data.model || typeof data.latencyMs === "number") {
        box.addChild(new Text(theme.fg("dim", `${data.model ?? "?"}${typeof data.latencyMs === "number" ? ` ${data.latencyMs}ms` : ""}`)));
      }
    }
    return box;
  });
}
