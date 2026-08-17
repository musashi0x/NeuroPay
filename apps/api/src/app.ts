import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HealthResponse } from "@neuro-pay/types";
import { requestId, httpLogger, getLog } from "./middleware.js";

const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";

export const app = new Hono();

app.use("*", requestId());
app.use("*", httpLogger());
app.use(
  "*",
  cors({
    origin: corsOrigin,
    allowMethods: ["GET", "HEAD", "OPTIONS"],
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

// Centralized error handler. Any thrown Response / Error reaches here so
// logging is consistent and we never leak stack traces to clients.
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

// 404 fallback also produces a structured log line at warn level.
app.notFound((c) => {
  const log = getLog(c);
  log.warn({ method: c.req.method, path: c.req.path }, "route not found");
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
