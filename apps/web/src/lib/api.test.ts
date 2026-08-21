import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAutoRevoke, setAutoRevoke } from "./api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchAutoRevoke", () => {
  it("GETs /api/console/v1/session/auto-revoke and returns the view", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/console/v1/session/auto-revoke");
      return new Response(
        JSON.stringify({ enabled: true, lastFiredAt: "2026-08-21T10:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await fetchAutoRevoke();
    expect(result.enabled).toBe(true);
    expect(result.lastFiredAt).toBe("2026-08-21T10:00:00.000Z");
  });

  it("throws a friendly error on 404 (watcher not wired)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchAutoRevoke()).rejects.toThrow("not wired");
  });

  it("throws on a non-2xx response other than 404", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchAutoRevoke()).rejects.toThrow("500");
  });
});

describe("setAutoRevoke", () => {
  it("PUTs { enabled } and returns the new view", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("/api/console/v1/session/auto-revoke");
        expect(init?.method).toBe("PUT");
        expect(init?.headers).toMatchObject({
          "Content-Type": "application/json",
        });
        expect(JSON.parse(init?.body as string)).toEqual({ enabled: true });
        return new Response(
          JSON.stringify({ enabled: true, lastFiredAt: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await setAutoRevoke({ enabled: true });
    expect(result.enabled).toBe(true);
    expect(result.lastFiredAt).toBeNull();
  });

  it("throws a friendly error on 404 (watcher not wired)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(setAutoRevoke({ enabled: false })).rejects.toThrow("not wired");
  });
});
