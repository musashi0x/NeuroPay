# neuro-pay

pnpm + Turborepo workspace for neuro-pay: the x402 metered-payment loop and the
web front end that fronts it.

Agents buy the services they need on BNB Chain. Each catalog listing carries a
price per call; the gateway issues the `HTTP 402`, checks the request against the
owner's grant, and settles in USDC before the call runs.

## Prerequisites

- Node.js 22 or newer (see `.nvmrc`)
- [pnpm](https://pnpm.io) 10 (`corepack enable` then `corepack prepare pnpm@10.34.5 --activate`)

## Setup

```bash
pnpm install
```

Copy each app's `.env.example` to `.env` if you need to override defaults.

## Scripts

Run these from the repository root:

| Command          | What it does                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`       | Open the Turborepo TUI and start `@neuro-pay/web` on [http://localhost:3000](http://localhost:3000) and `@neuro-pay/api` on [http://localhost:4000](http://localhost:4000) |
| `pnpm build`     | Production build of every package                                                                                                                                          |
| `pnpm lint`      | ESLint across the workspace                                                                                                                                                |
| `pnpm typecheck` | TypeScript `--noEmit` across the workspace                                                                                                                                 |
| `pnpm test`      | Vitest across packages that ship tests                                                                                                                                     |
| `pnpm check`     | Lint, typecheck, test, build, and format check (local CI gate)                                                                                                             |
| `pnpm format`    | Prettier write across the workspace                                                                                                                                        |
| `pnpm panels`    | Regenerate the landing-page card artwork (see [Landing page](#landing-page))                                                                                               |

Turbo scripts use the interactive TUI. Switch task logs with the arrow keys; quit with `q` or `Ctrl+C`. Non-interactive terminals fall back to streamed logs (`TURBO_UI=false` or `--ui stream` forces that).

Filter a single package:

```bash
pnpm --filter @neuro-pay/web dev
pnpm --filter @neuro-pay/api dev
```

## CI

GitHub Actions runs on every push to `main` and every pull request. One job installs once, then checks each app and formatting:

| Step     | What it runs                                                  |
| -------- | ------------------------------------------------------------- |
| Frontend | `turbo run lint typecheck test build --filter=@neuro-pay/web` |
| Backend  | `turbo run lint typecheck test build --filter=@neuro-pay/api` |
| Format   | `prettier --check .`                                          |

Turbo still builds workspace dependencies such as `@neuro-pay/types` via `^build`. Locally, `pnpm check` is the same quality gate (whole workspace + format).

## Layout

```
apps/web             Next.js App Router frontend. `/` is the landing carousel,
                     `/health` the API integration check.
apps/api             Hono TypeScript HTTP API

packages/altana      The Altana SDK boundary: chain config, client, wallet and
                     session lifecycle, rail provisioning, x402 payment client.
                     The only package allowed to import `@altananetwork/sdk` or
                     `viem`, and server-side only — key material lives here and
                     must never reach a browser bundle.
packages/metering    The settlement policy: price sheet, threshold-or-tick
                     meter, budget mirror. Deliberately chain-free —
                     `src/boundary.test.ts` fails the build if a wallet, RPC or
                     HTTP dependency is ever added — so rounding, window rolls
                     and refusals are testable against a fake clock.
packages/ledger      Append-only payment ledger. Owns the durable trail of
                     every payment-relevant event, not chain reads or
                     settlement.
packages/carousel    The WebGL landing carousel engine (three.js + GSAP),
                     framework-free. Vendored, MIT — see its README.
packages/logger      Shared pino logger (structured JSON in prod, pretty in dev)
packages/types       Shared public types (HealthResponse, …)
packages/tsconfig    Shared TypeScript configs
packages/eslint-config
```

## Landing page

`/` is a WebGL carousel that tells the payment flow as ten cards: catalog,
discovery, unpaid request, `HTTP 402`, grant check, USDC settlement, execution,
receipt, integration. Scroll or drag the row; click a card to focus it.

- **Desktop only.** Below 1025px the page shows a holding screen and never boots
  WebGL.
- **It needs a visible window.** The carousel is driven by
  `requestAnimationFrame`, so it does not advance in a backgrounded or hidden
  tab — a screenshot of a hidden page shows a black canvas even though nothing
  is wrong.
- **Press `g`** for a live tuning panel, then copy the numbers you land on back
  into `apps/web/src/carousel.config.ts`.

Content and theme live in `apps/web/src/carousel.config.ts`, written as
overrides on `@neuro-pay/carousel`'s upstream defaults so the file reads as a
diff. The card artwork is generated rather than photographic — no third-party
imagery in the repo, and no image toolchain to install. Card copy lives in
`apps/web/scripts/gen-panels.mjs`; after editing it:

```bash
pnpm panels
```

That draws each card as SVG and rasterises it at 2× with headless Chrome. Set
`CHROME_BIN` if Chrome isn't at the default macOS path. Cards render ~600px tall
(`CONFIG.PANEL_H`) from a 1000px-tall source, so the generator's type scale is
built around that ~0.6× reduction — if you change `PANEL_H`, re-check the small
text on the cards, not just the layout.

## Logging & observability

The API uses [`pino`](https://getpino.io) via the shared `@neuro-pay/logger` package.

- **Format**: JSON in production (`NODE_ENV=production`), pretty-printed in development.
- **Level**: `LOG_LEVEL` (default: `info` in prod, `debug` in dev).
- **Per-request id**: every request gets an `x-request-id` header (inherited from the upstream if present, otherwise a v4 UUID). The id is echoed back on the response and attached to every log line for that request.
- **Request log**: one structured line per request with `method`, `path`, `status`, `durationMs`, and `requestId`.
- **Errors**: every thrown error is logged with the stack and returns a structured JSON error body that includes the `requestId` so support can correlate user reports with server logs.
- **Redaction**: `authorization`, `cookie`, `set-cookie`, `password`, `token`, and `secret` fields are redacted from log output.

To watch the API logs in dev:

```bash
pnpm --filter @neuro-pay/api dev
```

To override the log level:

```bash
LOG_LEVEL=debug pnpm --filter @neuro-pay/api dev
```
