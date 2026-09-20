/**
 * pps-loader.mjs — module hooks that let us import @gotgenes/pi-permission-system
 * straight from node_modules for the head-to-head comparison.
 *
 * Two things stand in the way of a plain import:
 *   1. the package ships TypeScript source, and Node refuses to strip types
 *      under node_modules, so esbuild transpiles each file here instead;
 *   2. its internal specifiers are extensionless (`#src/policy/rule`), which
 *      Node's ESM resolver will not complete, so a failed resolution is
 *      retried with `.ts` appended.
 *
 * Nothing is patched on disk. Registered by compare-guards.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (/\.(ts|mjs|cjs|js|json|node)$/.test(specifier)) throw err;
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      return await next(`${specifier}/index.ts`, context);
    }
  }
}

export async function load(url, context, next) {
  if (!url.endsWith(".ts")) return next(url, context);
  const source = readFileSync(fileURLToPath(url), "utf-8");
  const { code } = transformSync(source, {
    loader: "ts",
    format: "esm",
    target: "node22",
    sourcefile: url,
  });
  return { format: "module", shortCircuit: true, source: code };
}
