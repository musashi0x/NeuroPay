import type { PillTone } from "@/components/ui";

/**
 * Re-export of the ui/ Pill tone union under the historical name, so the
 * existing tone-mapping helpers (`toneFor`, `streamTone`) keep working
 * without knowing the ui/ layer exists.
 */
export type StatusTone = PillTone;

export { Row } from "./Row";
export { formatDuration, formatPeriod } from "./format";
export { useRemaining } from "./useRemaining";
export { toneFor } from "./toneFor";
export { configuredSymbol } from "./symbol";
