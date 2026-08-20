# neuro-pay

**Agents buy the services they need, and pay per call.**

A catalog of paid APIs and the gateway that settles them on BNB Chain. An
endpoint owner lists a service and sets a price. An agent calls it with no
account, no key, and no card — the gateway answers `HTTP 402 Payment
Required` with a price, a chain, and an address, checks the demand against
the grant its owner approved once, and settles on chain before the call
runs. One status code is the whole handshake.

pnpm + Turborepo workspace: a Next.js frontend (`apps/web`), a Hono API
(`apps/api`), and the payment, metering, and ledger packages they share.

## The use case

An autonomous agent needs paid data mid-task — a price feed, an inference
endpoint, a search index. The usual answers all break down: an API key has
to be issued and rotated by a human, a card can't be handed to a process
that runs unattended, and an invoice arrives long after the agent has
spent whatever it wanted.

This is the alternative:

| Step                  | What happens                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| **Grant, once**       | A human approves a policy: spend cap per period, expiry, an explicit allowlist of calls                 |
| **Call, unpaid**      | The agent requests the endpoint with nothing attached                                                   |
| **402**               | The gateway answers with the amount, token, chain, and recipient for this call                          |
| **Authorize**         | The demand is checked against the grant. Over the cap, past expiry, or off the allowlist — it refuses   |
| **Sign, server-side** | The session key signs a Permit2 witness bound to the recipient. The browser never receives a key        |
| **Settle**            | Payment moves on chain, then delivery proceeds                                                          |
| **Receipt**           | Every stage lands in an append-only ledger the console reads: verified, delivered, submitted, confirmed |

What that buys you: an agent that can spend money without holding a
credential that can spend _unlimited_ money. The cap is enforced on chain,
the expiry is enforced on chain, and the kill switch stops signing
locally in milliseconds while the on-chain revoke confirms. See
[what is bounded, and what is not](#what-is-bounded-and-what-is-not) for
the honest limits.

For metered work — a stream rather than a single call — the seller
accrues cost per segment and demands payment when accrual crosses
`SETTLEMENT_THRESHOLD` or the tick interval elapses, whichever comes
first. That keeps the seller's credit exposure bounded to
`SETTLEMENT_THRESHOLD × MAX_IN_FLIGHT_SETTLEMENTS` if the buyer walks
away mid-stream.

## Using the app

The fast path — no chain, no keys, no funds. Everything below is local.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

`.env.example` already targets BNB testnet and ships dev-scale prices. Two
values are still blank because they are secrets: `PAY_TO` (any address) and
`SETTLER_PRIVATE_KEY` (any well-formed key). For the local walkthrough they
are only format-checked — nothing signs, nothing is submitted — so
throwaway values are enough. Generate a pair with:

```bash
pnpm --filter @neuro-pay/altana exec node --input-type=module -e \
  "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; \
   const k=generatePrivateKey(); console.log(k, privateKeyToAccount(k).address)"
```

Then:

```bash
pnpm --filter @neuro-pay/api seed:session   # a session for the console to show
pnpm dev                                    # web :3000, api :4000
```

Open [http://localhost:3000](http://localhost:3000) for the landing page and
click **Console** in the top-right corner, or go straight to
[http://localhost:3000/console](http://localhost:3000/console).

The console has five panels:

| Panel               | What it tells you                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **Session policy**  | Wallet, spend cap, expiry, allowed calls, whether the rail is provisioned                |
| **Budget**          | Spent this window against both limits — the local budget and the on-chain cap            |
| **Streams**         | Every open stream: pinned prices, accrued unpaid, delivered units, settlements in flight |
| **Payment history** | The append-only ledger: verified, delivered, submitted, confirmed, rejected              |
| **Kill switch**     | Type `REVOKE` to stop signing. Local and on-chain stages are reported separately         |

They start empty because nothing has bought anything yet. Drive traffic
through them:

```bash
pnpm --filter @neuro-pay/api demo
```

That opens a stream, pulls segments, and answers each 402. The console
updates live over SSE — watch accrual climb, a 402 fire at the threshold,
and payments land in the ledger. Details and the honest caveats are in
[Driving the payment loop](#driving-the-payment-loop-pnpm-demo).

When you want the real thing — a session granted on chain, funded wallet,
actual settlement — follow the
[operator checklist](#operator-checklist-chain-97).

### What works today

The repository is mid-build. What the running app does and does not do:

| Area                                               | State                                                                                                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seller: 402, verify, deliver, ledger, console, SSE | Works end to end                                                                                                                                                                                                        |
| Buyer payment client (`fetchWithX402`)             | Built and tested. `pnpm --filter @neuro-pay/api demo:real` is the buyer process (needs `SESSION_PRIVATE_KEY`)                                                                                                           |
| Signature verification                             | Production runtime uses ERC-1271 via Permit2. The seller recomputes the EIP-712 digest itself — the wire carries no hash — so a wrong-chain payment fails the signature check rather than a field compare               |
| Settlement                                         | Chain-backed settler when `SETTLER_PRIVATE_KEY` + `RPC_URL` are set; otherwise in-memory. The settler EOA is published in every 402 as `extra.spenderAddress`, because Permit2 binds the signed spender to `msg.sender` |
| On-chain revoke                                    | Wired when `ADMIN_PRIVATE_KEY` + `RPC_URL` are set; local-only with a logged warning otherwise                                                                                                                          |
| Payment crediting the meter                        | Confirmed settlements call `recordSettle` (capped at `accruedUnpaid`); failed settlements keep the exposure slot                                                                                                        |

Confirmed settlements now credit the meter, so a 402 after a successful
settle demands only newly accrued unpaid cost. Failed settlements do not
credit the meter and keep the exposure slot reserved until operator
retry (P1) or process restart.

**Three addresses, not two.** A Permit2 payment involves the payer (the
buyer's smart account), the recipient (`payTo`, bound inside the signed
witness), and the _spender_ — the settler EOA that calls
`permitWitnessTransferFrom`. Permit2 checks the signed spender against
that call's `msg.sender`, so the seller publishes its settler address in
the 402 and refuses any permit signed for a different one. Running
without `SETTLER_PRIVATE_KEY` advertises `payTo` as the spender, which is
fine for the in-memory local loop and produces signatures that are **not**
settleable on chain.

One naming inconsistency: the product copy says USDC, while
`.env.example` defaults `TOKEN_ADDRESS` to BSC testnet **USDT**. The chain
config is authoritative — verify the address on the explorer before use.

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

### Driving the payment loop (`pnpm demo`)

The seller half of the loop runs in the API. Without a buyer,
`GET /v1/streams/:id/next` returns a 402 that nobody answers, so the
console reads a ledger nothing writes to and every panel stays empty.

`apps/api/scripts/demo-stream.ts` is the synthetic buyer for a demo. With
the API running:

```bash
pnpm --filter @neuro-pay/api demo                  # 20 segments
pnpm --filter @neuro-pay/api demo --segments 50 --delay 200
```

It opens a stream, pulls segments, answers each 402, and prints the
accrual as it goes. Watch it land live at
[http://localhost:3000/console](http://localhost:3000/console) — the
blotter updates over SSE.

**It does not sign.** The envelope carries a placeholder signature and is
accepted only because the composition root currently injects a stub
verifier and an in-memory settler:

```ts
verifier: async () => IS_VALID_SIGNATURE_MAGIC   // apps/api/src/runtime.ts
settler: createInMemorySettler({ ... })          // apps/api/src/runtime.ts
```

Against a real ERC-1271 verifier every payment is rejected as
`verification-failed`, which is correct — there is no real signature. Use
the demo for console, ledger, and UI work; never as evidence that signing
or settlement works. The witness fields (payTo, token, chainId, amount,
deadline) are filled honestly, because the seller checks each one before
the verifier ever runs.

> **Pin `SESSION_STORE_PATH` when provisioning.** The script resolves it
> relative to _its own_ working directory, so running it through
> `pnpm --filter @neuro-pay/altana` writes the record under
> `packages/altana/` while the API reads it from `apps/api/.data/`. The
> grant lands on chain either way and the console then answers 404 for a
> session that demonstrably exists, which is a confusing thing to debug.
> Pass an absolute path:
>
> ```bash
> SESSION_STORE_PATH=$PWD/apps/api/.data/session.json \
>   pnpm --filter @neuro-pay/altana provision
> ```
>
> A revoked session key stays **registered** in the keystore, so a later
> grant with the same `SESSION_PRIVATE_KEY` fails with
> `KeyStore: key already registered`. Replacing a session means a new
> key, not a re-grant.

### Signed payments (`pnpm demo:real`)

`apps/api/scripts/demo-real-signing.ts` is the buyer that actually signs.
It loads a `PersistedSession`, attaches `SESSION_PRIVATE_KEY` as the
store's `signerSource`, hydrates a live SDK session, and calls
`fetchWithX402`.

```bash
# Grant with an operator-held session key so a later process can sign:
SESSION_PRIVATE_KEY=0x... pnpm --filter @neuro-pay/altana provision
SESSION_PRIVATE_KEY=0x... pnpm --filter @neuro-pay/api demo:real
```

The store never persists the private half. If you omit
`SESSION_PRIVATE_KEY` at grant time, the SDK generates an ephemeral key
that dies with the provision process and `demo:real` cannot sign.

Prices must be non-zero or nothing is ever charged: `createSeller`
defaults every price to zero, so accrual never reaches
`SETTLEMENT_THRESHOLD` and no 402 is generated. Set `PRICE_PER_UNIT` (and
optionally `PRICE_PER_CALL` / `PRICE_PER_SECOND`, all in smallest units)
in `apps/api/.env`; `.env.example` ships dev-scale values.

### Seeding a session (`pnpm seed:session`)

`/v1/session`, `/v1/budget`, and `POST /v1/session/revoke` all read the
first record in the `SessionStore`. With an empty store the first two
answer 404 (the console renders empty panels) and revoke answers 404,
which the UI shows as `revoke failed with 404`. The store's only real
writer is the provisioner, which needs an admin key, a funded wallet, and
on-chain fees.

`/v1/session`'s `status` field is also chain-backed whenever `RPC_URL` is
set: it reads a live Keystore `isValidKey` check rather than only expiry

- the local rail flag, so a session revoked from outside this process
  (another operator run, a different revoke call) shows up as `"revoked"`
  on the next poll.

For console work, seed a fake record instead:

```bash
pnpm --filter @neuro-pay/api seed:session
```

It writes a `PersistedSession` through the same byte-exact codec, so the
session card, the budget meter, and the local half of the kill switch all
work offline. The record describes a session that does not exist on chain
and has no signer behind it — nothing can sign a payment with it. Pass
`--force` to overwrite an existing record, and `--wallet 0x…` to choose the
address.

Revoke against a seeded session without `ADMIN_PRIVATE_KEY` set returns
the local-only stub — stage two never ran because there is no admin
signer to run it with:

```json
{
  "local": { "revoked": true },
  "onChain": { "revoked": false, "status": null, "transactionHash": null }
}
```

With `ADMIN_PRIVATE_KEY` + `RPC_URL` set, `POST /v1/session/revoke` drives
the real two-stage flow: local removal, then `revokeSession` on chain. If
the on-chain stage reports `"FAILED"` (or the relay call throws),
`onChain.revoked` is `false` and the console keeps the failed snapshot in
memory — `POST /v1/session/revoke/retry` resubmits stage two only, using
that cached snapshot (the store record is already gone by then). A retry
with nothing pending answers 404 instead of re-submitting.

### Testing the payment path by hand

The chain config is only needed to exercise payments end to end. Without it, `tryCreateRuntime` catches the `ConfigError`, logs `payment runtime disabled`, and mounts the API without the console and seller routes — `/health` and the web app still work, which is the right state for frontend and logging work.

To mount the payment routes, fill these in `apps/api/.env` (the rest already default to BNB testnet):

| Variable              | Why                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PAY_TO`              | Settlement recipient, bound into every Permit2 witness                                                       |
| `SETTLER_PRIVATE_KEY` | EOA that submits `permitWitnessTransferFrom`; needs testnet BNB for gas                                      |
| `ADMIN_PRIVATE_KEY`   | Wallet creation, `grantSession`, rail provisioning (provisioner script), and on-chain revoke (API, optional) |

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
6. Provision the wallet and session. The grant is written to
   `SESSION_STORE_PATH` (default `.data/session.json`) — the same file the
   API reads at startup, so the console sees the session the provisioner
   created:

   ```bash
   pnpm --filter @neuro-pay/altana provision
   ```

   The script prints the smart-account address to fund and every transaction hash. Fund that address from the [BNB testnet faucet](https://www.bnbchain.org/en/testnet-faucet) **before** the grant if the wallet is new.

7. `grantSession` writes to Keystore and costs a fee. A fresh wallet's first admin action is expected to carry a one-time `initialRegisterKey` cost in the same userOp, so budget for the grant costing more than a steady-state one.

   The measured chain-97 figures so far are grant 968,320 gas, approve-token 127,361, approve-checker 115,737. Those do **not** establish the "charged twice" claim — a grant writes a session key, its spend caps, and its allowlist, while an approve flips one storage slot, so the gap is mostly the grant doing more work. `pnpm --filter @neuro-pay/altana probe:fee` runs the experiment that can settle it (two grants on one fresh wallet, first-ness the only variable). Until it has been run, treat the doubling as unverified.

8. Every operator script records its transaction hashes to the on-chain runbook, so a hash outlives the terminal it was printed in:

   ```bash
   pnpm --filter @neuro-pay/altana runbook
   ```

   Backfill anything sent outside the tooling — the faucet funding, most obviously — with `runbook --add <action> <wallet> <txHash>`; gas and block are read from the chain, not typed in.

9. Revoking is the kill switch, and it has its own command:

   ```bash
   pnpm --filter @neuro-pay/altana revoke -- --dry-run   # read-only: prints current on-chain authority
   pnpm --filter @neuro-pay/altana revoke -- --yes       # irreversible
   ```

   It reads authority before, revokes locally then on chain, reads authority after, and records the hash. The after-read is the point: submitting a transaction is not the same claim as the session being dead on chain. Note that an **already-expired** session reads `expired` either way, so the verification is only conclusive while the session is live.

10. Session persistence is byte-exact. The store re-encodes on load and **hard-fails** on mismatch. Do not hand-edit `.data/session.json`. A sloppy JSON round-trip (bigint → number, reordered keys) grants cleanly and then fails every payment.
11. Start the API and the console:

```bash
pnpm dev
```

Seller + console API: [http://localhost:4000](http://localhost:4000) · blotter: [http://localhost:3000/console](http://localhost:3000/console)

### Securing the console

Every console route — session policy, payment history, and the revoke
kill switch — requires an operator bearer token. Generate one and set it
on **both** the API and the web app:

```bash
openssl rand -hex 32
```

```
apps/api/.env       CONSOLE_API_TOKEN=<token>
apps/web/.env.local CONSOLE_API_TOKEN=<token>   # same value, server-side only
```

Leaving it unset keeps the console open and logs a warning at boot.
That is fine on a local box and never fine in a deployment: anyone who
can reach the port can read your payment history and revoke the session.
A token under 32 characters is refused outright rather than accepted
weakly.

`CONSOLE_API_TOKEN` must never be `NEXT_PUBLIC_`-prefixed. Next inlines
those into client JavaScript, which would publish the kill switch to
every visitor. The browser never holds it: the console talks to a
same-origin proxy at `/api/console/*` that adds the header server-side
and forwards only an allowlist of console paths.

The **buyer** routes (`POST /v1/streams`, `GET /v1/streams/:id/next`)
are deliberately unauthenticated. A buyer proves itself by paying, which
is a stronger claim than a shared secret, and requiring a token there
would break every third-party b402 client. They are bounded by abuse
controls instead:

| Control                 | Default            | Env                      |
| ----------------------- | ------------------ | ------------------------ |
| Stream creation rate    | 30/min per caller  | —                        |
| Segment request rate    | 600/min per caller | —                        |
| Concurrent live streams | unbounded          | `MAX_CONCURRENT_STREAMS` |

Rate and concurrency are different bounds and you want both: a burst
trips the rate limit without holding many streams, and a slow, patient
opener never trips it but still accumulates. Over either limit the API
answers 429 or 503 with `Retry-After`.

Behind more than one replica these limits are per-replica. A real
deployment wants a shared store or an edge limiter.

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

## Health, metrics, and the audit trail

`GET /health` answers "is this process running" and always has. It is
what a supervisor restarts on, and it is nearly useless for the question
an operator actually has, which is "can this process settle a payment
right now" — a process with an unreachable RPC, a Permit2 address with no
code behind it, or a settler with no gas is alive and completely unable
to do its job.

So readiness is a separate surface with a probe per dependency:

| Route                               | Auth           | What it answers                                          |
| ----------------------------------- | -------------- | -------------------------------------------------------- |
| `GET /health`                       | none           | Liveness. Always `ok` while the process runs.            |
| `GET /ready`                        | none           | Readiness. Check names and verdicts only. 503 when down. |
| `GET /v1/health`                    | operator token | The same report with probe messages and firing alerts.   |
| `GET /metrics`                      | operator token | Prometheus exposition.                                   |
| `GET /v1/metrics`                   | operator token | The same numbers as JSON.                                |
| `GET /v1/audit`                     | operator token | Administrative audit trail.                              |
| `POST /v1/settlements/:nonce/retry` | operator token | Resubmit a failed settlement.                            |

`/ready` is the only open one, and it publishes strictly the shape of the
answer — which dependencies exist and whether each is healthy. That is
what a scheduler needs and is already inferable from the service being
reachable. The diagnosis (which RPC, which token contract, which settler
address, and why each probe is unhappy) stays behind the token.

The probes check the _claims configuration makes_, not merely that a call
returned: the RPC answers **and it is the configured chain**; the token's
`decimals()` answers **and it matches config**; Permit2 has code at the
canonical address. The difference is a whole class of misconfiguration
that otherwise surfaces as an unexplained revert after a segment has
already been delivered.

Verdicts are `ok`, `degraded`, `down`, or `skipped`. A dependency that is
not wired in this environment reports `skipped` with the reason rather
than being omitted — a missing line in a health report reads as "fine",
and an unconfigured settler is not fine in production. `degraded` answers
200 on purpose: a settler under its balance floor settles fine until it
does not, and pulling a working instance out of rotation over a warning
is worse than leaving it in.

### Metrics are derived, not counted

Nothing is an in-process counter. Every number is recomputed from the
append-only ledger on read, which is what makes the numbers survive a
restart, agree across two processes reading the same file, and stay
correct after a crash. A metric you can only get by having been running
the whole time is a metric that lies after the first deploy.

Covered: payment verification outcomes and failure classifications;
settlement counts by state; submitted-to-confirmed latency quantiles;
unrecovered failed settlements; exposure saturation; budget headroom and
exhaustion; session status and remaining lifetime; settler balance;
ledger schema version.

Alerts are derived the same way — recomputed on read from those metrics
plus live process state, so they cannot go stale and need no delivery
machinery to be correct. Thresholds are tunable; see
`apps/api/.env.example`. Wiring them to a pager is a matter of scraping
the endpoint.

### The audit trail

`GET /v1/audit` reads a second append-only table in the ledger file
recording administrative actions: who invoked the kill switch, when a
price sheet changed, what configuration the process booted with, every
settlement retry. Each record carries an actor, an outcome, and the HTTP
request id, which ties it to the access log line with the source and
timing.

It is separate from the payment ledger because every ledger row carries a
chain, a token, and decimals — every row is a fact about money — and "an
operator revoked the session at 14:02" has none of those. It keeps the
same guarantees: append-only, independently ordered, and refused outright
if a write carries key material.

### Operator procedures

- Settlement reconciliation, retry, and the alert playbook:
  [`docs/runbooks/settlement-reconciliation.md`](docs/runbooks/settlement-reconciliation.md)
- Ledger backup, restore, corruption recovery, retention, and schema
  versioning: [`packages/ledger/README.md`](packages/ledger/README.md)

## Local EVM integration tests

Some things can only be verified against a real EVM. `pnpm test` runs
against stubs and asserts what the code _passes_; a settlement asserts
what Permit2 _accepts_, and those are different claims. The P0
wire-format defects — an empty signature, a witness hash invented from
the nonce, a malformed type string — were all invisible to unit tests
and all produced unconditional on-chain reverts.

`@neuro-pay/evm-testnet` forks BNB testnet locally so those claims can be
checked. It is a separate command because each suite boots a chain and
needs network:

```bash
FORK_RPC_URL=https://data-seed-prebsc-1-s1.bnbchain.org:8545 pnpm test:chain
```

Needs foundry (`brew install foundry`) or a running Docker daemon — the
launcher detects either, preferring the native binary. With neither, the
suites **skip with a reason** rather than failing, so a fresh clone still
builds green. That also means a green `pnpm test` says nothing about the
chain suites; `pnpm test:chain` has to be run on purpose.

### Why fork rather than deploy to a blank chain

Altana's smart account and session keystore are consumed through
`@altananetwork/sdk`; this repo has neither their source nor their
bytecode, so there is nothing to deploy. A fork puts every contract at
its real address, including Permit2 and the real ERC-20 with its real
`decimals()`.

### What a fork can and cannot prove

**Forkable** — anything that is an `eth_call` or a transaction this
process signs and sends: Permit2's deployment and
`permitWitnessTransferFrom`, the token's decimals and transfers, the
keystore's `isValidKey` authority read.

**Not forkable** — `grantSession`, `revokeSession`, `provisionWallet`,
`provisionRail`. These do not go through the configured RPC at all: the
SDK submits them to **Altana's hosted relay**, which broadcasts to the
real network. Pointing `rpcUrl` at a fork changes where reads go and has
no effect on where the relay writes. That half can only ever be verified
against chain 97, which is why it stays on the P1 list.

### What this closed

`apps/api/src/seller/settlement.chain.test.ts` settles a real signed
permit through real Permit2 and asserts the tokens moved — the first
end-to-end proof that the P0 wire-format work produces a settlement the
contract accepts. It also pins the failure modes: a replayed nonce, a
signature bound to the wrong spender, and a tampered witness.

Two findings worth knowing before writing more of these:

- **The payment token had to be replaced.** The BSC testnet USDT the
  config named is owner-gated by a third party — `mint` reverts for
  every key here — and the official faucet gates claims behind mainnet
  BNB and a once-per-day web form. Funding a test wallet was a manual
  errand, which is a poor foundation for a loop meant to be repeatable.
  The project now deploys its own token
  (`packages/evm-testnet/contracts/NeuroPayTestUSD.sol`, `npUSD`, 18
  decimals) with an **open mint**, so funding is a function call. The
  contract refuses to deploy on a production chain id, so a free mint
  cannot land where it would be mistaken for value.
- **Anvil's dev accounts are not clean EOAs on BNB testnet.** Somebody
  has EIP-7702-delegated those well-known keys, so Permit2 sees code at
  the address, skips `ecrecover`, and calls ERC-1271 on the delegate —
  failing with an empty revert that explains nothing. Clear it with
  `cheats.setCode(addr, "0x")`.

### The test payment token

```bash
# rehearse against a fork — deploys, mints, reads back, broadcasts nothing
pnpm --filter @neuro-pay/evm-testnet deploy:token -- --dry-run

# broadcast for real to RPC_URL
pnpm --filter @neuro-pay/evm-testnet deploy:token -- --yes

# allow Permit2 to pull the token (needed whenever TOKEN_ADDRESS changes)
pnpm --filter @neuro-pay/evm-testnet approve:permit2 -- --yes
```

`--dry-run` is the default posture: `--yes` is the only thing that sends
a transaction, and the private key signs in-process rather than being
passed to a container where `docker inspect` would expose it. Foundry is
used to compile only; the artifact is committed so deploying needs no
Solidity toolchain.

Details, cheat-code reference, and the determinism caveats:
[`packages/evm-testnet/README.md`](packages/evm-testnet/README.md).
