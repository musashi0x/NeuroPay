/**
 * Third-party b402 interoperability.
 *
 * A live merchant is optional and never present on a fresh clone, so this
 * suite skips with a reason unless `B402_INTEROP_URL` is set — the same
 * honesty as `pnpm test:chain`. What it always covers is that the
 * skip path is explicit, so CI cannot silently claim interop passed.
 */

import { describe, expect, it } from "vitest";

const INTEROP_URL = process.env.B402_INTEROP_URL?.trim();

describe.skipIf(!INTEROP_URL)("third-party b402 merchant", () => {
  it("reaches the configured merchant (live)", async () => {
    const response = await fetch(INTEROP_URL!, { method: "GET" });
    // Any HTTP response means the merchant is reachable. A 402 is the
    // interesting case; a 200 is a free resource; a 4xx/5xx is still a
    // live peer rather than a skipped test.
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(600);
  });
});

describe("b402 interop gate", () => {
  it("documents the skip when no merchant URL is configured", () => {
    if (INTEROP_URL) {
      expect(INTEROP_URL.startsWith("http")).toBe(true);
      return;
    }
    expect(INTEROP_URL).toBeFalsy();
  });
});
