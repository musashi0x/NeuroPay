/**
 * Tests for requirement selection.
 *
 * The selection rules are the spec's "Requirement selection" scenarios:
 *  1. Configured chain wins over foreign chains.
 *  2. permit2 wins over eip3009 on the same chain.
 *  3. Unpermitted tokens are refused explicitly, not silently.
 *  4. Empty accepts is its own failure category.
 */
import { describe, expect, it } from "vitest";
import {
  PERMIT2_REQUIREMENT,
  EIP3009_REQUIREMENT,
  WRONG_CHAIN_REQUIREMENT,
  UNPERMITTED_TOKEN_REQUIREMENT,
  BNB_CHAIN_ID,
  PERMITTED_TOKEN,
} from "./__fixtures__/index.js";
import { selectX402Requirement } from "./select.js";
import { PaymentFailureError } from "./errors.js";

const defaultOptions = {
  chainId: BNB_CHAIN_ID,
  permittedTokens: new Set([PERMITTED_TOKEN]),
  resourceUrl: "https://example.com/api/data",
};

describe("selectX402Requirement — chain preference", () => {
  it("chooses the configured chain option when only one chain is offered", () => {
    const chosen = selectX402Requirement([PERMIT2_REQUIREMENT], defaultOptions);
    expect(chosen).toStrictEqual(PERMIT2_REQUIREMENT);
  });

  it("refuses with wrong-chain-only when every option is off the configured chain", () => {
    expect(() =>
      selectX402Requirement([WRONG_CHAIN_REQUIREMENT], defaultOptions),
    ).toThrowError(PaymentFailureError);

    try {
      selectX402Requirement([WRONG_CHAIN_REQUIREMENT], defaultOptions);
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe(
        "wrong-chain-only",
      );
    }
  });

  it("prefers the configured chain even when it appears after an off-chain option", () => {
    const chosen = selectX402Requirement(
      [WRONG_CHAIN_REQUIREMENT, PERMIT2_REQUIREMENT],
      defaultOptions,
    );
    expect(chosen).toStrictEqual(PERMIT2_REQUIREMENT);
  });
});

describe("selectX402Requirement — rail preference", () => {
  it("prefers permit2 over eip3009 on the same chain", () => {
    const chosen = selectX402Requirement(
      [EIP3009_REQUIREMENT, PERMIT2_REQUIREMENT],
      defaultOptions,
    );
    expect(chosen.rail).toBe("permit2");
    expect(chosen).toStrictEqual(PERMIT2_REQUIREMENT);
  });

  it("falls back to eip3009 when only that rail is offered", () => {
    const chosen = selectX402Requirement([EIP3009_REQUIREMENT], defaultOptions);
    expect(chosen).toStrictEqual(EIP3009_REQUIREMENT);
  });
});

describe("selectX402Requirement — token allowlist", () => {
  it("refuses with unpermitted-token when every option is an unpermitted token", () => {
    expect(() =>
      selectX402Requirement([UNPERMITTED_TOKEN_REQUIREMENT], defaultOptions),
    ).toThrowError(PaymentFailureError);

    try {
      selectX402Requirement([UNPERMITTED_TOKEN_REQUIREMENT], defaultOptions);
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe(
        "unpermitted-token",
      );
    }
  });

  it("picks the permitted option even when an unpermitted option is listed first", () => {
    const chosen = selectX402Requirement(
      [UNPERMITTED_TOKEN_REQUIREMENT, PERMIT2_REQUIREMENT],
      defaultOptions,
    );
    expect(chosen).toStrictEqual(PERMIT2_REQUIREMENT);
  });

  it("does not silently fall back to an unpermitted token when permitted is offered", () => {
    // The mixed case: one option is on the configured chain with a
    // permitted token, another is on the configured chain with an
    // unpermitted token. Selection must pick the permitted one.
    const chosen = selectX402Requirement(
      [UNPERMITTED_TOKEN_REQUIREMENT, PERMIT2_REQUIREMENT],
      defaultOptions,
    );
    expect(chosen.asset).toBe(PERMITTED_TOKEN);
  });
});

describe("selectX402Requirement — empty accepts", () => {
  it("refuses with no-payable-option when accepts is empty", () => {
    expect(() => selectX402Requirement([], defaultOptions)).toThrowError(
      PaymentFailureError,
    );

    try {
      selectX402Requirement([], defaultOptions);
    } catch (err) {
      expect((err as PaymentFailureError).classification).toBe(
        "no-payable-option",
      );
    }
  });
});

describe("selectX402Requirement — resource normalization", () => {
  it("uses the requirement's resource when present and non-empty", () => {
    const req = {
      ...PERMIT2_REQUIREMENT,
      resource: "https://merchant/specific/path",
    };
    const chosen = selectX402Requirement([req], defaultOptions);
    expect(chosen.resource).toBe("https://merchant/specific/path");
  });

  it("falls back to the request URL when resource is empty", () => {
    const req = { ...PERMIT2_REQUIREMENT, resource: "" };
    const chosen = selectX402Requirement([req], defaultOptions);
    expect(chosen.resource).toBe(defaultOptions.resourceUrl);
  });
});
