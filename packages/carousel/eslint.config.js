import globals from "globals";
import config from "@neuro-pay/eslint-config";

export default [
  ...config,
  {
    // The engine is browser code, not Node — the shared config only sets Node
    // globals. It is also vendored (see README.md), so the empty catches
    // around setPointerCapture/releasePointerCapture are deliberate: those
    // calls legitimately throw when the pointer is already gone.
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
