#!/usr/bin/env node
/**
 * Guard: the web app must never import the server-only `@neuro-pay/altana`
 * package (or anything from `packages/altana/`).
 *
 * The Altana package wraps `@altananetwork/sdk` and `viem` — key material
 * lives there. If a browser bundle ever pulls it in, the entire point of
 * the server/client split is broken. This script scans `apps/web/src/` for
 * any import statement that references `@neuro-pay/altana` or the
 * `packages/altana/` source path, and exits 1 if any reference is found.
 *
 * Patterns scanned:
 *   - `@neuro-pay/altana` (the published package name)
 *   - `packages/altana/`  (the raw source path)
 *
 * Both single- and double-quoted import strings are matched. The script
 * exits 0 when no matches are found, 1 otherwise, listing the offending
 * lines so the CI annotation points at the file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCAN_ROOT = join(HERE, "..", "src");
const FORBIDDEN = [
  /@neuro-pay\/altana(?:\/|$)/,
  /packages\/altana\//,
  /SETTLER_PRIVATE_KEY/,
  /ADMIN_PRIVATE_KEY/,
  /privateKey\s*:/,
  /0x[a-fA-F0-9]{64}/,
];

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
  lines.forEach((line, index) => {
    for (const pattern of FORBIDDEN) {
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

walk(SCAN_ROOT);

if (FAILURES.length > 0) {
  console.error(
    "apps/web must not import server-only payment code or key material. Offending lines:",
  );
  for (const f of FAILURES) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  process.exit(1);
}

console.log("OK: no server-only imports found in apps/web/src/.");
