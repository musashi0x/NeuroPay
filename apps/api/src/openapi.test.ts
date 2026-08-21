import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { documentedPaths, openApiDocument } from "./openapi.js";
import { createOpsService } from "./ops/service.js";
import { ledgerProbe, skippedProbe } from "./ops/probes.js";
import { openLedgerStore } from "@neuro-pay/ledger";

function stubConsole() {
  return {
    getSession: async () => null,
    listStreams: async () => ({ items: [], nextCursor: null }),
    listPayments: async () => ({ items: [], nextCursor: null }),
    getBudget: async () => null,
    snapshot: async () => ({
      session: null,
      streams: [],
      payments: [],
      budget: null,
    }),
    revoke: async () => {
      throw new Error("no session");
    },
    retryRevoke: async () => {
      throw new Error("no session");
    },
    retrySettlement: async () => {
      throw new Error("no intent");
    },
    subscribe: () => () => {},
    notify: () => {},
    close: () => {},
    registerSseAbort: () => () => {},
  };
}

function stubSeller() {
  return {
    openStream: () => ({
      streamId: "s-1",
      expiresAt: new Date().toISOString(),
      priceSheet: {},
    }),
    nextSegment: async () => ({
      kind: "not-found" as const,
      status: 404 as const,
      reason: "stub",
    }),
  };
}

function normalize(path: string): string {
  return path.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
}

describe("GET /openapi.json", () => {
  it("returns OpenAPI 3.1 covering the mounted routes", async () => {
    const ledger = openLedgerStore({ storagePath: ":memory:" });
    const ops = createOpsService({
      ledger,
      probes: [skippedProbe("rpc", "not configured"), ledgerProbe(ledger)],
      exposureStats: () => ({ inFlight: 0, ceiling: 4 }),
      getBudget: async () => null,
      getSession: async () => null,
    });
    try {
      const app = createApp({
        console: stubConsole() as never,
        seller: stubSeller() as never,
        ops: { ops, ledger },
      });

      const response = await app.request("/openapi.json");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { openapi: string };
      expect(body.openapi).toBe("3.1.0");

      const mounted = new Set(
        app.routes
          .map((route) => normalize(route.path))
          .filter((path) => path !== "/*" && path !== "*"),
      );
      const documented = new Set(documentedPaths());

      for (const path of mounted) {
        expect(documented.has(path), `OpenAPI missing ${path}`).toBe(true);
      }
      expect(openApiDocument.info.title).toBe("NeuroPay API");
    } finally {
      ledger.close();
    }
  });
});
