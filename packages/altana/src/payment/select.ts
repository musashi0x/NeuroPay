/**
 * Requirement selection.
 *
 * Picks one payable requirement from a `402` body. The selection rules
 * come straight from the spec:
 *
 *  1. The configured chain wins. An option on the configured chain is
 *     always preferred over an option on a foreign chain, even when the
 *     foreign chain has the more-preferred rail.
 *  2. Among options on the configured chain, `permit2` wins over
 *     `eip3009`. `permit2-exact` validates a smart-account signer
 *     on-chain via ERC-1271 for any token; `eip3009` only works for
 *     ERC-1271-aware tokens (FiatTokenV2_2), and BNB's tokens are not
 *     that.
 *  3. The token must be in the session's `spend` allowlist. A
 *     requirement on the configured chain naming a token we can't spend
 *     is an `unpermitted-token`, not a `no-payable-option` — the two
 *     failures have different remediations (open a new grant vs. adjust
 *     configuration) and they must not collapse.
 *
 * Each refusal carries a distinct `BuyerPaymentFailure` classification
 * so a `catch` site can branch without parsing the message.
 */

import type {
  X402PaymentRequired,
  X402Rail,
  X402Requirement,
  Address,
  SmallestUnits,
} from "@neuro-pay/types";
import { PaymentFailureError } from "./errors.js";

/**
 * Options for requirement selection.
 *
 * `chainId` is the configured chain — only options on this chain are
 * eligible. `permittedTokens` is the set of `spend.allowlist` token
 * addresses the session has been granted against; an option naming a
 * token outside this set is refused with `unpermitted-token`.
 * `resourceUrl` is the requested URL, used as the fallback when a
 * requirement omits its own `resource` — see `normalizeRequirement`.
 */
export type SelectOptions = {
  chainId: number;
  permittedTokens: ReadonlySet<Address>;
  /**
   * URL of the request being paid for. Used as the resource fallback
   * when the requirement's own `resource` is empty — see
   * `normalizeRequirement` for why the resource is always non-null.
   */
  resourceUrl: string;
};

/**
 * Select a payable requirement.
 *
 * The returned requirement is normalized: `resource` is non-null (taken
 * from the requirement if present, otherwise the request URL), and the
 * type is exactly `X402Requirement`. The caller can hand it to the
 * signer without further massaging.
 *
 * Throws `PaymentFailureError` with the appropriate classification on
 * each refusal path.
 */
export function selectX402Requirement(
  accepts: readonly X402Requirement[],
  options: SelectOptions,
): X402Requirement {
  if (accepts.length === 0) {
    throw new PaymentFailureError(
      "no-payable-option",
      `selectX402Requirement: 402 body carries no accepts[]. ` +
        `The merchant is refusing the request without offering a payable option.`,
    );
  }

  // First gate: split into "on the configured chain" vs "not". The spec
  // requires the configured chain win before anything else is considered;
  // an "all options on other chains" case is its own failure category.
  const onConfiguredChain = accepts.filter(
    (req) => req.chainId === options.chainId,
  );
  if (onConfiguredChain.length === 0) {
    const chainIds = [...new Set(accepts.map((req) => req.chainId))].sort();
    throw new PaymentFailureError(
      "wrong-chain-only",
      `selectX402Requirement: no option on configured chain ${options.chainId}. ` +
        `Available chains: ${chainIds.join(", ")}. ` +
        `Refusing to sign against a foreign chain.`,
      { detail: { configuredChainId: options.chainId, available: chainIds } },
    );
  }

  // Second gate: prefer permit2 over eip3009, but only among options that
  // name a token we can spend. The "permit2-first" preference is a stable
  // property — same chain, same shape, same outcome. We don't reorder
  // across tokens; an unpermitted token is refused outright.
  const candidates: X402Requirement[] = [];
  for (const req of onConfiguredChain) {
    if (!options.permittedTokens.has(req.asset)) {
      continue;
    }
    candidates.push(req);
  }
  if (candidates.length === 0) {
    const assets = [...new Set(onConfiguredChain.map((req) => req.asset))];
    throw new PaymentFailureError(
      "unpermitted-token",
      `selectX402Requirement: no option on configured chain names a token ` +
        `in the session's spend allowlist. Configured chain: ${options.chainId}. ` +
        `Tokens offered: ${assets.join(", ")}. Permitted: ` +
        `${[...options.permittedTokens].join(", ") || "(none)"}. ` +
        `Grant a new session with the merchant's token in its spend allowlist.`,
      {
        detail: {
          configuredChainId: options.chainId,
          offered: assets,
          permitted: [...options.permittedTokens],
        },
      },
    );
  }

  // Sort by rail preference (permit2 first), keeping the input order
  // stable across the two rails so the operator sees the same choice
  // each time. The sort key is small and the array is bounded by the
  // number of rails (two), so this is stable and deterministic.
  const preferred = pickPreferredRail(candidates);

  // Normalize the resource before returning. A `null` resource would be
  // rejected by b402 merchants (and is forbidden by the spec); the URL
  // fallback ensures the signed envelope is always non-null.
  return normalizeRequirement(preferred, options.resourceUrl);
}

/**
 * Pick the requirement with the most-preferred rail.
 *
 * `permit2` is preferred over `eip3009`; among ties, the first-listed
 * requirement wins. The function returns the requirement, not a copy,
 * so the caller can hand it straight to the signer.
 */
function pickPreferredRail(
  candidates: readonly X402Requirement[],
): X402Requirement {
  // Lower rank wins. `permit2` ranks 0, `eip3009` ranks 1. The rail union
  // is closed, but TypeScript's `noUncheckedIndexedAccess` insists on a
  // default; the fallback returns a high rank so an unrecognized rail is
  // never chosen over a recognized one.
  const rank = (rail: X402Rail): number =>
    rail === "permit2" ? 0 : rail === "eip3009" ? 1 : 2;
  let chosen: X402Requirement | undefined;
  let chosenRank = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateRank = rank(candidate.rail);
    if (chosen === undefined || candidateRank < chosenRank) {
      chosen = candidate;
      chosenRank = candidateRank;
    }
  }
  // `candidates` is non-empty by the time we get here (the caller has
  // already gated on length). The undefined branch is a guard, not a
  // reachable outcome.
  if (chosen === undefined) {
    throw new PaymentFailureError(
      "no-payable-option",
      `selectX402Requirement: candidates is empty in pickPreferredRail. ` +
        `This is a logic bug — selection should have rejected empty inputs.`,
    );
  }
  return chosen;
}

/**
 * Normalize a requirement into the typed `X402Requirement` shape.
 *
 * The merchant may send `resource` as an object, as a bare URL string,
 * or omit it entirely. b402 merchants reject an absent resource — "the
 * signed envelope has no resource" is reported as a verification failure
 * — so the resource is normalized to a non-null string here: the
 * requirement's own if present, otherwise the request URL.
 *
 * The normalization is local to this module: the caller sees a
 * `X402Requirement` whose `resource` is the non-null fallback. The
 * signer (`sign.ts`) and the encoder (`encode.ts`) both consume the
 * normalized shape and rely on `resource` being non-null.
 */
export function normalizeRequirement(
  requirement: X402Requirement,
  resourceUrl: string,
): X402Requirement {
  return {
    ...requirement,
    resource:
      requirement.resource && requirement.resource.length > 0
        ? requirement.resource
        : resourceUrl,
    maxAmountRequired: normalizeAmount(requirement.maxAmountRequired),
  };
}

function normalizeAmount(amount: SmallestUnits | string): SmallestUnits {
  // `maxAmountRequired` is typed as `bigint` in our model, but the wire
  // form is JSON — and JSON has no bigint. A merchant sends a decimal
  // string ("1000000"), the client parses it as a string, and we narrow
  // back to bigint here. This is the single normalization point so the
  // rest of the codebase can rely on the typed shape.
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "string") {
    if (!/^-?\d+$/.test(amount)) {
      throw new PaymentFailureError(
        "verification-failed",
        `selectX402Requirement: maxAmountRequired is not a decimal integer string: ${amount}`,
      );
    }
    return BigInt(amount);
  }
  throw new PaymentFailureError(
    "verification-failed",
    `selectX402Requirement: maxAmountRequired must be a bigint or decimal string, received ${typeof amount}`,
  );
}

/**
 * Re-exported so the test file can import the selection helpers without
 * reaching into the package's private path.
 */
export { PaymentFailureError };
export type { X402PaymentRequired };
