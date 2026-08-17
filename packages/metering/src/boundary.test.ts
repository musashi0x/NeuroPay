import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";

type Manifest = {
  dependencies?: Record<string, string>;
};

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const runtimeDependencies = Object.keys(manifest.dependencies ?? {});

/**
 * Anything that talks to a chain or a network. Adding one of these makes the
 * policy untestable without a testnet, which is the failure this guard exists
 * to prevent.
 */
const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  "@altananetwork/sdk",
  "viem",
  "ox",
  "porto",
  "ethers",
  "web3",
  "axios",
  "node-fetch",
  "undici",
  "ws",
];

describe("metering package boundary", () => {
  it("declares no chain or network runtime dependency", () => {
    const forbidden = runtimeDependencies.filter((name) =>
      FORBIDDEN_RUNTIME_DEPENDENCIES.includes(name),
    );

    expect(forbidden).toEqual([]);
  });

  it("depends on @neuro-pay/types and nothing else at runtime", () => {
    expect(runtimeDependencies).toEqual(["@neuro-pay/types"]);
  });
});

describe("systemClock", () => {
  it("reports epoch milliseconds", () => {
    const before = Date.now();
    const observed = systemClock.now();
    const after = Date.now();

    expect(Number.isInteger(observed)).toBe(true);
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});
