/**
 * Assemble a buyer-side `PaymentClientContext` from a persisted session
 * and a live signer. This is the composition the agent process (and the
 * `demo:real` script) uses before calling `fetchWithX402`.
 */

import { initializeBudget, systemClock, type Clock } from "@neuro-pay/metering";
import type { Address } from "@neuro-pay/types";
import type { Signer } from "@altananetwork/sdk";
import type { PersistedSession } from "../session/persisted.js";
import { sessionFromPersisted } from "../session/hydrate.js";
import { buildPaymentContext, type PaymentClientContext } from "./context.js";

const PERIOD_SECONDS = {
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
} as const;

export type CreateBuyerPaymentContextInput = {
  persisted: PersistedSession;
  signer: Signer;
  chainId: number;
  tokenDecimals: number;
  budgetMargin: number;
  clock?: Clock;
};

/**
 * Hydrate the payment context a `fetchWithX402` call needs.
 *
 * Throws if the persisted session has no spend permission (nothing to
 * budget against) or no token on that spend entry.
 */
export function createBuyerPaymentContext(
  input: CreateBuyerPaymentContextInput,
): PaymentClientContext {
  const spend = input.persisted.permissions.spend[0];
  if (spend === undefined) {
    throw new Error(
      "createBuyerPaymentContext: persisted session has no spend permission",
    );
  }
  const token = spend.token;
  if (token === undefined) {
    throw new Error(
      "createBuyerPaymentContext: spend permission is missing a token",
    );
  }
  const clock = input.clock ?? systemClock;
  const budget = initializeBudget(
    {
      token,
      tokenDecimals: input.tokenDecimals,
      spendCap: spend.limit,
      spendPeriodSeconds: PERIOD_SECONDS[spend.period],
      budgetMargin: input.budgetMargin,
    },
    clock,
  );
  return buildPaymentContext({
    session: sessionFromPersisted(input.persisted, input.signer),
    walletAddress: input.persisted.walletAddress,
    chainId: input.chainId,
    permittedTokens: [token],
    budget,
    railProvisioned: input.persisted.railProvisioned,
    expiresAt: input.persisted.expiry,
  });
}

export type { Address };
