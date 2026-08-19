/**
 * `GET /v1/streams/:id/next` — deliver the next segment of a stream.
 *
 * The route holds no business logic: it asks the seller for the
 * `SellerOutcome` and maps each variant to its HTTP response. The seller
 * returns `payment-required` (with a 402 body), `not-found` (404),
 * `exposure-limit` (503), `rejected` (402 with a classification), or
 * `delivered` (200 with the segment payload).
 *
 * `bigint` amounts in the `402` body go through the
 * `stringifyPaymentRequired` helper so the route never has to walk the
 * shape to serialize it.
 */
import { Hono, type Context } from "hono";
import type { Seller, SellerOutcome } from "../../seller/index.js";
import { stringifyPaymentRequired } from "../../seller/requirements.js";
import { toJsonSafe } from "../../json.js";

export type NextSegmentDeps = {
  seller: Pick<Seller, "nextSegment">;
};

/** Build the next-segment Hono sub-app. */
export function nextSegmentRoute(deps: NextSegmentDeps): Hono {
  const app = new Hono();

  app.get("/v1/streams/:id/next", async (c) => {
    const streamId = c.req.param("id");
    const outcome: SellerOutcome = await deps.seller.nextSegment({
      streamId,
      requestUrl: c.req.url,
      headers: c.req.raw.headers,
    });

    return renderOutcome(c, outcome);
  });

  return app;
}

/**
 * Map a `SellerOutcome` to its HTTP response. Extracted so the route
 * can be tested directly against forged outcomes without spinning up a
 * Hono app.
 */
export function renderOutcome(c: Context, outcome: SellerOutcome): Response {
  switch (outcome.kind) {
    case "delivered":
      // `SegmentResponse.accruedUnpaid` and `.totalAccrued` are bigint;
      // `JSON.stringify` throws on those, so every amount goes out as a
      // decimal string — the encoding the console routes already use and
      // the one the web client's `reviveWire` reads back.
      return c.json(toJsonSafe(outcome.body), 200);
    case "payment-required":
      return c.json(stringifyPaymentRequired(outcome.body), 402);
    case "not-found":
      return c.json(
        { error: { message: "Not Found", reason: outcome.reason } },
        404,
      );
    case "exposure-limit":
      return c.json(toJsonSafe(outcome.refusal), 503);
    case "rejected":
      return c.json(
        {
          error: {
            message: "Payment Required",
            classification: outcome.classification,
            detail: outcome.detail,
          },
        },
        402,
      );
  }
}
