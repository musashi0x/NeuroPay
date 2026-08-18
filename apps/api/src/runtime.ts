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

  const sessionPath = env.SESSION_STORE_PATH ?? ".data/session.json";
  const ledgerPath = env.LEDGER_PATH ?? ".data/ledger.sqlite";
  mkdirSync(dirname(sessionPath), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });

  const sessions = new SessionStore({ fileStorePath: sessionPath });
  const ledger = openLedgerStore({ storagePath: ledgerPath });
  const hub: { notify: () => void } = { notify() {} };

  const seller = createSeller({
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
