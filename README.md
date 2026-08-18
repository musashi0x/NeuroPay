# neuro-pay

pnpm + Turborepo workspace for the neuro-pay web app and API.

## Prerequisites

- Node.js 22 or newer (see `.nvmrc`)
- [pnpm](https://pnpm.io) 10 (`corepack enable` then `corepack prepare pnpm@10.34.5 --activate`)

## Setup

```bash
pnpm install
```

Environment files are optional — the workspace installs, tests, builds, and boots without any of them.

| File                  | Copy from               | Loaded by                                                        |
| --------------------- | ----------------------- | ---------------------------------------------------------------- |
| `apps/api/.env`       | `apps/api/.env.example` | `pnpm dev` / `pnpm start` via Node's `--env-file-if-exists=.env` |
| `apps/web/.env.local` | `apps/web/.env.example` | Next.js                                                          |

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

Both are gitignored. Leave the secrets blank until you actually need the payment path — the API boots either way (see [Testing](#testing)).

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

Turbo scripts use the interactive TUI. Switch task logs with the arrow keys; quit with `q` or `Ctrl+C`. Non-interactive terminals fall back to streamed logs (`TURBO_UI=false` or `--ui stream` forces that).

Filter a single package:

```bash
pnpm --filter @neuro-pay/web dev
pnpm --filter @neuro-pay/api dev
```

## Testing

Vitest per package (`environment: "node"`). **Unit tests need no environment, no chain, and no network.** Every module that reads configuration takes an injected `EnvSource` — `loadAppConfig(env)` in `packages/altana/src/config/config.ts` defaults to `process.env` but tests pass their own object — so `pnpm install && pnpm test` is the whole setup.

```bash
pnpm test                              # every package that ships tests
pnpm --filter @neuro-pay/api test      # one package
pnpm exec turbo test --force           # ignore the Turbo cache
```

Watch mode, from inside a package directory:

```bash
pnpm exec vitest --watch
```

Five packages ship tests (`carousel`, `logger`, `types`, `tsconfig`, and `eslint-config` do not):

| Package             | What is covered                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`          | App wiring and CORS, seller 402 envelopes, verification, settlement, idempotency, exposure caps, price sheet, stream blotter, console service |
| `apps/web`          | Amount formatting, and a guard that the client bundle imports nothing server-only                                                             |
| `packages/altana`   | Config loading and each named failure, payment encode/sign/select/request, session codec, refusals, spend accounting                          |
| `packages/ledger`   | Append-only event store, and a guard that no secret reaches a persisted row                                                                   |
| `packages/metering` | Accrual, budget margin, smallest-unit arithmetic, expiry, threshold-or-tick policy, boundary conditions                                       |

Turbo caches test results, so an unchanged package reports `cached` and re-runs nothing. `pnpm check` is the full local gate (lint, typecheck, test, build, format).

### Testing the payment path by hand

The chain config is only needed to exercise payments end to end. Without it, `tryCreateRuntime` catches the `ConfigError`, logs `payment runtime disabled`, and mounts the API without the console and seller routes — `/health` and the web app still work, which is the right state for frontend and logging work.

To mount the payment routes, fill these in `apps/api/.env` (the rest already default to BNB testnet):

| Variable              | Why                                                                     |
| --------------------- | ----------------------------------------------------------------------- |
| `PAY_TO`              | Settlement recipient, bound into every Permit2 witness                  |
| `SETTLER_PRIVATE_KEY` | EOA that submits `permitWitnessTransferFrom`; needs testnet BNB for gas |
| `ADMIN_PRIVATE_KEY`   | Only for wallet creation, `grantSession`, rail provisioning, and revoke |

Use throwaway testnet-only keys. A leaked session key is bounded by the cap and expiry; a leaked admin key is total loss of the wallet. Then follow the [operator checklist](#operator-checklist-chain-97).

## CI

GitHub Actions runs on every push to `main` and every pull request. One job installs once, then checks each app and formatting:

| Step     | What it runs                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Frontend | `turbo run lint typecheck test build --filter=@neuro-pay/web`                                                                 |
| Backend  | `turbo run lint typecheck test build --filter=@neuro-pay/api`                                                                 |
| Packages | `turbo run lint typecheck test build` for `@neuro-pay/metering`, `@neuro-pay/altana`, `@neuro-pay/ledger`, `@neuro-pay/types` |
| Format   | `prettier --check .`                                                                                                          |

Turbo still builds workspace dependencies such as `@neuro-pay/types` via `^build`. Locally, `pnpm check` is the same quality gate (whole workspace + format).

## Layout

```
apps/web             Next.js App Router frontend + stream console at /console
apps/api             Hono TypeScript HTTP API (seller, ledger, console API)
packages/altana      Session lifecycle and x402 payment client (server-only)
packages/metering    Threshold-or-tick policy (no chain, no network)
packages/ledger      Append-only payment event store
packages/logger      Shared pino logger (structured JSON in prod, pretty in dev)
packages/tsconfig    Shared TypeScript configs
packages/eslint-config
packages/types       Shared wire types (price sheet, session, ledger, …)
```

## x402 micropayment streaming (BNB Testnet, chain 97)

The agent pays for metered work with an Altana session key. A human approves a policy once (spend cap, expiry, allowed contracts). Every subsequent 402 is signed server-side. The browser never receives a private key.

### Operator checklist (chain 97)

1. Copy `apps/api/.env.example` to `apps/api/.env`. Leave secrets blank until you generate them. `pnpm dev` and `pnpm start` load that file automatically; nothing reads it during tests.
2. Set `RPC_URL`, `TOKEN_ADDRESS`, `TOKEN_DECIMALS`, `PAY_TO`, `SETTLER_PRIVATE_KEY`, and `ADMIN_PRIVATE_KEY`.
3. `SESSION_SPEND_CAP` is **whole tokens**, not smallest units. `10` on an 18-decimal token becomes `10e18`. Writing `10000000000000000000` here would become `10e36`.
4. `TOKEN_DECIMALS` is asserted against the token contract at client startup. USDT/USDC are 18 decimals on BNB and 6 on Ethereum. The wrong value makes every payment revert against a cap that looks generous.
5. Fund the settler EOA with testnet BNB (gas). A drained settler is reported as its own alarm; verification still passes.
6. Provision the wallet and session:

   ```bash
   pnpm --filter @neuro-pay/altana provision
   ```

   The script prints the smart-account address to fund and every transaction hash. Fund that address from the [BNB testnet faucet](https://www.bnbchain.org/en/testnet-faucet) **before** the grant if the wallet is new.

7. `grantSession` writes to Keystore and costs a fee. The wallet's **first admin action is charged twice** because `initialRegisterKey` rides in the same userOp. Record both the funding hash and the grant hash; the double charge is expected.
8. Session persistence is byte-exact. The store re-encodes on load and **hard-fails** on mismatch. Do not hand-edit `.data/session.json`. A sloppy JSON round-trip (bigint → number, reordered keys) grants cleanly and then fails every payment.
9. Start the API and the console:

   ```bash
   pnpm dev
   ```

   Seller + console API: [http://localhost:4000](http://localhost:4000) · blotter: [http://localhost:3000/console](http://localhost:3000/console)

### What is bounded, and what is not

| Failure                     | Bound                                                                               | What is not guaranteed                                              |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Buyer walks away mid-stream | Seller loss ≤ `SETTLEMENT_THRESHOLD × MAX_IN_FLIGHT_SETTLEMENTS` of unpaid delivery | Already-delivered segments whose settlement has not confirmed       |
| Session key leaks           | Buyer loss ≤ on-chain `spend.limit` per period, until `expiry` or revoke            | Zero loss. The cap is the whole point and it is not zero.           |
| Admin key leaks             | Unbounded — total loss of the wallet                                                | Anything. The admin key is not loaded by the running agent process. |
| Kill switch, local stage    | Signing stops in milliseconds. No further envelopes.                                | The session is still valid on-chain until the second stage lands.   |
| Kill switch, on-chain stage | Session is provably dead (`isValidKey` reads false).                                | If this stage returns `FAILED`, retry. Local revoke still holds.    |

Do not collapse the two revoke stages into one status. The console reports them separately.

## Logging & observability

The API uses [`pino`](https://getpino.io) via the shared `@neuro-pay/logger` package.

- **Format**: JSON in production (`NODE_ENV=production`), pretty-printed in development. Pretty output is single-line — the structured fields stay on the same line as the message, so a request is one grep hit rather than a paragraph. Force either with `LOG_FORMAT=json|pretty`.
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
