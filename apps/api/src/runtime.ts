/**
 * Optional payment runtime. The API still boots `/health` when chain
 * config is missing; the console and seller attach only when
 * `loadAppConfig` succeeds.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, SessionStore, loadAppConfig } from "@neuro-pay/altana";
import { openLedgerStore, type LedgerStore } from "@neuro-pay/ledger";
import { createSeller } from "./seller/index.js";
import { createInMemorySettler } from "./seller/settle.js";
import { IS_VALID_SIGNATURE_MAGIC } from "./seller/verify.js";
import {
  createConsoleService,
  type ConsoleService,
} from "./console/service.js";
import type { Seller } from "./seller/index.js";
import { logger } from "./logger.js";

export type PaymentRuntime = {
  console: ConsoleService;
  seller: Seller;
  close: () => void;
};

export function tryCreateRuntime(
  env: NodeJS.ProcessEnv = process.env,
): PaymentRuntime | null {
  let config;
  try {
    config = loadAppConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.warn(
        { err: { name: err.name, message: err.message } },
        "payment runtime disabled — console and seller routes are not mounted",
      );
      return null;
    }
    throw err;
  }

  const priceSheet = readInitialPriceSheet(env);

  const sessionPath = env.SESSION_STORE_PATH ?? ".data/session.json";
  const ledgerPath = env.LEDGER_PATH ?? ".data/ledger.sqlite";
  mkdirSync(dirname(sessionPath), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });

  const sessions = new SessionStore({ fileStorePath: sessionPath });
  const ledger = openLedgerStore({ storagePath: ledgerPath });
  const hub: { notify: () => void } = { notify() {} };

  const seller = createSeller({
    initialPriceSheet: priceSheet,
    config: {
      metering: config.metering,
      payTo: config.chain.payTo,
      chainId: config.chain.chainId,
      token: config.chain.token,
      tokenDecimals: config.chain.tokenDecimals,
    },
    store: watchLedger(ledger, () => hub.notify()),
    verifier: async () => IS_VALID_SIGNATURE_MAGIC,
    settler: createInMemorySettler({ defaultBehavior: "confirm" }),
  });

  const consoleService = createConsoleService({
    config,
    sessions,
    ledger,
    seller,
  });
  hub.notify = () => consoleService.notify();

  return {
    console: consoleService,
    seller,
    close: () => ledger.close(),
  };
}

/**
 * Read the seller's opening price sheet from the environment.
 *
 * `createSeller` defaults every price to zero, which delivers every
 * segment free and means the policy never demands payment — the whole
 * 402 path is unreachable. The zero default is kept here so an operator
 * who sets nothing sees no surprise charges, but the values are read
 * from the environment so a running seller can actually price its work.
 *
 * Amounts are in smallest token units (digits only), same as
 * `SETTLEMENT_THRESHOLD`, because a decimal here is the same ~10^18
 * hazard that `SESSION_SPEND_CAP` documents at length.
 */
function readInitialPriceSheet(env: NodeJS.ProcessEnv): {
  perCall: bigint;
  perSecond: bigint;
  perUnit: bigint;
  unitName: string;
} {
  return {
    perCall: readSmallestUnits(env, "PRICE_PER_CALL"),
    perSecond: readSmallestUnits(env, "PRICE_PER_SECOND"),
    perUnit: readSmallestUnits(env, "PRICE_PER_UNIT"),
    unitName: env.PRICE_UNIT_NAME ?? "unit",
  };
}

/** Parse one smallest-units env var. Absent is zero; malformed is fatal. */
function readSmallestUnits(env: NodeJS.ProcessEnv, name: string): bigint {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return 0n;
  if (!/^\d+$/.test(raw.trim())) {
    throw new TypeError(
      `${name} must be digits only, in smallest token units (got ${JSON.stringify(raw)})`,
    );
  }
  return BigInt(raw.trim());
}

function watchLedger(store: LedgerStore, onAppend: () => void): LedgerStore {
  return {
    append: async (input) => {
      const entry = await store.append(input);
      onAppend();
      return entry;
    },
    entries: () => store.entries(),
    size: () => store.size(),
    close: () => store.close(),
  };
}
