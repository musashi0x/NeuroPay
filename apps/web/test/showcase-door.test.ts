/**
 * Landing door: the showcase link is wired into the carousel chrome
 * and the configurable URL is honored.
 *
 * The test reads the carousel source and asserts:
 *  1. The "Try as agent" anchor is present.
 *  2. The `NEXT_PUBLIC_SHOWCASE_URL` env var drives the URL.
 *  3. The default URL is http://localhost:3001.
 *  4. The visible chrome text does not name USDC or USDT.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");
const CAROUSEL = readFileSync(
  join(WEB_ROOT, "src", "components", "CarouselSection.tsx"),
  "utf8",
);

describe("apps/web — showcase landing door", () => {
  it("renders a 'Try as agent' anchor in the chrome", () => {
    expect(CAROUSEL).toContain("Try as agent");
  });

  it("reads the URL from NEXT_PUBLIC_SHOWCASE_URL", () => {
    expect(CAROUSEL).toContain("NEXT_PUBLIC_SHOWCASE_URL");
  });

  it("defaults the URL to http://localhost:3001", () => {
    expect(CAROUSEL).toMatch(
      /NEXT_PUBLIC_SHOWCASE_URL[\s\S]+http:\/\/localhost:3001/,
    );
  });

  it("does not collapse the showcase behind the console route", () => {
    // The console anchor stays at /console; the showcase is a separate
    // anchor. Catch a regression where someone replaces the showcase
    // door with a /console redirect.
    expect(CAROUSEL).not.toMatch(/href="\/console"[^>]*>\s*Try as agent/);
  });

  it("does not name USDC or USDT in the chrome", () => {
    expect(CAROUSEL).not.toMatch(/\bUSDC\b/);
    expect(CAROUSEL).not.toMatch(/\bUSDT\b/);
  });
});
