/**
 * Shared test fixtures for the x402 payment client.
 *
 * Centralized so each test file uses the same requirement shapes, the
 * same canned envelopes, and the same session stub. The fixtures model
 * the real b402 wire form (Permit2 on BNB) end-to-end: a `402` body
 * with a permit2 option, a normalized requirement, a typed-data
 * digest, and the 98-byte nested ERC-1271 envelope the SDK would
 * produce when the signX402Payment code path runs against a real
 * session key.
 *
 * Everything here is exported as `as const` so the test can pin types
 * against the typed `X402Requirement` shape without `as` casts.
 */
import type {
  Address,
  X402PaymentRequired,
  X402Requirement,
} from "@neuro-pay/types";
import type { Session, X402PaymentPayload } from "@altananetwork/sdk";

/** A canonical merchant wallet address. Not derived from any real key. */
export const MERCHANT_PAY_TO: Address =
  "0xA1B2c3D4e5F60718293a4B5c6d7E8F9012345678";

/** The smart-account wallet the payment is on. */
export const WALLET_ADDRESS: Address =
  "0x1111111111111111111111111111111111111111";

/** A permitted token (USDC on BNB). */
export const PERMITTED_TOKEN: Address =
  "0x55d398326f99059fF775485246999027B3197955";

/** A token the session has NOT been granted spend permission for. */
export const UNPERMITTED_TOKEN: Address =
  "0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef";

/** BNB mainnet chain id. */
export const BNB_CHAIN_ID = 56;

/** An alt chain id (e.g. Base) the buyer is NOT configured on. */
export const ALT_CHAIN_ID = 8453;

/**
 * The 98-byte nested ERC-1271 envelope the SDK produces for a
 * session-key signature.
 *
 * Format: `innerSig ‖ keyHash ‖ prehash`, exactly 32+32+32 = 96 bytes
 * plus a 2-byte prefix → 98 bytes. Filled with sentinel hex so the
 * shape is recognizable in test failures. The signature is NOT a valid
 * 65-byte EOA signature — the spec calls this out as the assertion
 * that distinguishes smart-account envelopes from bare EOA sigs.
 */
export const NESTED_ERC1271_ENVELOPE = (
  "0x" +
  // 2-byte envelope prefix
  "a1b2" +
  // 32-byte inner signature blob
  "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff" +
  // 32-byte keyHash
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" +
  // 32-byte prehash
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
) as `0x${string}`;

/** Asserts the envelope is exactly 98 bytes (2 + 32 + 32 + 32). */
export const NESTED_ERC1271_BYTES = 98;
assertEnvelopeLength(NESTED_ERC1271_ENVELOPE);

function assertEnvelopeLength(envelope: `0x${string}`): void {
  const hex = envelope.startsWith("0x") ? envelope.slice(2) : envelope;
  const bytes = hex.length / 2;
  if (bytes !== NESTED_ERC1271_BYTES) {
    throw new Error(
      `Test fixture invariant: NESTED_ERC1271_ENVELOPE is ${bytes} bytes, expected ${NESTED_ERC1271_BYTES}. ` +
        `The spec's whole point is the 98-byte envelope; if this fires, the fixture is wrong.`,
    );
  }
}

/**
 * A canonical permit2 requirement on the configured chain.
 *
 * Has both a non-empty `resource` and the canonical BNB `network`
 * label. Tests use this as the "happy path" requirement.
 */
export const PERMIT2_REQUIREMENT: X402Requirement = {
  scheme: "exact",
  network: "eip155:56",
  chainId: BNB_CHAIN_ID,
  rail: "permit2",
  asset: PERMITTED_TOKEN,
  assetDecimals: 18,
  maxAmountRequired: 1_000_000n,
  payTo: MERCHANT_PAY_TO,
  resource: "https://example.com/api/data",
  description: "data feed",
  mimeType: "application/json",
  maxTimeoutSeconds: 60,
  extra: { name: null, version: null, verifyingContract: null },
};

/**
 * An EIP-3009 requirement on the same chain and token.
 * Used to assert that permit2 wins when both are present.
 */
export const EIP3009_REQUIREMENT: X402Requirement = {
  ...PERMIT2_REQUIREMENT,
  rail: "eip3009",
};

/** A permit2 requirement on the wrong chain (Base). */
export const WRONG_CHAIN_REQUIREMENT: X402Requirement = {
  ...PERMIT2_REQUIREMENT,
  chainId: ALT_CHAIN_ID,
  network: "eip155:8453",
};

/** A permit2 requirement on the configured chain but with an unpermitted token. */
export const UNPERMITTED_TOKEN_REQUIREMENT: X402Requirement = {
  ...PERMIT2_REQUIREMENT,
  asset: UNPERMITTED_TOKEN,
};

/** A standard 402 body carrying the canonical permit2 option. */
export const PAYMENT_REQUIRED_BODY: X402PaymentRequired = {
  x402Version: 2,
  error: null,
  accepts: [PERMIT2_REQUIREMENT],
};

/**
 * A canonical signed SDK payload — what `signX402Payment` returns.
 *
 * `payload.signature` is the 98-byte nested ERC-1271 envelope.
 * `payload.payload` carries the typed-data fields the SDK produced.
 */
export const SIGNED_SDK_PAYLOAD: X402PaymentPayload = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:56",
  accepted: {
    scheme: "exact",
    network: "eip155:56",
    asset: PERMITTED_TOKEN,
    amount: "1000000",
    payTo: MERCHANT_PAY_TO,
  },
  resource: {
    url: "https://example.com/api/data",
    description: "data feed",
    mimeType: "application/json",
  },
  payload: {
    signature: NESTED_ERC1271_ENVELOPE,
    // Permit2 typed-data fields, named to match the SDK's payload shape.
    permitted: {
      token: PERMITTED_TOKEN,
      amount: "1000000",
      nonce: "12345",
      deadline: "1700000000",
    },
    spender: MERCHANT_PAY_TO,
    nonce: "12345",
    deadline: "1700000000",
  },
};

/** A live session — the SDK's session type. The test doesn't exercise the signer. */
export function makeSession(): Session {
  return {
    walletAddress: WALLET_ADDRESS,
    // The signer is required by the type but signX402PaymentFor is
    // mocked away in tests that exercise the wrapper. The dummy
    // object below is just enough to satisfy the type.
    signer: {
      type: "private-key",
      address: WALLET_ADDRESS,
      sign: async () => "0x",
    } as unknown as Session["signer"],
    publicKey: ("0x" + "00".repeat(32)) as `0x${string}`,
    permissions: {
      calls: [{ signature: "exact", to: MERCHANT_PAY_TO }],
      spend: [{ limit: 1_000_000_000n, period: "day", token: PERMITTED_TOKEN }],
    },
    expiry: 1_700_000_000,
  };
}

/** A budget state with healthy room under both limits. */
export const HEALTHY_BUDGET = {
  token: PERMITTED_TOKEN,
  tokenDecimals: 18,
  windowStart: "2024-01-01T00:00:00.000Z",
  windowEnd: "2024-01-02T00:00:00.000Z",
  periodSeconds: 86_400,
  spent: 0n,
  localLimit: 1_000_000_000n,
  localRemaining: 1_000_000_000n,
  onChainCap: 2_000_000_000n,
  onChainRemaining: 2_000_000_000n,
  exhausted: false,
};

/** A budget state with zero local remaining (over-budget). */
export const EXHAUSTED_BUDGET = {
  ...HEALTHY_BUDGET,
  spent: 1_000_000_000n,
  localRemaining: 0n,
  exhausted: true,
};
