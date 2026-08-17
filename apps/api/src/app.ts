import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HealthResponse } from "@neuro-pay/types";

const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";

export const app = new Hono();

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
