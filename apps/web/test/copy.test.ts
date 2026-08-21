import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STEPS } from "../src/carousel.config.ts";

describe("product copy does not hardcode a stablecoin", () => {
  it("carousel steps do not name USDC or USDT", () => {
    const blob = JSON.stringify(STEPS);
    expect(blob).not.toMatch(/USDC|USDT/);
  });

  it("landing chrome and metadata do not name USDC or USDT", () => {
    const chrome = readFileSync(
      new URL("../src/components/CarouselSection.tsx", import.meta.url),
      "utf8",
    );
    const layout = readFileSync(
      new URL("../src/app/layout.tsx", import.meta.url),
      "utf8",
    );
    expect(chrome).not.toMatch(/\bUSDC\b|\bUSDT\b/);
    expect(layout).not.toMatch(/\bUSDC\b|\bUSDT\b/);
  });
});
