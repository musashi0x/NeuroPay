import { Hono } from "hono";
import type { HealthResponse } from "@neuro-pay/types";
import { describe, expect, it } from "vitest";
import { app } from "./app.js";
import { requestId } from "./middleware.js";

describe("GET /health", () => {
  it("returns 200 and a HealthResponse body", async () => {
    const response = await app.request("/health");
    const body = (await response.json()) as HealthResponse;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("api");
    expect(body.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("observability middleware", () => {
  it("generates a request id and echoes it on the response", async () => {
    const response = await app.request("/health");
    const id = response.headers.get("x-request-id");

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("inherits an inbound x-request-id header", async () => {
    const response = await app.request("/health", {
      headers: { "x-request-id": "inbound-123" },
    });

    expect(response.headers.get("x-request-id")).toBe("inbound-123");
  });

  it("returns a structured 404 with the request id", async () => {
    const response = await app.request("/does-not-exist", {
      headers: { "x-request-id": "missing-1" },
    });
    const body = (await response.json()) as {
      error: { message: string; requestId: string };
    };

    expect(response.status).toBe(404);
    expect(body.error.message).toBe("Not Found");
    expect(body.error.requestId).toBe("missing-1");
  });

  it("propagates the request id through thrown errors", async () => {
    // Build a fresh app so we don't pollute the shared `app` instance.
    const errorApp = new Hono();
    errorApp.use("*", requestId());
    errorApp.onError((err, c) => {
      return c.json(
        {
          error: {
            message: "Internal Server Error",
            requestId: c.get("requestId"),
          },
        },
        500,
      );
    });
    errorApp.get("/__boom", () => {
      throw new Error("kaboom");
    });

    const response = await errorApp.request("/__boom", {
      headers: { "x-request-id": "boom-1" },
    });
    const body = (await response.json()) as {
      error: { message: string; requestId: string };
    };

    expect(response.status).toBe(500);
    expect(body.error.message).toBe("Internal Server Error");
    expect(body.error.requestId).toBe("boom-1");
    expect(response.headers.get("x-request-id")).toBe("boom-1");
  });
});
