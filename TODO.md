# TODO

This file tracks missing, incomplete, and unverified project capabilities. Items are grouped by priority and should be checked off only after implementation and verification.

## P0 — signed-payment wire format & settlement plumbing (discovered 2026-08-19)

> **Status 2026-08-20:** every code defect in this section is fixed and the
> whole path now round-trips against `@altananetwork/sdk`'s real
> `signX402Payment` output in tests (no hand-written envelope fixtures on
> the seller's happy path). Plan: `openspec/changes/fix-b402-wire-format/proposal.md`.
> Still unproven on chain — see the last item and the P1 chain-97 loop.

Discovered by running the real signed-payment path against a funded BNB testnet wallet for the first time (provisioning succeeded — grant `0x4b1277ecd3aad93a8d3373fbe230d673f54d9372bddc9abecdb318cb37cd0922`, approve-token `0x9d9c9973f51e7be5f3d5df599e058cb7b8c9f0531c533d64d376ce412e2bf579`, approve-checker `0x5954682cb60f85966b6188824c9ab5ad8742fdf7b755de468204947bc7ac85f7`, all confirmed on-chain). Every payment attempt after that failed. The seller-side envelope parser and verifier, and the buyer-side encoder, were each unit-tested only against their own synthetic fixtures and never cross-checked against the other side or against `@altananetwork/sdk`'s actual output — none of it has ever round-tripped for real. This invalidates the functional (not structural) claims behind P0 items 1–3 and 9 below: the wiring described there is real, but the data flowing through it is not what the real protocol produces or needs.

- [x] Header dedup: `extractEnvelope` (`apps/api/src/seller/envelope.ts`) treated the buyer's compliant dual `X-PAYMENT` + `PAYMENT-SIGNATURE` headers (same payload, sent for facilitator compatibility — see the module's own docstring) as ambiguous and rejected them. Fixed to only flag `"multiple"` when the two headers actually disagree; `envelope.test.ts` updated and green. _(commit — see `apps/api/src/seller/envelope.ts` / `envelope.test.ts`.)_
- [x] Envelope shape mismatch: the buyer's encoder (`packages/altana/src/payment/encode.ts`) nests `from`/`permit`/`permit2Authorization` under `payload.*`; the seller's parser (`apps/api/src/seller/envelope.ts` `parseEnvelope`, ~line 190) reads them at the envelope's top level. Every real envelope fails with `missing-from`. _(`parseEnvelope` now reads `payload.*` first and falls back to the root for a non-SDK buyer that flattens; `envelope.test.ts` parses real `signX402Payment` output.)_
- [x] Encoder data loss: `encodeB402Envelope` (`packages/altana/src/payment/encode.ts` ~line 117) _replaces_ the SDK's `permit`/`permit2Authorization` objects with a bare `{from, signature}` instead of merging into them, discarding `permitted` (token/amount), `spender`, `nonce`, `deadline`, `witness` — data settlement needs downstream. _(now a spread-merge over the SDK's objects; the round-trip test asserts the whole struct survives.)_
- [x] Hash never transmitted: the seller trusts a wire-supplied `permit.hash` for the ERC-1271 check (`apps/api/src/seller/verify.ts` ~line 172). The real SDK never sends one (`signX402Payment` in `@altananetwork/sdk`'s `x402.js` returns only `signature` + the Permit2 struct). The seller must recompute the EIP-712 digest itself — the SDK exports `buildPermit2WitnessTypedData` for exactly this, currently unused by this project. _(`packages/altana/src/payment/digest.ts` wraps `buildPermit2WitnessTypedData` as `permit2WitnessDigest`; `verify.ts` recomputes with the locally configured chain id and never reads a wire `hash`. A test plants a bogus `hash` and asserts it is ignored.)_
- [x] Witness field shape: `readPermit2WitnessFields` (`apps/api/src/seller/envelope.ts` ~line 259) expects `{payTo, amount, token, chainId}` on one object. The real wire has `amount`/`token` under `permit.permitted`, `payTo` as `witness.to`, and `chainId` is never transmitted at all (it's implicit in the EIP-712 domain the signature covers, not a checkable field) — `wrong-chain` rejection needs to move from a local field comparison to relying on the recomputed-digest/signature mismatch. _(replaced by `permitBindings` over a typed `Permit2Permit`; the `chainId` field check is gone and wrong-chain is now proven by digest mismatch in `verify.test.ts` and `integration.test.ts`.)_
- [x] Wrong spender bound into the signature: `toSdkRequirement` (`packages/altana/src/payment/sign.ts` ~line 176) sets `extra.spenderAddress: requirement.payTo`. Permit2 requires the signed `spender` to equal `msg.sender` of whoever calls `permitWitnessTransferFrom` — that's the **settler EOA** (`SETTLER_PRIVATE_KEY`'s address), a third address distinct from `payTo`. The seller doesn't even echo a settler address in the 402's `extra` field today (`apps/api/src/seller/requirements.ts` `requirementsFor`, ~line 773, sets no `extra` at all). _(`X402Extra` gained `spenderAddress` + `assetTransferMethod`; `SellerConfig.settlerAddress` is published in every 402 and derived from `SETTLER_PRIVATE_KEY` in `runtime.ts`; the buyer takes it from the wire and throws `MissingSpenderError` rather than guessing; the verifier and the chain settler both refuse a permit naming a different spender.)_
- [x] Settlement submission uses fabricated values, not the real signed data: `chain-settler.ts` `submitSettle` (~line 145–170) hardcodes `signature: "0x"` (empty — the buyer's real signature is never threaded through), fabricates `witness` from the nonce (`witnessPlaceholderHash`, ~line 397) instead of hashing the real witness struct, and `witnessTypeStringFor` (~line 392) returns a malformed, non-EIP-712 type string instead of the real proxy's `Witness(address to,uint256 validAfter)`. Permit2 recomputes the digest from these exact arguments and checks it against `signature` on-chain — with all three fabricated, **every real settlement reverts unconditionally**. `SettlementInput` (`apps/api/src/seller/settle.ts`) needs to carry the real signature/witness/permit struct from `verify.ts` through the settlement queue into the chain settler. _(`SettlementInput.authorization` carries signature/spender/witness; the outbox persists them in four new columns with an additive `ALTER TABLE` migration so a crash-recovered intent is still settleable; `chain-settler.ts` hashes the real witness struct, sends `WITNESS_TYPE_STRING`, transfers to `witness.to` rather than the spender, and throws `SettlementUnsettleableError` instead of submitting a doomed transaction. Covered in `chain-settler.test.ts`.)_
- [x] Needs an ISA/plan before more code changes: this is a coordinated rewrite across `packages/altana` (encoder, spender wiring) and `apps/api` (envelope parser, witness reader, digest recomputation, settlement plumbing), not an isolated patch. Scaffold one before resuming. _(`openspec/changes/fix-b402-wire-format/proposal.md`.)_

- [x] Buyer never forwarded `maxTimeoutSeconds` (found while building the round-trip fixture): `toSdkRequirement` omitted it, so the SDK fell back to its own 3600s default and the seller's 60s cap was silently ignored — every signed deadline outlived the demand it was quoted against. Now passed through; asserted in `sign.test.ts`.
- [ ] Prove the loop on chain. **Half done as of 2026-08-20.** `permitWitnessTransferFrom` now executes against real Permit2 on a forked chain and moves the tokens (`apps/api/src/seller/settlement.chain.test.ts`), which retires the "every settlement reverts unconditionally" risk that motivated this whole section: the permit struct, the real witness hash, the type string, and the buyer's signature are accepted by the contract that recomputes the digest from them. Still unproven: `isValidSignature` against a **deployed smart account** — the settlement test uses an EOA payer, so Permit2 took the `ecrecover` branch rather than the ERC-1271 one. That needs a live granted session, which is relay-bound and therefore only reachable on chain 97.

## P0 — payment correctness and safety

- [x] Replace the accepting-all verifier in `apps/api/src/runtime.ts` with real ERC-1271 verification through the configured Permit2 signature checker. _(commit d0deea — `chain-verifier.ts` wraps `buildPermit2Verifier` with `assertPermit2Deployed`; runtime wires it unconditionally.)_ (Resolved 2026-08-20: the `hash` is now recomputed from the parsed permit — see the wire-format section above.)
- [x] Add integration tests proving invalid, expired, revoked, wrong-chain, wrong-token, wrong-recipient, and underpaid envelopes are rejected by the production composition root. _(integration.test.ts covers invalid, expired, revoked, wrong-chain, wrong-token, wrong-recipient. `underpaid` stays in `verify.test.ts`: the seller's demand-derivation uses `witness.amount` when present, so a seller-level underpaid assertion requires changing that logic.)_ (Resolved 2026-08-20: `integration.test.ts` now signs with the real SDK and covers `underpaid` at the composition root too, since the seller derives its demand from the meter rather than from the buyer's own witness.)
- [x] Replace the in-memory settler in `apps/api/src/runtime.ts` with a chain-backed settler that submits `Permit2.permitWitnessTransferFrom`. _(commit d0deea — `chain-settler.ts` drives `permitWitnessTransferFrom` via viem `writeContract`; runtime wires it when `SETTLER_PRIVATE_KEY` + `RPC_URL` are configured.)_ (Resolved 2026-08-20: all three arguments are the buyer's real signed data; `chain-settler.test.ts` pins them.)
- [x] Record settlement submission, confirmation, revert, timeout, and gasless-settler failures from the real chain path. _(commit d0deea — `recordPaymentSettlement{Submitted,Confirmed,Failed,Lost}` helpers in `packages/ledger/src/events.ts`, wired in `chain-settler.ts`; round-trip covered in `payment-settlement.test.ts`.)_
- [x] Connect confirmed settlement to `recordSettle` so `accruedUnpaid` decreases by the settled amount. _(seller wires `attachSettlementHooks` into `createSettlementQueue`; `onSettlementConfirmed` credits `min(amount, accruedUnpaid)` via `streams.recordSettle`. Covered in `index.test.ts` and `settlement-hooks.test.ts`.)_
- [x] Define and implement failed-settlement accounting, exposure handling, and recovery semantics. _(failed/lost settlements do not credit the meter and do not release the exposure slot; queue records `settlement.failed` and invokes `onFailed`. Automatic retry/outbox recovery remains P1.)_
- [x] Ensure settlement confirmation releases seller exposure; ensure failed settlements remain visible as unrecovered exposure. _(exposure releases only in `onSettlementConfirmed`; failed/lost paths keep the acquired slot. Stalling-settler test proves delivery resumes after confirm; revert test proves the slot stays held.)_
- [x] Wire `fetchWithX402` into a real buyer/agent process that loads a persisted session and signs payments server-side. _(`demo-real-signing.ts` registers `signerSource` from `SESSION_PRIVATE_KEY`, hydrates a live SDK `Session` via `createBuyerPaymentContext`, and calls `fetchWithX402`. Covered by `hydrate.test.ts` / `buyer.test.ts`.)_
- [ ] Add a real signed-payment demo separate from `apps/api/scripts/demo-stream.ts`'s synthetic placeholder envelope. _(`pnpm --filter @neuro-pay/api demo:real` exists and reattaches a real signer. The wire-format defects that rejected every payment are fixed and the whole path round-trips offline, but the demo has still not been run against a live seller with a funded wallet — it stays open until it completes a real payment. Note it now needs `SETTLER_PRIVATE_KEY` set on the seller: without it the 402 advertises `payTo` as the Permit2 spender and nothing is settleable on chain.)_

## P1 — delivery, durability, and recovery

- [x] Make nonce replay return the exact original segment payload, not a reconstructed stub or possible 404 (`apps/api/src/seller/index.ts`). _(replay loads the immutable delivery record; a verified nonce with no payload is `incomplete` rather than an empty stub. Covered in `index.test.ts` and `idempotency.test.ts`.)_
- [x] Persist immutable delivery records keyed by authorization nonce, including the exact response payload and delivery metadata. _(`delivery_records` table in the ledger SQLite file; first write wins. `recordSegmentDelivery` persists the full `SegmentResponse`.)_
- [x] Add a durable settlement-intent/outbox queue so process termination cannot lose work between delivery and settlement. _(`settlement_intents` table; seller `putIntent` before returning 200; queue drives pending → submitted → confirmed|failed.)_
- [x] Add startup reconciliation for submitted, pending, timed-out, and unknown settlement intents. _(`seller.reconcileSettlements()` / `queue.reconcile()`; runtime calls it on boot. Pending resubmits, submitted resumes confirmation, deliveries with no intent are reported as `unknown`.)_
- [x] Add retry/backoff and operator recovery for transient RPC failures and failed settlements. _(transient submit errors retry with exponential backoff; terminal out-of-gas/revert do not. `retrySettlement(nonce)` moves a failed intent back to pending.)_
- [x] Add graceful shutdown: stop new delivery, persist or drain settlement work, close SSE connections, and close the ledger cleanly. _(`seller.shutdown()` refuses new open/next, ends leftover streams, drains the outbox; `console.close()` aborts SSE; runtime `close()` clears the sweep timer and closes the ledger. SIGTERM/SIGINT wait up to 10s.)_
- [x] Add stream idle/expiry cleanup for abandoned in-memory streams. _(`StreamStore.sweepAbandoned` + `seller.sweepAbandoned`; runtime interval `STREAM_SWEEP_INTERVAL_MS` default 30s. Past `expiresAt` or idle TTL ends the stream as `abandoned`.)_
- [x] Add explicit ledger events for stream ended, abandoned, settlement retry, and recovery outcomes. _(`stream.ended` on endAll/price-change; `stream.abandoned` on idle/expiry sweep; `settlement.retry` / `settlement.recovered` on reconcile and `retrySettlement`.)_

## P1 — on-chain session lifecycle

- [x] Wire on-chain revoke into a secured API/operator service rather than returning only the local revoke result. _(`createRuntimeSessionAuthority` in `apps/api/src/runtime.ts` wires `revokeSession`/`retryOnChainRevoke` from `ADMIN_PRIVATE_KEY` + `RPC_URL` into `performRevoke`/`performRetryRevoke`; falls back to local-only with a logged warning when either is unset, same pattern as the verifier/settler wiring. Console service now caches the failed-revoke snapshot and exposes `POST /v1/session/revoke/retry`.)_
- [x] Verify live authority state after revoke and report authorized, expired, and revoked states from chain reads. _(`resolveStatus` wires `checkSessionAuthority` whenever `RPC_URL` is set, independent of the admin key; `getSession()`/console snapshots now report `active`/`expired`/`revoked`/`unknown` from a live Keystore read instead of local-only expiry+rail checks.)_
- [x] Add integration coverage for local revoke, on-chain revoke success, on-chain revoke failure, and retry. _(`packages/altana/src/session/revoke.test.ts` covers `revokeSession`'s CONFIRMED/PENDING/FAILED/thrown paths and `retryOnChainRevoke` resubmitting after a failure; `packages/altana/src/session/authority.test.ts` covers active/expired/revoked; `apps/api/src/console/service.test.ts` adds on-chain success, on-chain failure, and retry-then-clear cases against the wired console service.)_
- [x] Add an on-chain runbook so transaction hashes are recorded rather than left in terminal scrollback. _(`packages/altana/scripts/runbook.ts`; append-only JSONL at `apps/api/.data/onchain-runbook.jsonl`, gitignored. `pnpm --filter @neuro-pay/altana runbook` prints it as a markdown table; `runbook --add <action> <wallet> <tx>` backfills a transaction sent outside the tooling, reading gas and block from the chain. `provision.ts` now records every transaction it sends.)_
- [x] Backfill the 2026-08-19 provisioning hashes with their real receipts. _(All three confirmed `success` on chain, gas read from the receipts rather than recalled: grant 968,320; approve-token 127,361; approve-checker 115,737. The wallet-funding hash is still missing — add it with `runbook --add wallet-funding 0x65da8DB9... <faucet-tx>`.)_
- [x] Add a revoke operator script. _(`packages/altana/scripts/revoke.ts`, `pnpm --filter @neuro-pay/altana revoke`. Revoke existed as a library function and a console endpoint but had no CLI, which is why it was the one unrun step. The script reads on-chain authority **before**, revokes both stages, reads authority **after**, and records the hash — the claim being verified is "the session is dead on chain", which only the second read can establish. Refuses to submit without `--yes`; `--dry-run` is read-only; `--retry` resubmits the on-chain stage alone.)_
- [x] Confirm the live authority read works against a real granted session. _(`revoke --dry-run` on 2026-08-20 read `active (keystore isValidKey=true)` for wallet `0x65da8DB91431B54d437883eB70F9a13Ea3722C24` — the first time `checkSessionAuthority` has been exercised against a real on-chain grant rather than a stub.)_
- [ ] Run the revoke and record its hash. _(Blocked on an operator decision, not on code: revocation is irreversible and the wallet is funded. Command below. **Time-sensitive** — the session expires 2026-08-20T16:37:43Z, after which the authority read returns `expired` and cannot distinguish a successful revoke from a failed one. A later attempt needs a fresh grant first.)_

  ```bash
  pnpm --filter @neuro-pay/altana revoke -- --yes
  ```

- [ ] Verify the documented doubled first-admin-action fee behavior on a fresh wallet. _(The 2026-08-19 evidence does not support the claim: 968,320 gas for the grant versus 127,361 / 115,737 for the two approves compares a grant against an approve, and a grant writes a session key, its spend caps, and its allowlist while an approve flips one storage slot. Those differ by a large factor whether or not `initialRegisterKey` rides along. The two approves sitting within 1.10x of each other is mild evidence that whatever one-time cost exists was absorbed by the grant and does not recur per action. The real experiment holds the operation constant and varies only first-ness — two grants on one fresh wallet — and is implemented in `packages/altana/scripts/first-action-fee.ts`. It needs a brand-new funded wallet; freshness **is** the experiment, so the script refuses `ADMIN_PRIVATE_KEY`.)_

  ```bash
  FEE_PROBE_ADMIN_KEY=0x<fresh-key> pnpm --filter @neuro-pay/altana probe:fee -- --address
  ```

  Fund the printed address from the BNB testnet faucet, then:

  ```bash
  FEE_PROBE_ADMIN_KEY=0x<fresh-key> pnpm --filter @neuro-pay/altana probe:fee -- --yes
  ```

## P1 — end-to-end verification

> **Status 2026-08-20:** a local forked-EVM environment now exists
> (`@neuro-pay/evm-testnet`, `pnpm test:chain`) and **settlement is
> proven against real Permit2** — the first end-to-end evidence that the
> P0 wire-format work produces a transaction the contract accepts.
>
> Building it surfaced a boundary that reshapes this section: `grant`,
> `revoke`, `provisionWallet`, and `provisionRail` do **not** go through
> the configured RPC. The SDK submits them to Altana's hosted relay,
> which broadcasts to the real network, so pointing `rpcUrl` at a fork
> changes where reads go and has no effect on where the relay writes.
> Those four can only ever be verified on chain 97 — no local
> environment will ever cover them.
>
> The wallet-funding blocker is **resolved as of 2026-08-20**. It could
> not be resolved the obvious way: the BSC testnet USDT the config named
> (`0x337610d2…`) is owner-gated by a third party — `mint` reverts for
> both the admin and settler keys, verified by simulation — and the
> official faucet gates claims behind mainnet BNB and a once-per-day
> web form. So the project now deploys its own payment token with an
> open mint (`packages/evm-testnet/contracts/NeuroPayTestUSD.sol`,
> `npUSD`, 18 decimals, live at
> `0xba12ccc0e59f3d71114d147b11bc4581b723559f`). The wallet holds
> 1,000,000 npUSD and Permit2 is approved unlimited. Funding is now a
> function call instead of an errand, which is what a repeatable loop
> needed.

- [ ] Run the full chain-97 loop: open stream, accrue, receive 402, sign, verify, deliver, submit settlement, confirm settlement, and reconcile the ledger. _(No longer blocked on funding — the wallet holds 1,000,000 npUSD with Permit2 approved. What it still needs is a **granted session**, which is relay-bound: `pnpm --filter @neuro-pay/altana provision` with `SESSION_PRIVATE_KEY` set, then `pnpm --filter @neuro-pay/api demo:real` against a running seller with `SETTLER_PRIVATE_KEY` configured.)_
- [ ] Verify the threshold path independently.
- [ ] Verify the tick path independently with traffic below the threshold.
- [ ] Verify over-budget refusal before signing.
- [ ] Verify demanded-versus-expected tolerance refusal before signing.
- [ ] Verify expired-session refusal before signing.
- [ ] Verify revoked-session refusal before signing.
- [ ] Verify idempotency by replaying an accepted envelope and comparing the exact response and unchanged accrual.
- [ ] Verify kill switch behavior mid-stream, including immediate local signing stop and confirmed on-chain revocation.
- [ ] Verify exposure bounding by stalling settlement, reaching the configured limit, and confirming delivery resumes after settlement clears.
- [x] Add a repeatable local EVM integration environment for ERC-1271, Permit2, token decimals, settlement, and revoke. _(`packages/evm-testnet`: forks BNB testnet via native anvil or the foundry Docker image, whichever is present, and exposes the cheat codes that make a chain behave like a fixture — assignable balances, impersonation, `dealToken` (which finds the ERC-20's balance slot by probing rather than hard-coding it per token), instant blocks, and `withSnapshot` so a destructive test is repeatable. Run with `pnpm test:chain`; with no runner or no fork endpoint the suites **skip with a reason** rather than failing a fresh clone's build._
      _**Covered:** Permit2 deployment, the token's real `decimals()` in both directions, the keystore `isValidKey` authority read, and `permitWitnessTransferFrom` — `apps/api/src/seller/settlement.chain.test.ts` settles a real signed permit through real Permit2 and asserts the tokens moved, plus the failure modes (replayed nonce, wrong spender, tampered witness)._
      _**Not covered, and never will be here:** revoke and grant. Both are relay-bound — see the section note. `packages/altana/src/session/lifecycle.chain.test.ts` records why in place of the tests that cannot exist._
      _**Not deterministic across runs:** pinning a fork block needs an archive endpoint, and the public BNB testnet endpoints prune state past roughly a thousand blocks. The suites establish their own state instead of assuming any._
      _One trap worth knowing: anvil's well-known dev accounts are EIP-7702-delegated on BNB testnet, so Permit2 sees code, skips `ecrecover`, and calls ERC-1271 on the delegate — an empty revert that explains nothing. `cheats.setCode(addr, "0x")` restores them to plain EOAs.)_

## P1 — security and access control

> **Status 2026-08-20:** complete. Verified live against a running API with
> `CONSOLE_API_TOKEN` set: every console route answers 401 without a token
> and with a wrong one, the buyer routes stay open, and the stream ceiling
> refuses past its limit with `Retry-After`.

- [x] Add authentication and authorization for console APIs. _(`apps/api/src/auth.ts`: bearer token from `CONSOLE_API_TOKEN`, compared with `timingSafeEqual` and no early return on a length mismatch. A token shorter than 32 chars is fatal rather than a silent downgrade — an operator who set the variable meant to turn auth on. The guard is mounted on the console router, not a path prefix, because `GET /v1/streams` (operator) and `POST /v1/streams` (buyer) share a path and differ only by method; `auth.test.ts` pins that split in both directions. Buyer routes stay unauthenticated by design: a buyer proves itself by paying, which is a stronger claim than a shared secret.)_
- [x] Protect the revoke endpoint with explicit operator authorization and audit logging. _(Both revoke routes now sit behind the token. The ledger already recorded the outcome as `session.revoked`; the routes now also log the *request* at warn with its request id, so a revoked session is traceable to the call that ended it.)_
- [x] Confirm no endpoint, log, ledger row, browser bundle, or error response exposes private/admin/session key material. _(`apps/api/src/no-key-material.test.ts` plants sentinel secrets in the environment, drives all ten routes including the 404 and a deliberately-throwing 500, and asserts no body or header echoes them, prefixed or bare. It also walks `apps/web/src` for a `NEXT_PUBLIC_*` variable whose name implies a secret, and for `CONSOLE_API_TOKEN` in any `"use client"` file — the realistic way this regresses.)_
- [x] Add rate limiting and abuse controls for stream creation and segment requests. _(`apps/api/src/rate-limit.ts`: per-caller token buckets, refilling continuously so a caller cannot spend a full allowance either side of a window boundary. Separate buckets per surface — stream creation is rarer and costlier (30/min) than the segment hot path (600/min). `X-Forwarded-For` is ignored unless a proxy is explicitly trusted, since a client can set it itself and would otherwise mint a fresh identity per request. 429 carries `Retry-After`.)_
- [x] Add limits and cleanup for abandoned clients and excessive concurrent streams. _(`SellerConfig.maxConcurrentStreams`, from `MAX_CONCURRENT_STREAMS`. Rate and concurrency are different bounds and both are needed: a slow, patient opener never trips the bucket but still accumulates. The ceiling counts *live* streams so an ended record does not hold a slot it stopped using; `StreamCapacityError` maps to 503 + `Retry-After` rather than the shutdown 503, because it resolves on its own. The idle sweep for abandoned streams already existed.)_
- [x] Review CORS and deployment defaults for non-local environments; keep the allowlist explicit and never default to `*`. _(Already correct — `resolveCorsOrigin` refuses `*` even when written explicitly — but it was untested. Now covered, and `Authorization` was added to `allowHeaders` or the console preflight would reject every request before it was sent.)_

### Console auth changed the web app too

The console is a client component, so with the API enforcing a token the
browser would have to hold one. It must not: anything reachable from
client code is in the bundle, and `EventSource` cannot send headers at
all. `apps/web/src/app/api/console/[...path]/route.ts` is a same-origin
proxy that keeps the token server-side and forwards an **allowlist** of
console paths — a pass-through proxy would let the browser reach the
buyer routes through a credential it was never given.

Set `CONSOLE_API_TOKEN` on both the API and the web app (same value; see
each `.env.example`). Leaving it unset keeps the console open and logs a
warning at boot, which is fine locally and never fine deployed.

## P2 — observability and operations

> **Status 2026-08-20:** complete. Six routes now carry the operational
> surface — `/ready` (open, verdicts only), `/v1/health`, `/metrics`,
> `/v1/metrics`, `/v1/audit`, and `POST /v1/settlements/:nonce/retry`
> (all operator-token). None of it has been exercised against a live
> chain yet; the probes are covered against injected clients, and the
> chain-facing half is only as proven as the P1 chain-97 loop below.

- [x] Add metrics for payment verification, settlement latency, settlement failures, gasless settler state, exposure saturation, budget exhaustion, and session expiry/revocation. _(`packages/ledger/src/metrics.ts` folds the append-only trail into `LedgerMetrics`; `apps/api/src/ops/service.ts` joins it to live process state and `ops/prometheus.ts` renders it. Nothing is an in-process counter — every number is recomputed from the ledger on read, so it survives a restart and two processes reading one file agree. The fold de-duplicates the two settlement event families (`settlement.*` from the queue, `payment.settlement.*` from the chain settler) by nonce, or every normal settlement would count twice; latency measures from the **first** submission so a retry does not report a wait shorter than the buyer's. A value that is unknown is omitted from the exposition rather than rendered as 0 — an unreadable settler balance and an empty one must not look identical.)_
- [x] Add alerts or operator-visible health status for failed settlement accumulation and a drained settler account. _(`deriveAlerts` in `apps/api/src/ops/health.ts`: `failed-settlement-accumulation`, `settler-drained` / `settler-balance-low`, `exposure-saturated`, `budget-exhausted`, and the session lifecycle set. Derived on read from the same inputs the metrics use, so `/v1/health` and `/metrics` cannot disagree about what is firing, and nothing goes stale across a restart. The failed-settlement warning defaults to **1**, not a rounder number: one failed settlement is a segment already delivered that will not be paid for. Thresholds are env-tunable.)_
- [x] Add readiness/health checks for RPC connectivity, token decimals, Permit2 deployment, settler balance, ledger availability, and session authority. _(`apps/api/src/ops/probes.ts`, run in parallel under a 5s deadline apiece — a hung RPC otherwise hangs the health check with it. Each probe checks the claim configuration makes, not that a call returned: the RPC answers **and it is the configured chain**; `decimals()` answers **and it matches config**. A dependency that is not wired reports `skipped` with the reason rather than being omitted, since a missing line in a health report reads as "fine". `degraded` answers 200 on purpose — pulling a working instance out of rotation over a settler below its floor is worse than leaving it in.)_
- [x] Add ledger schema versioning and migrations. _(`packages/ledger/src/migrations.ts` replaces the ad-hoc `CREATE TABLE IF NOT EXISTS` + hand-guarded `ALTER` list with an ordered, append-only migration list, `PRAGMA user_version`, and a `schema_migrations` table. The property the old code lacked entirely: a file written by a **newer** build is refused at open with `LedgerSchemaVersionError` instead of being silently appended to through an older understanding of the schema. Legacy files (`user_version = 0`, tables present) upgrade in place because every step is idempotent, and the whole run is one transaction so a half-failed migration rolls back rather than landing in a state no version describes. Covered in `test/migrations.test.ts`, including the legacy-upgrade, future-file, and rollback cases.)_
- [x] Document ledger backup, restore, corruption recovery, and retention procedures. _(`packages/ledger/README.md`. Names the wrong way explicitly: `cp` of a WAL-mode database captures a torn state, so backups go through `sqlite3 .backup` and are verified with `integrity_check` before being trusted. Recovery prefers `.recover` over a backup because the append-only design makes a partially-recovered ledger a *prefix* of the truth rather than a mixture. Retention is "keep everything" with the reason: every derived number is recomputed from the full trail, so pruning silently changes the answers rather than only freeing space.)_
- [x] Document settlement reconciliation and operator retry procedures. _(`docs/runbooks/settlement-reconciliation.md`: what startup reconciliation does per intent status, how to read current state, how to diagnose **before** retrying (the classification says whether a retry can help at all — a Permit2 revert usually cannot), and a playbook per alert. `POST /v1/settlements/:nonce/retry` was added so the runbook has a real operator surface; retry existed only as a library method before, and 409 rather than 500 is the answer when a retry legitimately does not go through.)_
- [x] Add structured audit events for revoke, provisioning, configuration changes, and administrative actions. _(`audit_events`, a second append-only table in the same ledger file with the same guarantees — independently ordered, key-material-refused, actor required. Separate from `ledger_entries` because every ledger row carries a chain, a token, and decimals, and "an operator revoked the session at 14:02" has none of those; forcing it in would mean inventing values later aggregations would sum. Wired for revoke, revoke-retry, settlement retry, price changes, and the effective config at boot, each carrying the HTTP request id that ties it to the access log. Provisioning stays on the runbook JSONL: those scripts run out of process and giving `@neuro-pay/altana` a ledger dependency would invert the layering.)_

Two follow-ups this left open, neither blocking:

- The web console proxy allowlist (`apps/web/src/app/api/console/[...path]/route.ts`) was deliberately **not** widened. Nothing in the browser console reads the new routes yet, and an allowlist widened ahead of a consumer is a hole with no user.
- `/metrics` is Prometheus text behind the operator token. No scrape config, dashboard, or alert-manager wiring ships with this — the endpoint is the contract, the deployment side is the operator's.

## P2 — product and API completeness

- [ ] Resolve the USDC/USDT naming inconsistency between product copy and BNB testnet configuration. _(Wider than first recorded: as of 2026-08-20 the configured token is neither — it is `npUSD`, this project's own test token. Product copy needs to stop naming a specific stablecoin, or the copy needs to say "test token" plainly.)_
- [ ] Validate token address, symbol, and decimals together at startup, not decimals alone. _(Now demonstrably load-bearing: the address that shipped as the default for months was a near-inert third-party contract nobody here could mint, and decimals-only validation passed it happily every boot. Symbol and address belong in the same check.)_
- [ ] Add API route schemas and OpenAPI or equivalent generated contract documentation.
- [ ] Add API contract tests covering web/API wire compatibility and bigint transport revival.
- [ ] Add explicit multi-session selection if the product moves beyond the current first-session behavior.
- [ ] Add session provisioning and configuration UI/API if operator-script-only provisioning is no longer sufficient.
- [ ] Add a real third-party b402 interoperability test against a compatible merchant/facilitator.
- [ ] Preserve and test the distinct EOA-only facilitator failure classification.
- [ ] Define supported stream lifecycle states and expose them consistently in API, ledger, and console.
- [ ] Add pagination/filtering for payment history and stream history as data volume grows.

## Existing OpenSpec tasks still unverified

These tasks remain unchecked in `openspec/changes/add-x402-micropayment-streaming/tasks.md`:

- [ ] 9.1 Fund the wallet from the BNB testnet faucet and record funding and grant transaction hashes, including the doubled first-admin-action fee.
- [ ] 9.2 Run the full local-seller loop against chain 97 and reconcile the ledger trail.
- [ ] 9.3 Verify the tick path independently.
- [ ] 9.4 Verify live refusal paths: over-budget, overcharge tolerance, expired session, and revoked session.
- [ ] 9.5 Verify nonce idempotency with an accepted envelope replay.
- [ ] 9.6 Verify the kill switch mid-stream and live authority state.
- [ ] 9.7 Verify exposure bounding with stalled settlement.

## Verification task

- [x] Run `pnpm check` on the current checkout after implementation and resolve all lint, typecheck, test, build, and format failures. _(green 2026-08-20 after the local-EVM work: 31 tasks, 587 tests. `pnpm test:chain` is separate and also green — 14 tests across two forked-chain suites — and is not part of `pnpm check` by design.)_
- [x] Re-run `git status --short` and confirm only intended files are changed. _(2026-08-20: 16 modified, 8 added — all under `apps/api/src/ops/`, `packages/ledger`, `packages/types`, `docs/runbooks/`, and the four docs. No build output, no `.data/`, no stray scratch files.)_
- [x] Update `README.md` and the OpenSpec tasks/specs whenever an item above is implemented or its scope changes. _(2026-08-20: `README.md` gained a "Health, metrics, and the audit trail" section; `packages/ledger/README.md` gained schema-versioning, audit-trail, and backup/recovery sections; `openspec/specs/api-server/spec.md` gained three requirements — readiness, operator observability endpoints, operator settlement retry. Re-check on the next implemented item; this line is standing, not one-shot.)_
