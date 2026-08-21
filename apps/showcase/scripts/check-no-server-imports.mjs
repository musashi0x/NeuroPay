#!/usr/bin/env node
/**
 * Guard: the showcase app must never import the server-only
 * `@neuro-pay/altana` package, the raw `packages/altana/` source path,
 * or expose `SESSION_PRIVATE_KEY` to a client bundle.
 *
 * The showcase is a BFF: the server holds the session key and calls the
 * seller through `fetchWithX402`. The browser must never see that key,
 * and it must never pull the Altana package into its bundle. If either
 * rule breaks, the entire reason for the server/client split is gone.
 *
 * Scope:
 *  - `src/app/**` (every file, including server routes) MUST NOT import
 *    `@neuro-pay/altana` or `packages/altana/` into a client bundle. A
 *    stray `import` in any sibling file pulls the server package into
 *    the client graph if the file is reachable from a "use client"
 *    tree. The cleanest rule is therefore: no file under `src/app/` may
 *    name the package or the raw source path.
 *  - `src/app/api/**` (server routes) MAY name `SESSION_PRIVATE_KEY` as
 *    a string — they read it from `process.env`. The script explicitly
 *    excludes that path from the `SESSION_PRIVATE_KEY` check.
 *  - `src/components/**` and everywhere else is the client side; the
 *    `SESSION_PRIVATE_KEY` and `NEXT_PUBLIC_SESSION_*` rules apply.
 *
 * Exits 0 when no matches are found, 1 otherwise.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCAN_ROOTS = [
  join(HERE, "..", "src", "app"),
  join(HERE, "..", "src", "components"),
].filter((root) => {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
});
const SERVER_ROUTE_PATTERN = /[\\/]+app[\\/]+api[\\/]+/;
const FORBIDDEN_ANYWHERE = [
  /@neuro-pay\/altana(?:\/|$)/,
  /packages\/altana\//,
  /NEXT_PUBLIC_SESSION_/,
];
const FORBIDDEN_CLIENT_ONLY = [/SESSION_PRIVATE_KEY/];

const FAILURES = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) continue;
    scan(full);
  }
}

function scan(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const isServerRoute = SERVER_ROUTE_PATTERN.test(path);
  lines.forEach((line, index) => {
    for (const pattern of FORBIDDEN_ANYWHERE) {
      if (pattern.test(line)) {
        FAILURES.push({
          file: relative(join(HERE, "..", ".."), path),
          line: index + 1,
          text: line.trim(),
        });
      }
    }
    if (isServerRoute) return;
    for (const pattern of FORBIDDEN_CLIENT_ONLY) {
      if (pattern.test(line)) {
        FAILURES.push({
          file: relative(join(HERE, "..", ".."), path),
          line: index + 1,
          text: line.trim(),
        });
      }
    }
  });
}

for (const root of SCAN_ROOTS) walk(root);

if (FAILURES.length > 0) {
  console.error(
    "apps/showcase must not import server-only payment code or name key material in client code. Offending lines:",
  );
  for (const f of FAILURES) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  process.exit(1);
}

console.log("OK: no server-only imports / key references in client code.");
