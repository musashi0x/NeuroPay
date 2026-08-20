/**
 * Real signed envelopes for seller-side tests.
 *
 * Every seller fixture used to be hand-written JSON that described what
 * we *believed* the buyer sent. All of it was wrong, and because both
 * sides were tested against their own beliefs, nothing caught it until a
 * funded testnet wallet did.
 *
 * So these fixtures are produced by running the actual code path:
 * `@altananetwork/sdk`'s `signX402Payment` (through our own
 * `signX402PaymentFor` wrapper and b402 encoder) against a real session
 * key. No network is involved — `signErc1271` is pure crypto over a
 * private key — but every byte on the wire is the byte a real buyer
 * produces. A test that passes against these is a test that has actually
 * round-tripped.
 *
 * The one thing these cannot prove is that `isValidSignature` accepts the
 * signature on chain; that needs a deployed account. What they do prove
 * is that the seller parses the real shape, recomputes the same digest
 * the buyer signed, and hands the settler arguments Permit2 would rebuild
 * that same digest from.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Session } from "@altananetwork/sdk";

import { signX402PaymentFor, permit2WitnessDigest } from "@neuro-pay/altana";
import type {
  Address,
  Hex,
  SmallestUnits,
  X402Requirement,
} from "@neuro-pay/types";

export const CHAIN_ID = 97;
export const TOKEN: Address = "0x55d398326f99059ff775485246999027b3197955";
export const PAY_TO: Address = "0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
/** The merchant's settler EOA — the Permit2 `spender`. Distinct from `payTo`. */
export const SETTLER: Address = "0x5e771e4000000000000000000000000000005e77";

export const RESOURCE_URL = "https://api.example/v1/streams/stream-1/next";

/**
 * Build an offline `Session`.
 *
 * A Session is just a wallet address plus a signer; `signX402Payment`
 * touches no RPC, so a random key is a complete buyer for signing
 * purposes. `walletAddress` is deliberately a different address from the
 * session key's own — that is the smart-account arrangement the ERC-1271
 * envelope encodes.
 */
export function offlineSession(options: { walletAddress?: Address } = {}): {
  session: Session;
  walletAddress: Address;
} {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const walletAddress =
    options.walletAddress ??
    ("0x1111111111111111111111111111111111111111" as Address);
  const session = {
    walletAddress,
    signer: {
      type: "privateKey",
      address: account.address,
      publicKey: account.publicKey,
      _privateKey: privateKey,
      async signDigest(digest: Hex) {
        return account.sign({ hash: digest });
      },
    },
    publicKey: account.publicKey,
    permissions: {},
    expiry: Math.floor(Date.now() / 1000) + 3600,
  } as unknown as Session;
  return { session, walletAddress };
}

/** A permit2-exact requirement shaped exactly as `requirementsFor` emits it. */
export function requirement(
  overrides: Partial<X402Requirement> = {},
): X402Requirement {
  return {
    scheme: "exact",
    network: "bsc-testnet",
    chainId: CHAIN_ID,
    rail: "permit2",
    asset: TOKEN,
    assetDecimals: 18,
    maxAmountRequired: 1000n as SmallestUnits,
    payTo: PAY_TO,
    resource: RESOURCE_URL,
    description: "calls usage on stream",
    mimeType: "application/octet-stream",
    maxTimeoutSeconds: 60,
    extra: {
      name: null,
      version: null,
      verifyingContract: null,
      spenderAddress: SETTLER,
      assetTransferMethod: "permit2-exact",
    },
    ...overrides,
  };
}

export type SignedFixture = {
  /** The base64 `X-PAYMENT` / `PAYMENT-SIGNATURE` value. */
  header: string;
  /** The payer (smart-account) address. */
  payer: Address;
  /** The EIP-712 digest the buyer actually signed. */
  digest: Hex;
  /** The signature bytes on the wire. */
  signature: Hex;
  nonce: string;
  deadline: number;
  requirement: X402Requirement;
};

/**
 * Sign a requirement for real and return the wire header plus the digest
 * the buyer signed, so a test can assert the seller recomputes the same
 * value rather than trusting a hand-copied constant.
 */
export async function signRealEnvelope(
  options: {
    requirement?: X402Requirement;
    now?: number;
    permit2Nonce?: bigint;
  } = {},
): Promise<SignedFixture> {
  const req = options.requirement ?? requirement();
  const { session, walletAddress } = offlineSession();
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const nonce = options.permit2Nonce ?? 424242n;

  const result = await signX402PaymentFor({
    session,
    requirement: req,
    resourceUrl: RESOURCE_URL,
    payerAddress: walletAddress,
    now,
    permit2Nonce: nonce,
  });

  const deadline = now + req.maxTimeoutSeconds;
  const digest = permit2WitnessDigest({
    chainId: req.chainId,
    authorization: {
      permitted: { token: req.asset, amount: req.maxAmountRequired },
      spender: req.extra?.spenderAddress as Address,
      nonce: nonce.toString(10),
      deadline,
      witness: { to: req.payTo, validAfter: "0" },
    },
  });

  return {
    header: result.header,
    payer: walletAddress,
    digest,
    signature: result.envelope.decoded.payload.signature as Hex,
    nonce: nonce.toString(10),
    deadline,
    requirement: req,
  };
}

/** A header bag matching the shape `parseEnvelopeFromHeaders` reads. */
export function headersFor(header: string, names: string[] = ["x-payment"]) {
  const bag = new Map(names.map((n) => [n, header]));
  return {
    get(name: string): string | null {
      return bag.get(name.toLowerCase()) ?? null;
    },
  };
}
