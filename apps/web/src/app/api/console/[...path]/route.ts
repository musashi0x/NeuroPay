/**
 * Same-origin proxy for the operator console.
 *
 * The API's console routes now require a bearer token. The console is a
 * client component — it fetches snapshots, opens an `EventSource`, and
 * posts the revoke — so the browser would have to hold that token for
 * the console to keep working. It must not: anything reachable from
 * client code is in the bundle, and a token in the bundle is a kill
 * switch published to every visitor.
 *
 * So the token lives here, on the Next server, and the browser talks to
 * this route instead. `CONSOLE_API_TOKEN` is deliberately *not*
 * `NEXT_PUBLIC_`-prefixed, which is what keeps Next from inlining it.
 *
 * `EventSource` cannot set headers at all, which rules out having the
 * browser authenticate even if we were willing to ship it a token. A
 * same-origin proxy is the only shape that serves both the JSON routes
 * and SSE without inventing a second auth scheme.
 */

import { NextResponse } from "next/server";

// SSE needs a real streaming response, and every console read must be
// fresh rather than served from a build-time cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

/**
 * Console paths this proxy will forward, by method.
 *
 * An allowlist rather than a pass-through. A proxy that forwarded any
 * path would let a browser reach the *buyer* routes — and anything else
 * the API ever mounts — through a credential the browser was never
 * given, which is a worse hole than the one this closes.
 */
const ALLOWED: Record<string, readonly string[]> = {
  GET: ["v1/session", "v1/streams", "v1/payments", "v1/budget", "v1/events"],
  POST: ["v1/session/revoke", "v1/session/revoke/retry"],
};

function upstreamFor(method: string, segments: string[]): string | null {
  const path = segments.join("/");
  return ALLOWED[method]?.includes(path) ? `${API_URL}/${path}` : null;
}

function authHeaders(): HeadersInit {
  const token = process.env.CONSOLE_API_TOKEN?.trim();
  // No token configured means the API is running with auth disabled, so
  // forwarding without one is correct rather than a failure. When the
  // API does enforce, its own 401 is the right answer to surface.
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function forward(
  request: Request,
  method: "GET" | "POST",
  segments: string[],
): Promise<Response> {
  const upstream = upstreamFor(method, segments);
  if (upstream === null) {
    return NextResponse.json(
      { error: { message: "Not Found" } },
      { status: 404 },
    );
  }

  let response: Response;
  try {
    response = await fetch(upstream, {
      method,
      headers: {
        ...authHeaders(),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: await request.text() } : {}),
      cache: "no-store",
      // Let the client's abort (closing the console tab) tear down the
      // upstream SSE connection instead of leaking it for the heartbeat
      // interval to keep alive.
      signal: request.signal,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          message: "The API is unreachable.",
          detail: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 502 },
    );
  }

  // Stream the body through untouched. For `/v1/events` that is the SSE
  // stream; for the JSON routes it is a small body that costs nothing to
  // pass along the same way.
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  return forward(request, "GET", path);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  return forward(request, "POST", path);
}
