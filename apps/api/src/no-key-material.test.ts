/**
 * A standing sweep for leaked key material.
 *
 * The ledger already refuses to store secrets (`assertNoKeyMaterial`),
 * but that guard covers one writer. Key material can also escape through
 * an HTTP body, a response header, an error message, a log line, or the
 * browser bundle, and each of those is a separate path with no shared
 * chokepoint.
 *
 * So this file plants known sentinel secrets in the environment, drives
 * every reachable surface, and asserts none of them comes back. It is
 * written to fail loudly the first time someone adds an endpoint that
 * echoes config — which is the realistic way this regresses, since
 * nobody sets out to serialize a private key.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { MIN_TOKEN_LENGTH } from "./auth.js";

/**
 * Sentinels. Distinctive enough that a match cannot be coincidence, and
 * shaped like the real thing so a serializer that special-cases hex
 * still trips.
 */
const SECRETS = {
  admin: `0x${"ad".repeat(32)}`,
  settler: `0x${"5e".repeat(32)}`,
  session: `0x${"5e55".repeat(16)}`,
  consoleToken: `console-${"c".repeat(MIN_TOKEN_LENGTH)}`,
};

function consoleStub() {
  return {
    getSession: async () => null,
    listStreams: async () => [],
    listPayments: async () => [],
    getBudget: async () => null,
    snapshot: async () => ({
      session: null,
      streams: [],
      payments: [],
      budget: null,
    }),
    revoke: async () => {
      throw new Error("no active session to revoke");
    },
    retryRevoke: async () => {
      throw new Error("no pending revoke");
    },
    subscribe: () => () => {},
    notify: () => {},
    close: () => {},
    registerSseAbort: () => () => {},
  };
}

function sellerStub() {
  return {
    openStream: () => ({
      streamId: "s-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      priceSheet: {
        id: "p-1",
        version: 1,
        chainId: 97,
        token: "0x0000000000000000000000000000000000000001",
        tokenDecimals: 18,
        perCall: 0n,
        perSecond: 0n,
        perUnit: 0n,
        unitName: "unit",
        pinnedAt: new Date().toISOString(),
      },
    }),
    // Throws, so the 500 path and its error body are swept too.
    nextSegment: async () => {
      throw new Error("deliberate failure for the leak sweep");
    },
  };
}

/** Every secret value, for substring scanning. */
const values = Object.values(SECRETS);

function assertClean(haystack: string, where: string): void {
  for (const secret of values) {
    expect(haystack.includes(secret), `${where} leaked a secret sentinel`).toBe(
      false,
    );
    // Also check without the 0x prefix: a serializer that strips it
    // still leaks the key.
    const bare = secret.startsWith("0x") ? secret.slice(2) : secret;
    expect(
      haystack.includes(bare),
      `${where} leaked a secret sentinel (unprefixed)`,
    ).toBe(false);
  }
}

describe("no endpoint echoes key material", () => {
  const routes = [
    ["GET", "/health"],
    ["GET", "/v1/session"],
    ["GET", "/v1/streams"],
    ["GET", "/v1/payments"],
    ["GET", "/v1/budget"],
    ["POST", "/v1/streams"],
    ["GET", "/v1/streams/s-1/next"],
    ["POST", "/v1/session/revoke"],
    ["POST", "/v1/session/revoke/retry"],
    ["GET", "/does-not-exist"],
  ] as const;

  for (const [method, path] of routes) {
    it(`${method} ${path} returns no secret in body or headers`, async () => {
      const previous = { ...process.env };
      Object.assign(process.env, {
        ADMIN_PRIVATE_KEY: SECRETS.admin,
        SETTLER_PRIVATE_KEY: SECRETS.settler,
        SESSION_PRIVATE_KEY: SECRETS.session,
        CONSOLE_API_TOKEN: SECRETS.consoleToken,
      });
      try {
        const app = createApp({
          console: consoleStub() as never,
          seller: sellerStub() as never,
          consoleAuth: { kind: "enforced", token: SECRETS.consoleToken },
        });
        // Authenticated, so the handlers actually run rather than
        // stopping at the 401 and sweeping nothing.
        const res = await app.request(path, {
          method,
          headers: { Authorization: `Bearer ${SECRETS.consoleToken}` },
        });
        assertClean(await res.text(), `${method} ${path} body`);
        assertClean(
          JSON.stringify([...res.headers.entries()]),
          `${method} ${path} headers`,
        );
      } finally {
        for (const key of Object.keys(process.env)) {
          if (!(key in previous)) delete process.env[key];
        }
        Object.assign(process.env, previous);
      }
    });
  }
});

describe("the browser bundle carries no server secrets", () => {
  /**
   * Walk the web app's source for anything that would inline a secret.
   *
   * Next inlines `NEXT_PUBLIC_*` into client code, so a secret read
   * through that prefix ships to every visitor. The console token is the
   * live risk here: it is new, and the obvious wrong way to wire it into
   * a client component is exactly `NEXT_PUBLIC_CONSOLE_API_TOKEN`.
   */
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules" || name === ".next") continue;
        out.push(...walk(full));
      } else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  const webSrc = new URL("../../web/src", import.meta.url).pathname;

  it("never exposes a secret through a NEXT_PUBLIC_ variable", () => {
    const offenders: string[] = [];
    for (const file of walk(webSrc)) {
      const text = readFileSync(file, "utf8");
      const matches = text.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? [];
      for (const name of matches) {
        if (/KEY|TOKEN|SECRET|PASSWORD|MNEMONIC|SEED/.test(name)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the console token out of client-reachable code", () => {
    // `CONSOLE_API_TOKEN` may appear only in a server-only route
    // handler. A "use client" file that mentions it is a bundle leak.
    const offenders: string[] = [];
    for (const file of walk(webSrc)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("CONSOLE_API_TOKEN")) continue;
      if (text.includes('"use client"') || text.includes("'use client'")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
