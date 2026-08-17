/**
 * The settlement policy: the price sheet, the threshold-or-tick meter, and the
 * budget mirror.
 *
 * This package is deliberately chain-free. It imports no wallet, no RPC
 * client, and no HTTP client, and `src/boundary.test.ts` fails the build if a
 * dependency on one is ever added. Keeping the policy pure is what lets the
 * cases where the subtle bugs live — rounding, window rolls, refusals — be
 * tested against a fake clock without a testnet.
 */

export type { Clock } from "./clock.js";
export { systemClock } from "./clock.js";

// The chain-free contracts the policy operates over, re-exported so callers do
// not need a second import to name a policy input.
export type {
  BudgetState,
  MeteringConfig,
  PriceSheet,
  SmallestUnits,
} from "@neuro-pay/types";
