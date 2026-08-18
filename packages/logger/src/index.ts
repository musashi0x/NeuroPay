/**
 * Shared logger for @neuro-pay apps.
 *
 * - Structured JSON in production (NODE_ENV=production or LOG_FORMAT=json).
 * - Pretty-printed in development for easier local reading.
 * - Redacts sensitive headers/fields by default.
 * - Reads LOG_LEVEL (default: "info") and LOG_FORMAT (default: auto).
 *
 * Apps should create one root logger per process via createLogger() and
 * attach it to the request context for per-request child loggers.
 */

import { pino } from "pino";

type PinoLogger = ReturnType<typeof pino>;

export type LogLevel =
  "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type LogFormat = "json" | "pretty";

export type LogContext = {
  service?: string;
  /** Stable per-request id, propagated via `x-request-id`. */
  requestId?: string;
  /** Free-form structured fields (e.g. userId, route, status). */
  [key: string]: unknown;
};

export type CreateLoggerOptions = {
  /** Logical service name injected into every log line. */
  service?: string;
  /** Override `LOG_LEVEL`. */
  level?: LogLevel;
  /** Override format detection. */
  format?: LogFormat;
  /** Pre-set logger context (e.g. service version, env). */
  base?: Record<string, unknown>;
  /** Disable writing to stdout (useful when wrapping in tests). */
  silent?: boolean;
};

const DEFAULT_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'headers["authorization"]',
  'headers["cookie"]',
  'headers["set-cookie"]',
  "password",
  "token",
  "secret",
  "*.password",
  "*.token",
  "*.secret",
];

const isProduction = (): boolean => process.env.NODE_ENV === "production";

const resolveFormat = (override?: LogFormat): LogFormat => {
  if (override) return override;
  const fromEnv = process.env.LOG_FORMAT;
  if (fromEnv === "json" || fromEnv === "pretty") return fromEnv;
  return isProduction() ? "json" : "pretty";
};

const resolveLevel = (override?: LogLevel): LogLevel => {
  if (override) return override;
  const fromEnv = process.env.LOG_LEVEL as LogLevel | undefined;
  if (fromEnv) return fromEnv;
  return isProduction() ? "info" : "debug";
};

/**
 * Create a root pino logger.
 *
 * @example
 *   const logger = createLogger({ service: "api" });
 *   const child = logger.child({ requestId: "abc" });
 *   child.info({ route: "/health" }, "request complete");
 */
export const createLogger = (options: CreateLoggerOptions = {}): PinoLogger => {
  const format = resolveFormat(options.format);
  const level = resolveLevel(options.level);

  const pinoOptions: Parameters<typeof pino>[0] = {
    level,
    base: {
      service: options.service ?? "neuro-pay",
      env: process.env.NODE_ENV ?? "development",
      ...options.base,
    },
    redact: {
      paths: DEFAULT_REDACT_PATHS,
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(options.silent ? { enabled: false } : {}),
  };

  if (format === "pretty") {
    // pino-pretty is loaded dynamically so production bundles ship
    // the fast JSON path only.
    return pino({
      ...pinoOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
          singleLine: true,
        },
      },
    });
  }

  return pino(pinoOptions);
};

/** Convenience: child logger with structured context. */
export const withContext = (
  logger: PinoLogger,
  context: LogContext,
): PinoLogger => logger.child(context);

export type { PinoLogger as Logger };
