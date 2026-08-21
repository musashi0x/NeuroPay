/**
 * Tests for operator authentication.
 *
 * The load-bearing assertion in this file is not "a good token works" —
 * it is that the buyer routes stay open while the console routes close.
 * Those two surfaces collide on `/v1/streams`, so a guard written as a
 * path prefix would either lock buyers out or leave the kill switch
 * open, and both failures look fine until someone tries the other verb.
 */

import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  CONSOLE_TOKEN_ENV,
  MIN_TOKEN_LENGTH,
  readBearerToken,
  resolveConsoleAuth,
  WeakConsoleTokenError,
  type ConsoleAuthMode,
} from "./auth.js";

const TOKEN = "t".repeat(MIN_TOKEN_LENGTH);
const enforced: ConsoleAuthMode = { kind: "enforced", token: TOKEN };

/** A console stub: every method records that it was reached. */
function consoleStub() {
  const calls: string[] = [];
  const snapshot = { session: null, streams: [], payments: [], budget: null };
  return {
    calls,
    service: {
      getSession: async () => {
        calls.push("getSession");
        return null;
      },
      listStreams: async () => {
        calls.push("listStreams");
        return { items: [], nextCursor: null };
      },
      listPayments: async () => {
        calls.push("listPayments");
        return { items: [], nextCursor: null };
      },
      getBudget: async () => {
        calls.push("getBudget");
        return null;
      },
      snapshot: async () => snapshot,
      revoke: async () => {
        calls.push("revoke");
        return {
          local: { revoked: true },
          onChain: { revoked: true, status: null, transactionHash: null },
        };
      },
      retryRevoke: async () => {
        calls.push("retryRevoke");
        return {
          local: { revoked: true },
          onChain: { revoked: true, status: null, transactionHash: null },
        };
      },
      retrySettlement: async () => {
        calls.push("retrySettlement");
        return { transactionHash: `0x${"11".repeat(32)}` as const };
      },
      subscribe: () => () => {},
      notify: () => {},
      close: () => {},
      registerSseAbort: () => () => {},
    },
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
    nextSegment: async () => ({
      kind: "not-found" as const,
      status: 404 as const,
      reason: "test stub",
    }),
  };
}

describe("resolveConsoleAuth", () => {
  it("is disabled when the token is unset, and says why", () => {
    const mode = resolveConsoleAuth({} as NodeJS.ProcessEnv);
    expect(mode.kind).toBe("disabled");
    if (mode.kind === "disabled") {
      expect(mode.reason).toContain(CONSOLE_TOKEN_ENV);
    }
  });

  it("treats whitespace as unset", () => {
    const mode = resolveConsoleAuth({
      [CONSOLE_TOKEN_ENV]: "   ",
    } as NodeJS.ProcessEnv);
    expect(mode.kind).toBe("disabled");
  });

  it("refuses a short token instead of quietly downgrading", () => {
    // An operator who set the variable meant to turn auth on. Falling
    // back to `disabled` would leave the kill switch open while the
    // config says it is guarded.
    expect(() =>
      resolveConsoleAuth({ [CONSOLE_TOKEN_ENV]: "short" } as NodeJS.ProcessEnv),
    ).toThrow(WeakConsoleTokenError);
  });

  it("enforces with a long enough token", () => {
    const mode = resolveConsoleAuth({
      [CONSOLE_TOKEN_ENV]: TOKEN,
    } as NodeJS.ProcessEnv);
    expect(mode).toEqual({ kind: "enforced", token: TOKEN });
  });
});

describe("readBearerToken", () => {
  it("reads the Bearer scheme case-insensitively", () => {
    expect(readBearerToken("Bearer abc")).toBe("abc");
    expect(readBearerToken("bearer abc")).toBe("abc");
  });

  it("rejects other schemes and empty headers", () => {
    expect(readBearerToken("Basic abc")).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
    expect(readBearerToken("")).toBeNull();
  });
});

describe("console routes are guarded", () => {
  const paths = [
    ["GET", "/v1/session"],
    ["GET", "/v1/streams"],
    ["GET", "/v1/payments"],
    ["GET", "/v1/budget"],
    ["POST", "/v1/session/revoke"],
    ["POST", "/v1/session/revoke/retry"],
    ["POST", "/v1/settlements/abc/retry"],
  ] as const;

  for (const [method, path] of paths) {
    it(`401s ${method} ${path} without a token`, async () => {
      const stub = consoleStub();
      const app = createApp({
        console: stub.service,
        consoleAuth: enforced,
      });
      const res = await app.request(path, { method });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
      // The guard must run before the handler, not alongside it.
      expect(stub.calls).toHaveLength(0);
    });

    it(`401s ${method} ${path} with the wrong token`, async () => {
      const stub = consoleStub();
      const app = createApp({ console: stub.service, consoleAuth: enforced });
      const res = await app.request(path, {
        method,
        headers: { Authorization: `Bearer ${"x".repeat(MIN_TOKEN_LENGTH)}` },
      });
      expect(res.status).toBe(401);
      expect(stub.calls).toHaveLength(0);
    });

    it(`allows ${method} ${path} with the right token`, async () => {
      const stub = consoleStub();
      const app = createApp({ console: stub.service, consoleAuth: enforced });
      const res = await app.request(path, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).not.toBe(401);
      expect(stub.calls.length).toBeGreaterThan(0);
    });
  }

  it("never echoes the presented token in the 401 body", async () => {
    const app = createApp({
      console: consoleStub().service,
      consoleAuth: enforced,
    });
    const guess = "g".repeat(MIN_TOKEN_LENGTH);
    const res = await app.request("/v1/session", {
      headers: { Authorization: `Bearer ${guess}` },
    });
    const body = await res.text();
    expect(body).not.toContain(guess);
    expect(body).not.toContain(TOKEN);
  });

  it("passes everything through when auth is disabled", async () => {
    const stub = consoleStub();
    const app = createApp({
      console: stub.service,
      consoleAuth: { kind: "disabled", reason: "test" },
    });
    const res = await app.request("/v1/session");
    expect(res.status).not.toBe(401);
  });
});

describe("buyer routes stay open", () => {
  // The whole point of mounting the guard on the console router rather
  // than a path prefix. `GET /v1/streams` is the operator's; `POST
  // /v1/streams` is the buyer's. Same path, different audience.
  it("POST /v1/streams needs no token even while the console is guarded", async () => {
    const app = createApp({
      console: consoleStub().service,
      seller: sellerStub() as never,
      consoleAuth: enforced,
    });
    const res = await app.request("/v1/streams", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("GET /v1/streams on the same path still needs one", async () => {
    const app = createApp({
      console: consoleStub().service,
      seller: sellerStub() as never,
      consoleAuth: enforced,
    });
    const res = await app.request("/v1/streams");
    expect(res.status).toBe(401);
  });

  it("GET /v1/streams/:id/next needs no token", async () => {
    const app = createApp({
      console: consoleStub().service,
      seller: sellerStub() as never,
      consoleAuth: enforced,
    });
    const res = await app.request("/v1/streams/s-1/next");
    expect(res.status).not.toBe(401);
  });

  it("/health needs no token", async () => {
    const app = createApp({
      console: consoleStub().service,
      consoleAuth: enforced,
    });
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("timing", () => {
  it("compares tokens without returning early on a length mismatch", async () => {
    // Not a timing measurement (too flaky for CI). This asserts the
    // observable contract instead: a one-character token and a
    // same-length-but-wrong token are both plain 401s with identical
    // bodies, so neither response reveals which kind of wrong it was.
    const app = createApp({
      console: consoleStub().service,
      consoleAuth: enforced,
    });
    const short = await app.request("/v1/session", {
      headers: { Authorization: "Bearer x" },
    });
    const sameLength = await app.request("/v1/session", {
      headers: { Authorization: `Bearer ${"x".repeat(MIN_TOKEN_LENGTH)}` },
    });
    expect(short.status).toBe(sameLength.status);
    // The bodies carry a per-request id, so compare everything else.
    const strip = async (r: Response) => {
      const { error } = (await r.json()) as {
        error: { message: string; detail: string; requestId: string };
      };
      return { message: error.message, detail: error.detail };
    };
    expect(await strip(short)).toEqual(await strip(sameLength));
  });
});

describe("CORS", () => {
  it("allows the Authorization header so the console preflight passes", async () => {
    const app = createApp({ corsOrigin: "http://localhost:3000" });
    const res = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });

  it("never answers with a wildcard origin", async () => {
    const app = createApp({ corsOrigin: "*" });
    const res = await app.request("/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });
});
