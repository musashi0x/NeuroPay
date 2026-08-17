import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HealthResponse } from "@neuro-pay/types";
import { requestId, httpLogger, getLog } from "./middleware.js";
import { resolveCorsOrigin } from "./cors-origin.js";
import { consoleRoutes, type ConsoleRouteDeps } from "./console/routes.js";
import { openStreamRoute, type OpenStreamDeps } from "./routes/streams/open.js";
import {
  nextSegmentRoute,
  type NextSegmentDeps,
} from "./routes/streams/next.js";

export type AppDeps = {
  console?: ConsoleRouteDeps["console"];
  seller?: OpenStreamDeps["seller"] & NextSegmentDeps["seller"];
  corsOrigin?: string;
};

export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const corsOrigin = resolveCorsOrigin(
    deps.corsOrigin ?? process.env.CORS_ORIGIN,
  );

  app.use("*", requestId());
  app.use("*", httpLogger());
  app.use(
    "*",
    cors({
      origin: corsOrigin,
      allowMethods: ["GET", "HEAD", "OPTIONS", "POST"],
      allowHeaders: ["Content-Type", "X-Request-Id"],
    }),
  );

  app.get("/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    };

    return c.json(body);
  });

  if (deps.seller) {
    app.route("/", openStreamRoute({ seller: deps.seller }));
    app.route("/", nextSegmentRoute({ seller: deps.seller }));
  }

  if (deps.console) {
    app.route("/", consoleRoutes({ console: deps.console }));
  }

  app.onError((err, c) => {
    const log = getLog(c);
    log.error(
      {
        err: { name: err.name, message: err.message, stack: err.stack },
        method: c.req.method,
        path: c.req.path,
      },
      "unhandled error",
    );

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

  app.notFound((c) => {
    return c.json(
      {
        error: {
          message: "Not Found",
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  });

  return app;
}

export const app = createApp();
