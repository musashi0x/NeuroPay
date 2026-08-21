import { describe, expect, it } from "vitest";
import {
  consoleChainId,
  explorerOrigin,
  explorerUrl,
} from "../src/lib/explorer";

describe("explorerUrl", () => {
  it("builds a BNB testnet transaction URL", () => {
    expect(explorerUrl(97, "tx", "0xabc")).toBe(
      "https://testnet.bscscan.com/tx/0xabc",
    );
  });

  it("builds a BNB mainnet address URL", () => {
    expect(explorerUrl(56, "address", "0xdef")).toBe(
      "https://bscscan.com/address/0xdef",
    );
  });

  it("returns null for an unmapped chain rather than guessing a host", () => {
    expect(explorerUrl(1, "tx", "0xabc")).toBeNull();
  });

  it("returns null for a blank value", () => {
    expect(explorerUrl(97, "tx", "  ")).toBeNull();
  });
});

describe("explorerOrigin", () => {
  it("names testnet BscScan for chain 97", () => {
    expect(explorerOrigin(97)).toBe("https://testnet.bscscan.com");
  });
});

describe("consoleChainId", () => {
  it("prefers a payment chain id, then a stream, then testnet", () => {
    expect(consoleChainId({ payments: [{ chainId: 56 }] })).toBe(56);
    expect(
      consoleChainId({
        streams: [{ priceSheet: { chainId: 56 } }],
      }),
    ).toBe(56);
    expect(consoleChainId({})).toBe(97);
  });
});
