/**
 * `POST /v1/streams` — open a new metered stream.
 *
 * The route is intentionally thin: the seller is the composition root
 * that owns the stream store, the price registry, and the settler. We
 * just hand the seller the request URL and ask for the open response.
 *
 * The 200 shape is the wire `StreamOpenResponse` passed through
 * `toJsonSafe`: the pinned `PriceSheet` carries `perCall`, `perSecond`,
 * and `perUnit` as `bigint`, and `JSON.stringify` throws on those. The
 * helper renders every amount as a decimal string, which is the same
 * encoding the console routes use and what the web client's
 * `reviveWire` expects back.
 */
import { Hono } from "hono";
import {
  SellerUnavailableError,
  StreamCapacityError,
  type Seller,
  type StreamOpenResponse,
} from "../../seller/index.js";
import { toJsonSafe } from "../../json.js";

export type OpenStreamDeps = {
  seller: Pick<Seller, "openStream">;
};

/** Build the open-stream Hono sub-app. */
export function openStreamRoute(deps: OpenStreamDeps): Hono {
  const app = new Hono();

  app.post("/v1/streams", async (c) => {
    const requestUrl = c.req.url;
    try {
      const response: StreamOpenResponse = deps.seller.openStream({
        requestUrl,
      });
      return c.json(toJsonSafe(response), 200);
    } catch (err) {
      if (err instanceof SellerUnavailableError) {
        return c.json(
          { error: { message: err.message, reason: err.reason } },
          503,
        );
      }
      if (err instanceof StreamCapacityError) {
        // Recoverable without operator action, unlike a shutdown: streams
        // end on their own, so tell the caller when to come back rather
        // than implying the service is going away.
        c.header("Retry-After", "5");
        return c.json(
          {
            error: {
              message: err.message,
              reason: "stream-capacity",
              live: err.live,
              ceiling: err.ceiling,
            },
          },
          503,
        );
      }
      throw err;
    }
  });

  return app;
}
