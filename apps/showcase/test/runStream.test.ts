/**
 * Unit tests for the showcase's buyer loop.
 *
 * The BFF does not own an HTTP server here — `runStream` is the test
 * target. We:
 *
 *  1. Write a real `PersistedSession` blob to a tempdir using the
 *     altana codec, so `SessionStore.loadFromDisk` round-trips.
 *  2. Stub `fetchImpl` to model the seller: an open response, then
 *     402 → 200 (paid), a 200 (free), and a classified refusal.
 *  3. Drive `runStream` and assert the exact event sequence.
 *
 * The signer is real (`signerFromPrivateKey`). The SDK produces a real
 * signature; the stubbed seller doesn't check it, so no chain is touched.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encode, type PersistedSession } from "@neuro-pay/altana";

import { runStream, renderSseEvent, type RunEvent } from "../src/lib/runStream";

const TEST_PRIVATE_KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const WALLET_ADDRESS =
  "0x1111111111111111111111111111111111111111" as `0x${string}`;
const PAY_TO = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const TOKEN = "0x55d398326f99059fF775485246999027B3197955" as `0x${string}`;
const SETTLER = "0x5e771e4000000000000000000000000000005e77" as `0x${string}`;

const PERMIT2_REQUIREMENT = {
  scheme: "exact",
  network: "eip155:56",
  chainId: 56,
  rail: "permit2",
  asset: TOKEN,
  assetDecimals: 18,
  maxAmountRequired: 1_000_000n,
  payTo: PAY_TO,
  resource: "http://localhost:4000/v1/streams/abc/next",
  description: "data feed",
  mimeType: "application/json",
  maxTimeoutSeconds: 60,
  extra: {
    name: null,
    version: null,
    verifyingContract: null,
    spenderAddress: SETTLER,
    assetTransferMethod: "permit2-exact",
  },
};

const OPEN_RESPONSE = {
  streamId: "stream-abc",
  priceSheet: {
    id: "default",
    version: 1,
    chainId: 56,
    token: TOKEN,
    tokenDecimals: 18,
    perCall: 0n,
    perSecond: 1_000_000n,
    perUnit: 0n,
    unitName: "token",
    issuedAt: "2024-01-01T00:00:00.000Z",
  },
  chainId: 56,
  token: TOKEN,
  tokenDecimals: 18,
  payTo: PAY_TO,
  openedAt: "2024-01-01T00:00:00.000Z",
  expiresAt: "2024-01-01T01:00:00.000Z",
  maxSecondsPerSegment: 60,
  maxUnitsPerSegment: 1,
};

function makeSegmentPayload(sequence: number, streamEnded: boolean) {
  return {
    streamId: "stream-abc",
    sequence,
    data: "ok",
    secondsDelivered: 1,
    unitsDelivered: 0,
    accruedUnpaid: 0n,
    totalAccrued: 1_000_000n,
    streamEnded,
    endReason: null,
  };
}

function buildSession(): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "showcase-session-"));
  const path = join(dir, "session.json");
  const persisted: PersistedSession = {
    walletAddress: WALLET_ADDRESS,
    publicKey: ("0x" + "00".repeat(32)) as `0x${string}`,
    permissions: {
      calls: [{ signature: "exact", to: PAY_TO }],
      spend: [{ limit: 1_000_000_000n, period: "day", token: TOKEN }],
    },
    expiry: 4_102_444_800, // 2100-01-01
    grantTransactionHash: null,
    railProvisioned: true,
    createdAt: 1_700_000_000,
  };
  const blob = encode({ [WALLET_ADDRESS]: persisted });
  writeFileSync(path, blob, "utf8");
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function jsonResponse<T>(body: T, status: number): Response {
  return new Response(JSON.stringify(body, replacer), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

type FetchCall = ReturnType<typeof vi.fn>;

function okFetch(): {
  fetch: FetchCall;
  calls: { url: string; init?: RequestInit }[];
} {
  const fn = vi.fn(async () => {
    throw new Error("okFetch: no queued response");
  }) as FetchCall;
  // Use vi.fn's own call log instead of a side-channel array. Once a
  // mockResolvedValueOnce is queued, the default implementation is
  // bypassed, so a side-channel push would be lost.
  const calls = {
    get length(): number {
      return fn.mock.calls.length;
    },
    *[Symbol.iterator](): IterableIterator<{
      url: string;
      init?: RequestInit;
    }> {
      for (const call of fn.mock.calls) {
        yield {
          url: String(call[0]),
          init: call[1] as RequestInit | undefined,
        };
      }
    },
  } as unknown as { url: string; init?: RequestInit }[] & { length: number };
  return { fetch: fn, calls };
}

async function collectEvents(
  stream: AsyncGenerator<RunEvent, void, void>,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("runStream — open stream and pay 402", () => {
  let sessionPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const session = buildSession();
    sessionPath = session.path;
    cleanup = session.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("pays a 402 on the second segment and yields free/paid events", async () => {
    const { fetch, calls } = okFetch();
    // 1st call: POST /v1/streams (open).
    // 2nd call: GET next (first pull) — 402.
    // 3rd call: GET next (retry) — 200 paid.
    // 4th call: GET next (second pull) — 200 free.
    fetch
      .mockResolvedValueOnce(jsonResponse(OPEN_RESPONSE, 200))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            x402Version: 2,
            error: null,
            accepts: [PERMIT2_REQUIREMENT],
          },
          402,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(makeSegmentPayload(1, false), 200))
      .mockResolvedValueOnce(jsonResponse(makeSegmentPayload(2, true), 200));

    const events = await collectEvents(
      runStream({
        runId: "run-1",
        requestedSegments: 2,
        sellerUrl: "http://localhost:4000",
        storePath: sessionPath,
        privateKey: TEST_PRIVATE_KEY,
        budgetMargin: 0.2,
        segmentDelayMs: 0,
        tokenSymbol: "npUSD",
        fetchImpl: fetch as unknown as typeof fetch,
      }),
    );

    // Sequence: opened, segment (paid), budget, segment (free), done.
    console.log(JSON.stringify(events, null, 2));
    console.log(JSON.stringify(events, null, 2));
    expect(events.map((e) => e.kind)).toEqual([
      "opened",
      "segment",
      "budget",
      "segment",
      "done",
    ]);
    const opened = events[0]! as Extract<RunEvent, { kind: "opened" }>;
    expect(opened.streamId).toBe("stream-abc");
    expect(opened.tokenSymbol).toBe("npUSD");

    const firstSegment = events[1]! as Extract<RunEvent, { kind: "segment" }>;
    expect(firstSegment.delivery).toBe("paid");
    expect(firstSegment.amount).toBe("1000000");
    expect(firstSegment.sequence).toBe(1);

    const budget = events[2]! as Extract<RunEvent, { kind: "budget" }>;
    expect(budget.tokenSymbol).toBe("npUSD");
    expect(BigInt(budget.spent)).toBe(1_000_000n);

    const secondSegment = events[3]! as Extract<RunEvent, { kind: "segment" }>;
    expect(secondSegment.delivery).toBe("free");
    expect(secondSegment.amount).toBeNull();

    const done = events[4]! as Extract<RunEvent, { kind: "done" }>;
    expect(done.totalSegments).toBe(2);
    expect(done.totalPaid).toBe(1);
    expect(done.totalPaidAmount).toBe("1000000");

    // 4 calls: open + 402 + paid + free.
    expect(calls.length).toBe(4);
    const callList = [...calls];
    // Retry header carries the X-PAYMENT envelope.
    const retryInit = callList[2]!.init;
    const headers = new Headers(retryInit?.headers ?? {});
    expect(headers.get("X-PAYMENT")).not.toBeNull();
    expect(headers.get("PAYMENT-SIGNATURE")).not.toBeNull();
  });

  it("stops on a classified refusal and yields a refused event", async () => {
    const { fetch } = okFetch();
    fetch
      .mockResolvedValueOnce(jsonResponse(OPEN_RESPONSE, 200))
      // Pull 1: paid once.
      .mockResolvedValueOnce(
        jsonResponse(
          { x402Version: 2, error: null, accepts: [PERMIT2_REQUIREMENT] },
          402,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(makeSegmentPayload(1, false), 200))
      // Pull 2: 402 with a body that triggers a session-expired verdict
      // (resource window past the configured expiry). Easiest route: a
      // 402 whose amount exceeds the budget cap. The payment client's
      // policy check refuses with budget-exhausted before signing.
      .mockResolvedValueOnce(
        jsonResponse(
          {
            x402Version: 2,
            error: null,
            accepts: [
              { ...PERMIT2_REQUIREMENT, maxAmountRequired: 1_000_000_000_000n },
            ],
          },
          402,
        ),
      );

    const events = await collectEvents(
      runStream({
        runId: "run-2",
        requestedSegments: 2,
        sellerUrl: "http://localhost:4000",
        storePath: sessionPath,
        privateKey: TEST_PRIVATE_KEY,
        budgetMargin: 0.2,
        segmentDelayMs: 0,
        tokenSymbol: "npUSD",
        fetchImpl: fetch as unknown as typeof fetch,
      }),
    );

    expect(events.map((e) => e.kind)).toEqual([
      "opened",
      "segment",
      "budget",
      "refused",
    ]);
    const refused = events[3]! as Extract<RunEvent, { kind: "refused" }>;
    expect(refused.classification).toBe("budget-exhausted");
    expect(refused.sequence).toBe(2);
  });

  it("emits an error when the seller is unreachable at open", async () => {
    const { fetch } = okFetch();
    fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const events = await collectEvents(
      runStream({
        runId: "run-3",
        requestedSegments: 1,
        sellerUrl: "http://localhost:4000",
        storePath: sessionPath,
        privateKey: TEST_PRIVATE_KEY,
        budgetMargin: 0.2,
        segmentDelayMs: 0,
        tokenSymbol: "npUSD",
        fetchImpl: fetch as unknown as typeof fetch,
      }),
    );

    expect(events).toHaveLength(1);
    const error = events[0]! as Extract<RunEvent, { kind: "error" }>;
    expect(error.message).toMatch(/unreachable/i);
  });

  it("emits an error when the session store has no entries", async () => {
    const events = await collectEvents(
      runStream({
        runId: "run-4",
        requestedSegments: 1,
        sellerUrl: "http://localhost:4000",
        storePath: "/tmp/showcase-no-such-session.json",
        privateKey: TEST_PRIVATE_KEY,
        budgetMargin: 0.2,
        segmentDelayMs: 0,
        tokenSymbol: "npUSD",
      }),
    );

    expect(events).toHaveLength(1);
    const error = events[0]! as Extract<RunEvent, { kind: "error" }>;
    expect(error.message).toMatch(/no persisted session/i);
  });
});

describe("renderSseEvent", () => {
  it("renders a JSON data line with the trailing newline pair", () => {
    const out = renderSseEvent({
      kind: "done",
      runId: "x",
      streamId: "y",
      totalSegments: 0,
      totalPaid: 0,
      totalPaidAmount: "0",
    });
    expect(out).toBe(
      `data: ${JSON.stringify({
        kind: "done",
        runId: "x",
        streamId: "y",
        totalSegments: 0,
        totalPaid: 0,
        totalPaidAmount: "0",
      })}\n\n`,
    );
  });
});
