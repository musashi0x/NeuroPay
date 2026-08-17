/**
 * The only source of time the metering policy reads.
 *
 * Every policy decision that depends on elapsed time — the tick, the budget
 * window roll, the projected-duration-versus-expiry check — takes a `Clock`
 * rather than calling `Date.now()` directly, so the whole policy is testable
 * against a fake clock in milliseconds instead of against a wall clock.
 */
export type Clock = {
  /** Milliseconds since the Unix epoch. */
  now(): number;
};

/** The wall clock. Injected at the composition root, never inside the policy. */
export const systemClock: Clock = {
  now: () => Date.now(),
};
