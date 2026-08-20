/**
 * Coverage for the administrative audit trail.
 *
 * The trail is only worth having if it holds under the same rules the
 * payment ledger does, so the tests assert those rules rather than the
 * happy path alone: ordering independent of payment traffic, an
 * unattributable write refused, and key material refused.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { KeyMaterialRejectedError } from "../src/secrets.js";
import { recordStreamOpened } from "../src/events.js";
import {
  newLedger,
  resetIdCounter,
  SAMPLE_CHAIN_ID,
  SAMPLE_TOKEN,
  SAMPLE_TOKEN_DECIMALS,
} from "./_fixtures.js";

const ctx = {
  streamId: "stream-1",
  sessionPublicKey: null,
  chainId: SAMPLE_CHAIN_ID,
  token: SAMPLE_TOKEN,
  tokenDecimals: SAMPLE_TOKEN_DECIMALS,
};

beforeEach(() => {
  resetIdCounter();
});

describe("appendAudit", () => {
  it("stamps id, sequence, and timestamp and returns the stored record", async () => {
    const store = newLedger();
    const event = await store.appendAudit({
      action: "session.revoke.requested",
      actor: "operator",
      outcome: "requested",
      subject: "0x1111111111111111111111111111111111111111",
      requestId: "req-7",
      detail: "kill switch from console",
    });

    expect(event.sequence).toBe(1);
    expect(event.id).toBe("id-0001");
    expect(event.action).toBe("session.revoke.requested");
    expect(event.outcome).toBe("requested");
    expect(event.requestId).toBe("req-7");
    expect(await store.auditEvents()).toEqual([event]);
    store.close();
  });

  it("orders audit records independently of payment traffic", async () => {
    const store = newLedger();
    await store.appendAudit({
      action: "process.started",
      actor: "system",
      outcome: "succeeded",
    });
    // Payment events in between must not consume audit sequence numbers;
    // a trail whose numbers jump reads as if records were deleted.
    await recordStreamOpened({ store, ctx });
    await recordStreamOpened({ store, ctx });
    const second = await store.appendAudit({
      action: "process.stopped",
      actor: "system",
      outcome: "succeeded",
    });

    expect(second.sequence).toBe(2);
    expect((await store.auditEvents()).map((e) => e.sequence)).toEqual([1, 2]);
    expect(await store.size()).toBe(2);
    store.close();
  });

  it("filters by action and returns the most recent N in write order", async () => {
    const store = newLedger();
    for (let i = 0; i < 4; i += 1) {
      await store.appendAudit({
        action: "prices.updated",
        actor: "operator",
        outcome: "succeeded",
        detail: `change-${i}`,
      });
      await store.appendAudit({
        action: "config.changed",
        actor: "operator",
        outcome: "succeeded",
      });
    }

    const prices = await store.auditEvents({ action: "prices.updated" });
    expect(prices).toHaveLength(4);
    expect(prices.map((e) => e.detail)).toEqual([
      "change-0",
      "change-1",
      "change-2",
      "change-3",
    ]);

    const recent = await store.auditEvents({
      action: "prices.updated",
      limit: 2,
    });
    expect(recent.map((e) => e.detail)).toEqual(["change-2", "change-3"]);
    store.close();
  });

  it("refuses a record with no actor", async () => {
    const store = newLedger();
    await expect(
      store.appendAudit({
        action: "config.changed",
        actor: "   ",
        outcome: "succeeded",
      }),
    ).rejects.toThrow(TypeError);
    expect(await store.auditEvents()).toEqual([]);
    store.close();
  });

  it("refuses an unknown outcome", async () => {
    const store = newLedger();
    await expect(
      store.appendAudit({
        action: "config.changed",
        actor: "operator",
        outcome: "maybe" as never,
      }),
    ).rejects.toThrow(TypeError);
    store.close();
  });

  it("refuses key material pasted into an operator note", async () => {
    const store = newLedger();
    await expect(
      store.appendAudit({
        action: "session.granted",
        actor: "script:provision",
        outcome: "succeeded",
        detail: `granted with 0x${"ab".repeat(32)}`,
      }),
    ).rejects.toThrow(KeyMaterialRejectedError);
    expect(await store.auditEvents()).toEqual([]);
    store.close();
  });
});
