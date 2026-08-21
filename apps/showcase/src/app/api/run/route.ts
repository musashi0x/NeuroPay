/**
 * `POST /api/run` — start a paid stream run for the showcase page.
 *
 * The body is `{ segments?: number }`. We respond with an SSE stream
 * of `RunEvent` JSON objects, one per segment / refusal / budget tick.
 * The client component decodes the stream into the live log.
 *
 * The route is server-only by virtue of being a Next.js route handler,
 * but the `check-no-server-imports` script enforces the same contract
 * here as in the rest of the app: nothing in `src/app/api/**` may
 * leak `@neuro-pay/altana` or `SESSION_PRIVATE_KEY` into a client
 * bundle. Both live in `process.env` and the route module only.
 */

import { randomUUID } from "node:crypto";
import {
  loadShowcaseConfig,
  resolveSegments,
  ShowcaseConfigError,
} from "@/lib/env";
import { renderSseEvent, runStream } from "@/lib/runStream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunRequestBody = { segments?: unknown };

function parseBody(value: unknown): RunRequestBody {
  if (value === null || typeof value !== "object") return {};
  return value as RunRequestBody;
}

export async function POST(request: Request): Promise<Response> {
  let body: RunRequestBody = {};
  try {
    const text = await request.text();
    if (text.length > 0) body = parseBody(JSON.parse(text));
  } catch {
    body = {};
  }

  let config;
  try {
    config = loadShowcaseConfig();
  } catch (err) {
    if (err instanceof ShowcaseConfigError) {
      return new Response(
        renderSseEvent({
          kind: "error",
          runId: "config",
          message: err.message,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        },
      );
    }
    throw err;
  }

  const segments = resolveSegments(body.segments, config);
  const runId = randomUUID();

  // The stream is closed automatically when the generator returns or
  // the client disconnects (Next.js aborts the request signal).
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runStream({
          runId,
          requestedSegments: segments,
          sellerUrl: config.sellerUrl,
          storePath: config.sessionStorePath,
          privateKey: config.sessionPrivateKey,
          budgetMargin: config.budgetMargin,
          segmentDelayMs: config.segmentDelayMs,
          tokenSymbol: config.tokenSymbol,
        })) {
          controller.enqueue(encoder.encode(renderSseEvent(event)));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            renderSseEvent({
              kind: "error",
              runId,
              message: `Unexpected error: ${(err as Error).message}`,
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
