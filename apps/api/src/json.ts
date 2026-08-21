/**
 * JSON codec for wire types that carry `bigint` amounts.
 *
 * Re-exported from `@neuro-pay/types` so the API encoder and the web
 * reviver cannot drift.
 */

export { reviveBigints, toJsonSafe } from "@neuro-pay/types";
