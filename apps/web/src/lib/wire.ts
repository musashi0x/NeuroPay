/**
 * Revive decimal-string amounts that the API encoded from `bigint`.
 * Known amount keys only — a nonce that happens to be numeric stays a string.
 *
 * Re-exported from `@neuro-pay/types` so this reviver cannot drift from
 * the API encoder.
 */

export { reviveWire } from "@neuro-pay/types";
