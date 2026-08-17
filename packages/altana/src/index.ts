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

// Altana client construction.
export {
  buildAltanaClient,
  DecimalsMismatchError,
  networkConfigFor,
  publicClientFor,
} from "./client.js";
export type { AltanaClientContext } from "./client.js";

// Wallet provisioning.
export { provisionWallet } from "./wallet.js";
export type { WalletProvisionResult } from "./wallet.js";

// Spend-limit derivation.
export { deriveSpendLimit, SpendLimitError } from "./spend.js";

// Session codec.
export {
  CodecError,
  decode,
  decodeAndVerify,
  encode,
} from "./session/codec.js";
export type { EncodedBigint } from "./session/codec.js";

// Session persistence.
export {
  SessionStore,
  SessionStoreError,
  NO_SIGNER_SOURCE,
} from "./session/store.js";
export type {
  ResolvedSession,
  SessionStoreOptions,
  SignerSource,
} from "./session/store.js";
export type {
  PersistedSession,
  PersistedSessionPermissions,
  PersistedCallPermission,
  PersistedSpendPermission,
} from "./session/persisted.js";

// Session grant.
export { grantSession, GrantError } from "./session/grant.js";

// Session authority.
export { checkSessionAuthority, deriveKeyId } from "./session/authority.js";
export type {
  AuthorityCheckInput,
  AuthorityResult,
  AuthorityStatus,
} from "./session/authority.js";

// Session revocation.
export { revokeSession } from "./session/revoke.js";
export type {
  RevokeSessionResult,
  RevokeSessionInput,
  OnChainRevokeStatus,
} from "./session/revoke.js";

// Rail provisioning.
export {
  assertPermit2Deployed,
  Permit2NotDeployedError,
  provisionRail,
} from "./rail.js";
export type { ProvisionRailInput, ProvisionRailResult } from "./rail.js";
