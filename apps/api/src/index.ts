import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { logger } from "./logger.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "api listening");
});

const shutdown = (signal: NodeJS.Signals) => {
  logger.info({ signal }, "shutting down");
  server.close((err) => {
    if (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("unhandledRejection", (reason) => {
  logger.error(
    { reason: reason instanceof Error ? reason : { value: reason } },
    "unhandled rejection",
  );
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});
