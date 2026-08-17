/**
 * The Altana SDK boundary: chain configuration, client construction, the
 * wallet and session lifecycle, rail provisioning, and the x402 payment
 * client.
 *
 * This is the only package permitted to import `@altananetwork/sdk` and
 * `viem`. It is server-side only — key material lives here and must never
 * reach a browser bundle.
 */

export {
  DEFAULT_BUDGET_MARGIN,
  DEFAULT_CHAIN_ID,
  DEFAULT_MAX_IN_FLIGHT_SETTLEMENTS,
  DEFAULT_SESSION_LIFETIME_SECONDS,
  DEFAULT_SESSION_SPEND_PERIOD_SECONDS,
  DEFAULT_TICK_INTERVAL_SECONDS,
  loadAppConfig,
} from "./config/config.js";
export {
  ConfigError,
  InvalidConfigError,
  MissingConfigError,
} from "./config/errors.js";
export type { EnvSource } from "./config/env.js";

export type {
  AppConfig,
  ChainConfig,
  MeteringConfig,
  SecretsConfig,
  SessionConfig,
} from "@neuro-pay/types";
