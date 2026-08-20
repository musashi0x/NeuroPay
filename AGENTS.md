# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## What this is

neuro-pay is a pnpm + Turborepo monorepo implementing x402 micropayment
streaming: a seller (`apps/api`) that answers HTTP `402 Payment Required`
for metered work, a session/payment client (`packages/altana`), and a
console frontend (`apps/web`) that watches it all over SSE. See
`README.md` for the full product narrative — it is unusually detailed and
should be read before making payment/session/settlement changes.

**The repo is mid-build.** Signature verification is stubbed
(`apps/api/src/runtime.ts` injects a verifier that accepts everything) and
settlement is in-memory (no real transaction is submitted). Do not treat
`pnpm demo` output as evidence that signing or settlement works — check
`README.md`'s "What works today" table before assuming a code path is real.

## Commands

Run from the repo root unless noted. Use `pnpm --filter <pkg-name>` to
scope any script to one workspace package (package names are
`@neuro-pay/api`, `@neuro-pay/web`, `@neuro-pay/altana`, `@neuro-pay/ledger`,
`@neuro-pay/metering`, `@neuro-pay/types`, `@neuro-pay/logger`).

- `pnpm install` — installs deps for the whole workspace. No env files are
  required for install, test, or build.
- `pnpm dev` — Turbo TUI; starts `@neuro-pay/web` (:3000) and
  `@neuro-pay/api` (:4000). Non-interactive shells should force
  `TURBO_UI=false pnpm dev` or `pnpm dev -- --ui stream` to get plain
  streamed logs instead of the TUI.
- `pnpm build` / `pnpm lint` / `pnpm typecheck` / `pnpm test` — Turbo-orchestrated
  across every workspace package (each depends on `^build` for its
  dependencies, so `@neuro-pay/types` etc. build first).
- `pnpm check` — the full local gate: lint, typecheck, test, build, then
  `prettier --check .`. Mirrors CI; run this before considering a change done.
- `pnpm format` — Prettier write across the workspace.
- Single package: `pnpm --filter @neuro-pay/api test`, `pnpm --filter @neuro-pay/api dev`, etc.
- Single test file/case: `cd` into the package and run `pnpm exec vitest run path/to/file.test.ts` or `pnpm exec vitest run -t "test name"`. Watch mode: `pnpm exec vitest --watch`.
- Force a re-run ignoring Turbo's cache: `pnpm exec turbo test --force`.
- `pnpm --filter @neuro-pay/api demo` — drives the payment loop against a
  running API (opens a stream, answers 402s). Requires non-zero
  `PRICE_PER_UNIT`/etc. in `apps/api/.env`.
- `pnpm --filter @neuro-pay/api seed:session` — writes a fake
  `PersistedSession` so the console has something to render without a
  real on-chain grant.
- `pnpm --filter @neuro-pay/altana provision` — the real (chain-touching)
  wallet/session provisioning script; needs `ADMIN_PRIVATE_KEY` and testnet funds.

Env files (`apps/api/.env`, `apps/web/.env.local`, copied from their
`.env.example`) are optional and gitignored. Without chain config,
`tryCreateRuntime` in `apps/api/src/runtime.ts` catches the resulting
`ConfigError` and boots the API with only `/health` — no console/seller
routes — which is fine for frontend-only or logging work.

## Architecture

### Composition-root pattern

Both the seller (`apps/api/src/seller/index.ts`) and the payment runtime
(`apps/api/src/runtime.ts`) follow a strict composition-root style: pure
logic modules (streams, requirements, verify, idempotency, exposure,
settle, prices) are individually testable and know nothing of HTTP or each
other's wiring. A single `createSeller(...)` / `tryCreateRuntime(...)`
function assembles them and returns a narrow interface consumed by the
Hono route layer (`apps/api/src/app.ts`). `Verifier` and `Settler` are
injected, not hardcoded — this is how tests substitute an in-memory
settler and a stub verifier, and it's why "the seller accepts every
envelope" is a composition choice made in `runtime.ts`, not a bug buried
in the seller logic.

### Config loading is fully injectable

Every module that reads configuration takes an `EnvSource` parameter
(`packages/altana/src/config/env.ts` / `config.ts`). `loadAppConfig(env)`
defaults to `process.env` but tests pass their own object — this is why
`pnpm test` needs no `.env` file anywhere. Amounts that look like plain
numbers in env vars are NOT necessarily smallest-units: `SESSION_SPEND_CAP`
is whole tokens and gets multiplied by `10**tokenDecimals` at load time;
`SETTLEMENT_THRESHOLD` and `PRICE_PER_*` are already smallest units. Get
this wrong and a value silently becomes 10^18x too large or small — read
`config.ts`'s comments before touching money-related env vars.

### Request flow through the seller

`POST /v1/streams/:id/next` (`apps/api/src/routes/streams/next.ts`) →
`seller.nextSegment()`: parse `X-PAYMENT` envelope → if missing, evaluate
the metering policy (`@neuro-pay/metering`) and return a 402 with the
current demand → if present, verify against the injected `Verifier` →
check idempotency (nonce replay returns the cached segment, no new
charge) → check the exposure ceiling (bounds seller credit at
`SETTLEMENT_THRESHOLD × MAX_IN_FLIGHT_SETTLEMENTS`) → produce and return
the segment, recording `payment.verified`/`segment.delivered` to the
ledger → enqueue async settlement (not awaited; the response returns
immediately). Exposure is released when settlement resolves.

### Ledger is the source of truth for the console

`packages/ledger` is an append-only event store (`.data/ledger.sqlite` by
default). The console (`apps/api/src/console/service.ts` +
`apps/api/src/console/routes.ts`) reads sessions/streams/payments from the
ledger and session store, and pushes live updates over `GET /v1/events`
(SSE) whenever the seller's `LedgerStore.append` is called — see the
`watchLedger` wrapper in `runtime.ts` that fires `hub.notify()` on every
append. The web console (`apps/web/src/components/console/ConsoleApp.tsx`,
`apps/web/src/lib/api.ts`) does an initial REST fetch then subscribes to
that SSE stream; `lib/wire.ts` revives JSON-transported bigints/etc. back
into typed values.

### Shared wire types

`packages/types` defines every shape that crosses the `apps/api` ↔
`apps/web` boundary (session, stream, ledger, x402, console, config).
Token amounts are always `bigint` in smallest units — never `number`,
never a decimal string — because a per-second price on an 18-decimal
token loses precision immediately otherwise. When these types cross JSON,
a codec tags/restores the bigints (see `lib/wire.ts` on the web side).

### Package dependency direction

`@neuro-pay/types` and `@neuro-pay/metering` have no internal deps.
`@neuro-pay/altana` (session lifecycle + x402 payment client, server-only)
depends on `metering` and `types`. `@neuro-pay/ledger` is standalone.
`apps/api` depends on all four plus `@neuro-pay/logger`. `apps/web` only
depends on `@neuro-pay/types` and `@neuro-pay/carousel` (a landing-page
visual effect package) — it must never import anything server-only; this
is enforced by `apps/web`'s `check:no-server` script and test.

### Buyer side is not wired up

`fetchWithX402` in `@neuro-pay/altana` is the buyer payment client — built
and tested, but nothing in a running process calls it.
`apps/api/scripts/demo-stream.ts` (`pnpm demo`) is a standalone script
that stands in as the buyer for manual/demo purposes only.

## OpenSpec workflow

This repo uses [OpenSpec](openspec/config.yaml) for spec-driven change
management: `openspec/specs/*/spec.md` hold current capability specs
(`web-app`, `api-server`, `workspace`, `shared-tooling`); proposed changes
live under `openspec/changes/<change-id>/` with `proposal.md`,
`design.md`, `tasks.md`, and delta specs, then move to
`openspec/changes/archive/` once shipped. Use the `openspec-propose`,
`openspec-apply-change`, `openspec-explore`, and `openspec-archive-change`
skills for that workflow rather than freehand planning docs.

## Logging

The API uses `pino` via `@neuro-pay/logger`: JSON in production, pretty
single-line in dev (`LOG_FORMAT=json|pretty` to override,
`LOG_LEVEL=debug pnpm --filter @neuro-pay/api dev` to override level).
Every request gets an `x-request-id` (inherited from upstream or a new
v4 UUID), echoed on the response and attached to every log line and
thrown-error response body for correlating reports with logs.
