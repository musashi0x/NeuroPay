import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Chain-backed suites live in `vitest.chain.config.ts`: they boot a
    // forked EVM and need network, which the fast loop must not.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.chain.test.ts"],
  },
});
