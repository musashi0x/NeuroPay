import { createLogger, type Logger } from "@neuro-pay/logger";

/**
 * Root logger for the API process.
 *
 * JSON in production, pretty in development (driven by NODE_ENV).
 * Override via LOG_LEVEL / LOG_FORMAT.
 */
export const logger: Logger = createLogger({ service: "api" });

export type AppLogger = Logger;
