/**
 * `@neuro-pay/ledger` — append-only payment ledger for the x402
 * metered-payment loop.
 *
 * The package owns the durably-recorded trail of every payment-relevant
 * event. It does not own chain reads, signing, or settlement: those live
 * in `@neuro-pay/altana` and `apps/api`. What it does own is the
 * invariant that the trail is append-only, exact, and free of any
 * material a private key could be reconstructed from.
 *
 * Entry points:
 *
 * - `openLedgerStore(options)` — open an on-disk ledger (or an
 *   `:memory:` one for tests).
 * - `recordEvent*` helpers in `./events.js` — typed write helpers for
 *   every event the spec defines.
 * - `lookup.ts` — query by authorization nonce.
 * - `window.ts` — derive per-session window spend and remaining
 *   budgets against both the local mirror and the on-chain cap.
 * - `exposure.ts` — compute unsettled exposure across streams.
 *
 * Re-exports only what `apps/api` and the console consumers need; the
 * lower-level store and field codecs are accessible through `./store.js`
 * and `./secrets.js` for tests.
 */

export type {
  AppendInput,
  LedgerStore,
  LedgerStoreOptions,
} from "./store.js";
export {
  KeyMaterialRejectedError,
  openLedgerStore,
  resetLedgerStorage,
  findLedgerFiles,
} from "./store.js";

export {
  detectKeyMaterial,
  assertNoKeyMaterial,
  KEY_MATERIAL_EXEMPT_FIELDS,
} from "./secrets.js";

export {
  recordAccrual,
  recordCorrection,
  recordPaymentDemanded,
  recordPaymentRejected,
  recordPaymentRefused,
  recordPaymentSigned,
  recordPaymentVerified,
  recordSegmentDelivered,
  recordSessionGranted,
  recordSessionRevoked,
  recordSettlementConfirmed,
  recordSettlementFailed,
  recordSettlementSubmitted,
  recordStreamEnded,
  recordStreamOpened,
} from "./events.js";

export type {
  AccrualRecordedInput,
  EventContext,
  EventResult,
  PaymentDemandedInput,
  PaymentRejectedInput,
  PaymentRefusedInput,
  PaymentSignedInput,
  PaymentVerifiedInput,
  SegmentDeliveredInput,
  SessionGrantedInput,
  SessionRevokedInput,
  SettlementConfirmedInput,
  SettlementFailedInput,
  SettlementSubmittedInput,
  StreamEndedInput,
  StreamOpenedInput,
} from "./events.js";

export {
  detectDuplicateNonces,
  isNonceAlreadyVerified,
  lookupByNonce,
} from "./lookup.js";
export type { LifecycleByNonce } from "./lookup.js";

export { budgetHeadroom, computeWindowSpend, fraction } from "./window.js";
export type {
  BudgetHeadroom,
  Fraction,
  WindowSpend,
  WindowSpendInputs,
} from "./window.js";

export {
  computeUnsettledExposure,
  totalInFlightExposure,
  totalUnrecoveredExposure,
} from "./exposure.js";
export type { UnsettledExposure } from "./exposure.js";
