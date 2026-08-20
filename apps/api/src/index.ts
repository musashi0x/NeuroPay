import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { tryCreateRuntime } from "./runtime.js";

const runtime = tryCreateRuntime();
const app = createApp({
  ...(runtime
    ? {
        console: runtime.console,
        seller: runtime.seller,
        ops: { ops: runtime.ops, ledger: runtime.ledger },
      }
    : {}),
});

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info(
    { port: info.port, paymentRuntime: runtime !== null },
    "api listening",
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => {
    logger.error("shutdown timed out");
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close((err) => {
    void (async () => {
      try {
        await runtime?.close();
      } catch (closeErr) {
        logger.error(
          { err: closeErr instanceof Error ? closeErr : { value: closeErr } },
          "error during runtime close",
        );
        process.exit(1);
      }
      if (err) {
        logger.error({ err }, "error during shutdown");
        process.exit(1);
      }
      process.exit(0);
    })();
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
