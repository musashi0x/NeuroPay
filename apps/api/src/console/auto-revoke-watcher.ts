/**
 * Auto-revoke-on-failure watcher.
 *
 * Polls the ops service's `failedUnrecovered` metric on the same
 * cadence as the existing stream sweep, and — when armed — performs
 * the same kill-switch flow the manual console button triggers when
 * the count crosses the critical threshold. The trigger is latched:
 * once the count is at or above the threshold, the watcher does not
 * re-fire on subsequent ticks. The latch releases only when the
 * count drops back below the threshold (hysteresis).
 *
 * The flag is in-memory and process-local. A restart returns the
 * runtime to the disarmed state. See the runbook section
 * "Auto-revoke on critical failure" for the operational story.
 */

import type {
  AuditAction,
  AutoRevokeOnFailureView,
  IsoTimestamp,
} from "@neuro-pay/types";
import type { SessionStore } from "@neuro-pay/altana";
import type { LedgerStore } from "@neuro-pay/ledger";
import type { OpsService } from "../ops/service.js";
import { logger } from "../logger.js";
import type { ConsoleService, OperatorContext } from "./service.js";

export type CreateAutoRevokeWatcherInput = {
  ledger: LedgerStore;
  sessions: SessionStore;
  consoleService: ConsoleService;
  ops: OpsService;
  /** Trigger threshold; matches the existing critical alert. */
  failedSettlementCritical: number;
  /**
   * Defaults to 30s when undefined, matching the existing sweep cadence.
   * Typed `number | undefined` (not the stricter `?: number`) so the
   * composition root can forward an optional env value verbatim
   * under `exactOptionalPropertyTypes: true`.
   */
  sweepIntervalMs?: number | undefined;
  /** Test hook: deterministic clock. Defaults to `Date.now`. */
  now?: () => number;
};

export type AutoRevokeWatcher = {
  arm(): void;
  disarm(): void;
  status(): AutoRevokeOnFailureView;
  /** Evaluate the threshold once without waiting for the next tick. */
  evaluate(): Promise<void>;
  close(): void;
};

const DEFAULT_SWEEP_MS = 30_000;
const FIRED_AUDIT_ACTION: AuditAction = "session.auto-revoke.fired";

export function createAutoRevokeWatcher(
  input: CreateAutoRevokeWatcherInput,
): AutoRevokeWatcher {
  const now = input.now ?? (() => Date.now());
  const intervalMs = input.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  const threshold = input.failedSettlementCritical;

  let enabled = false;
  let lastFiredAt: IsoTimestamp | null = null;
  /** True when the count is at or above the threshold; suppresses re-fire. */
  let latched = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Find the wallet the console binds to. Same lexicographic-first
   * rule the console service uses, so the watcher and the operator
   * look at the same session.
   */
  function activeWallet(): string | undefined {
    const wallets = [...input.sessions.list()].sort();
    return wallets[0];
  }

  /**
   * Read the current `failedUnrecovered` from the ops service. Returns
   * 0 on read failure so a transient ops error does not trip the
   * trigger — the next tick retries.
   */
  async function readUnrecoveredCount(): Promise<number> {
    try {
      const snapshot = await input.ops.metrics();
      return snapshot.ledger.settlement.failedUnrecovered;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auto-revoke watcher: ops metrics read failed; skipping tick",
      );
      return 0;
    }
  }

  /**
   * Drive the kill switch through the console service so the local
   * revoke, the on-chain revoke, the stream-end fan-out, the ledger
   * event, and the manual audit entry all happen in the proven
   * order. Then append our own `session.auto-revoke.fired` audit
   * entry with the trigger context — two entries for one action is
   * the right shape: one says "kill switch invoked", the other says
   * "this was an auto-revoke with these trigger details".
   */
  async function fireKillSwitch(count: number): Promise<void> {
    const wallet = activeWallet();
    if (!wallet) {
      logger.warn(
        "auto-revoke watcher: threshold crossed but no active session; skipping fire",
      );
      return;
    }

    const firedAt = new Date(now()).toISOString();
    const triggerDetail = `count=${count} threshold=${threshold} wallet=${wallet}`;
    const sysContext: OperatorContext = { actor: "system" };

    try {
      // Drive the same kill switch the manual console button triggers.
      // The console service records its own audit row (the default
      // action "session.revoke.requested") — that entry says "kill
      // switch was invoked" and is the same one a manual operator
      // gets. After it returns, we append a separate
      // "session.auto-revoke.fired" entry that names the trigger
      // (count, threshold, wallet). Two distinct actions, two
      // distinct facts.
      await input.consoleService.revoke(sysContext);
      lastFiredAt = firedAt;
      await input.ledger
        .appendAudit({
          action: FIRED_AUDIT_ACTION,
          actor: "system",
          outcome: "succeeded",
          subject: wallet,
          detail: triggerDetail,
        })
        .catch((err: unknown) => {
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              action: FIRED_AUDIT_ACTION,
            },
            "auto-revoke fired audit write failed",
          );
        });
      logger.warn(
        { count, threshold, wallet },
        "auto-revoke fired: critical unrecovered count crossed",
      );
    } catch (err) {
      // The console service's audit-trail write may have already
      // landed; record the failure mode so an operator can tell
      // "kill switch threw" from "kill switch was never attempted".
      await input.ledger
        .appendAudit({
          action: FIRED_AUDIT_ACTION,
          actor: "system",
          outcome: "failed",
          subject: wallet,
          detail: `${triggerDetail} error=${err instanceof Error ? err.message : String(err)}`,
        })
        .catch(() => {
          // Same swallow-the-audit policy as the console service.
        });
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          count,
          threshold,
          wallet,
        },
        "auto-revoke kill switch threw",
      );
    }
  }

  async function tick(): Promise<void> {
    const count = await readUnrecoveredCount();
    if (count >= threshold) {
      if (!latched && enabled) {
        await fireKillSwitch(count);
      }
      latched = true;
    } else {
      // Hysteresis: only release the latch when the count is strictly
      // below the threshold. A count that stays at the threshold keeps
      // the latch engaged; a real recovery drops it back to <
      // threshold.
      latched = false;
    }
  }

  // Set the timer up once at construction. The tick runs every
  // intervalMs regardless of arm/disarm; arm/disarm only controls
  // whether a tick above the threshold fires the kill switch. This
  // keeps the "armed but never fired" state observable in the
  // status() snapshot and avoids a re-subscription race on arm().
  timer = setInterval(() => {
    void tick().catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auto-revoke watcher: tick failed",
      );
    });
  }, intervalMs);
  timer.unref?.();

  return {
    arm() {
      if (enabled) return;
      enabled = true;
      // Re-evaluate immediately so a process that arms while the
      // ledger is already past the threshold fires on the arm, not
      // on the next sweep tick.
      void tick().catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "auto-revoke watcher: arm-time evaluate failed",
        );
      });
      logger.info({ threshold }, "auto-revoke armed");
    },
    disarm() {
      if (!enabled) return;
      enabled = false;
      logger.info("auto-revoke disarmed");
    },
    status(): AutoRevokeOnFailureView {
      return { enabled, lastFiredAt };
    },
    evaluate: tick,
    close() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      enabled = false;
    },
  };
}
