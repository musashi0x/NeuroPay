import type { AppConfig } from "@neuro-pay/types";
import {
  readAddress,
  readFraction,
  readInteger,
  readOptionalPrivateKey,
  readPrivateKey,
  readSmallestUnits,
  readUrl,
  readWholeTokens,
  type EnvSource,
} from "./env.js";

export const DEFAULT_CHAIN_ID = 97;
export const DEFAULT_SESSION_LIFETIME_SECONDS = 86_400;
export const DEFAULT_SESSION_SPEND_PERIOD_SECONDS = 86_400;
export const DEFAULT_BUDGET_MARGIN = 0.2;
export const DEFAULT_TICK_INTERVAL_SECONDS = 60;
export const DEFAULT_MAX_IN_FLIGHT_SETTLEMENTS = 3;

export function loadAppConfig(env: EnvSource = process.env): AppConfig {
  return {
    chain: {
      chainId: readInteger(env, "CHAIN_ID", {
        purpose: "EVM chain the session and settlements live on",
        fallback: DEFAULT_CHAIN_ID,
        min: 1,
      }),
      rpcUrl: readUrl(
        env,
        "RPC_URL",
        "JSON-RPC endpoint for contract reads and settlement submission",
      ),
      token: readAddress(
        env,
        "TOKEN_ADDRESS",
        "ERC-20 that payments are denominated in",
      ),
      tokenDecimals: readInteger(env, "TOKEN_DECIMALS", {
        purpose:
          "decimals of TOKEN_ADDRESS, asserted against the contract at startup",
        min: 0,
        max: 36,
      }),
      payTo: readAddress(
        env,
        "PAY_TO",
        "recipient bound into every Permit2 witness",
      ),
    },
    secrets: {
      settlerPrivateKey: readPrivateKey(
        env,
        "SETTLER_PRIVATE_KEY",
        "EOA that submits permitWitnessTransferFrom and pays its gas",
      ),
      adminPrivateKey: readOptionalPrivateKey(env, "ADMIN_PRIVATE_KEY"),
    },
    session: (() => {
      const lifetimeSeconds = readInteger(env, "SESSION_LIFETIME_SECONDS", {
        purpose: "session key lifetime, used to derive the absolute expiry",
        fallback: DEFAULT_SESSION_LIFETIME_SECONDS,
        min: 1,
      });
      const spendPeriodSeconds = readInteger(
        env,
        "SESSION_SPEND_PERIOD_SECONDS",
        {
          purpose: "period the on-chain spend cap resets over",
          fallback: DEFAULT_SESSION_SPEND_PERIOD_SECONDS,
          min: 1,
        },
      );
      const tokenDecimals = readInteger(env, "TOKEN_DECIMALS", {
        purpose:
          "decimals of TOKEN_ADDRESS, asserted against the contract at startup",
        min: 0,
        max: 36,
      });
      const spendCapWhole = readWholeTokens(env, "SESSION_SPEND_CAP", {
        purpose:
          'per-period spend cap in whole tokens (e.g. "50" or "0.5"); converted to smallest units at config time',
        min: 0n,
      });
      const spendCap = spendCapWhole * 10n ** BigInt(tokenDecimals);
      return {
        lifetimeSeconds,
        spendCap,
        spendPeriodSeconds,
      };
    })(),
    metering: {
      budgetMargin: readFraction(env, "BUDGET_MARGIN", {
        purpose: "fraction of the on-chain cap held back as local headroom",
        fallback: DEFAULT_BUDGET_MARGIN,
      }),
      settlementThreshold: readSmallestUnits(env, "SETTLEMENT_THRESHOLD", {
        purpose:
          "accrued amount that triggers a payment demand, in smallest token units",
      }),
      tickIntervalSeconds: readInteger(env, "TICK_INTERVAL_SECONDS", {
        purpose: "seconds since the last payment that trigger a demand regardless of accrual",
        fallback: DEFAULT_TICK_INTERVAL_SECONDS,
        min: 1,
      }),
      maxInFlightSettlements: readInteger(env, "MAX_IN_FLIGHT_SETTLEMENTS", {
        purpose: "concurrent settlements the seller will carry before stopping delivery",
        fallback: DEFAULT_MAX_IN_FLIGHT_SETTLEMENTS,
        min: 1,
      }),
    },
  };
}
