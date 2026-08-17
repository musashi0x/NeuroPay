/**
 * The buyer's payment context.
 *
 * This is the bundle of state the payment client needs in order to
 * decide whether a given payment may go through. It is passed by the
 * caller (the agent process) so the payment client itself stays a pure
 * function over inputs — no global state, no hidden wiring.
 *
 * The fields:
 *  - `session`: the live SDK `Session` — the wallet the payment is on,
 *    and (via the session store) the signer used to produce the
 *    ERC-1271 envelope.
 *  - `walletAddress`: the smart-account wallet the payment is on.
 *    Carried alongside the session so the policy checks do not have to
 *    reach into SDK internals.
 *  - `chainId`: the configured chain. The selection step refuses any
 *    option off this chain.
 *  - `permittedTokens`: the set of `spend.allowlist` token addresses.
 *    An option naming a token outside this set is refused with
 *    `unpermitted-token`.
 *  - `budget`: the live budget window state. The pre-sign check uses
 *    it to refuse payments that would exceed the local budget.
 *  - `tolerance`: the demanded-vs-expected tolerance. The policy check
 *    uses it to refuse payments above the buyer's expected cost plus
 *    the configured slack.
 *  - `railProvisioned`: whether the rail has been provisioned against
 *    this session. False here is a hard refusal — the envelope would
 *    be unspendable otherwise.
 *  - `expiresAt`: the session's Unix epoch seconds expiry. The policy
 *    check refuses to sign once `now >= expiresAt`.
 *
 * `signer` is intentionally absent — it lives only in the session
 * store's signer source, which is also server-side. The payment client
 * gets the signer transitively, via `signX402PaymentFor`.
 */

import type {
  Address,
  BudgetState,
  SmallestUnits,
} from "@neuro-pay/types";
import type { Session } from "@altananetwork/sdk";

export type PaymentClientContext = {
  /** Live SDK session; the signer lives in the session store's signer source. */
  session: Session;
  /** Smart-account wallet the payment is on. */
  walletAddress: Address;
  /** Configured chain — selection refuses off-chain options. */
  chainId: number;
  /** Tokens the session has been granted `spend` permission for. */
  permittedTokens: ReadonlySet<Address>;
  /** Live budget window — pre-sign check uses it to refuse over-budget. */
  budget: BudgetState;
  /** Demanded-vs-expected tolerance, in `[0, 1)`. */
  tolerance: number;
  /** True once `provisionRail()` has completed against this session. */
  railProvisioned: boolean;
  /** Session Unix epoch seconds. The policy refuses at `now >= expiresAt`. */
  expiresAt: number;
  /** Injected clock for policy decisions; defaults to wall clock when absent. */
  now?: () => number;
};

/**
 * Convenience builder for `PaymentClientContext`.
 *
 * Exists so the call site does not have to assemble the shape by hand —
 * one builder call versus eight field assignments, and the defaults
 * (tolerance = 0, now = `Math.floor(Date.now()/1000)`) live in one place.
 */
export function buildPaymentContext(input: {
  session: Session;
  walletAddress: Address;
  chainId: number;
  permittedTokens: ReadonlyArray<Address>;
  budget: BudgetState;
  tolerance?: number;
  railProvisioned: boolean;
  expiresAt: number;
  now?: () => number;
}): PaymentClientContext {
  const ctx: PaymentClientContext = {
    session: input.session,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    permittedTokens: new Set(input.permittedTokens),
    budget: input.budget,
    tolerance: input.tolerance ?? 0,
    railProvisioned: input.railProvisioned,
    expiresAt: input.expiresAt,
  };
  if (input.now !== undefined) {
    ctx.now = input.now;
  }
  return ctx;
}

/** Re-exported so the call site does not need a second import for these types. */
export type { BudgetState, SmallestUnits };