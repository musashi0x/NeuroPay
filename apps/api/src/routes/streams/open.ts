/**
 * `POST /v1/streams` — open a new metered stream.
 *
 * The route is intentionally thin: the seller is the composition root
 * that owns the stream store, the price registry, and the settler. We
 * just hand the seller the request URL and ask for the open response.
 *
 * The 200 shape is the wire `StreamOpenResponse` with one concession to
 * the wire: `priceSheet` is serialized as a JSON-safe object (the
 * `priceSheet` field is itself serializable, but the inner `PriceSheet`
 * has no bigint, so this is a no-op for now; the JSON helper is
 * centralized so a future bigint field on the sheet cannot ship
 * unconverted).
 */
import { Hono } from "hono";
import type { Seller, StreamOpenResponse } from "../../seller/index.js";

export type OpenStreamDeps = {
  seller: Pick<Seller, "openStream">;
};

/** Build the open-stream Hono sub-app. */
export function openStreamRoute(deps: OpenStreamDeps): Hono {
  const app = new Hono();

  app.post("/v1/streams", async (c) => {
    const requestUrl = c.req.url;
    const response: StreamOpenResponse = deps.seller.openStream({
      requestUrl,
    });

    return c.json(response, 200);
  });

  return app;
}
