import { describe, expect, it } from "vitest";
import type { Address, ChainConfig, Hex } from "@neuro-pay/types";
import {
  assertTokenIdentity,
  DecimalsMismatchError,
  TokenIdentityError,
  type TokenIdentityClient,
} from "./client.js";

const TOKEN = "0xba12ccc0e59f3d71114d147b11bc4581b723559f" as Address;

const chain: Pick<ChainConfig, "token" | "tokenDecimals" | "tokenSymbol"> = {
  token: TOKEN,
  tokenDecimals: 18,
  tokenSymbol: "npUSD",
};

function client(
  overrides: Partial<TokenIdentityClient> = {},
): TokenIdentityClient {
  return {
    getCode: async () => "0x60806040" as Hex,
    readContract: async ({ functionName }) => {
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return "npUSD";
      throw new Error(`unexpected ${functionName}`);
    },
    ...overrides,
  };
}

describe("assertTokenIdentity", () => {
  it("accepts a contract whose code, symbol, and decimals all match", async () => {
    await expect(assertTokenIdentity(client(), chain)).resolves.toBeUndefined();
  });

  it("refuses an address with no code", async () => {
    try {
      await assertTokenIdentity(client({ getCode: async () => "0x" }), chain);
      expect.unreachable("empty code should be fatal");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenIdentityError);
      expect((error as TokenIdentityError).check).toBe("code");
      expect((error as TokenIdentityError).token).toBe(TOKEN);
    }
  });

  it("refuses a decimals mismatch as DecimalsMismatchError", async () => {
    try {
      await assertTokenIdentity(
        client({
          readContract: async ({ functionName }) =>
            functionName === "decimals" ? 6 : "npUSD",
        }),
        chain,
      );
      expect.unreachable("decimals mismatch should be fatal");
    } catch (error) {
      expect(error).toBeInstanceOf(DecimalsMismatchError);
      expect(error).toBeInstanceOf(TokenIdentityError);
      expect((error as TokenIdentityError).check).toBe("decimals");
      expect((error as TokenIdentityError).configured).toBe(18);
      expect((error as TokenIdentityError).onChain).toBe(6);
    }
  });

  it("refuses a symbol mismatch", async () => {
    try {
      await assertTokenIdentity(
        client({
          readContract: async ({ functionName }) =>
            functionName === "decimals" ? 18 : "USDT",
        }),
        chain,
      );
      expect.unreachable("symbol mismatch should be fatal");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenIdentityError);
      expect((error as TokenIdentityError).check).toBe("symbol");
      expect((error as TokenIdentityError).configured).toBe("npUSD");
      expect((error as TokenIdentityError).onChain).toBe("USDT");
    }
  });
});
