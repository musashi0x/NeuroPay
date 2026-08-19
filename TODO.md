# TODO

This file tracks missing, incomplete, and unverified project capabilities. Items are grouped by priority and should be checked off only after implementation and verification.

## P0 — payment correctness and safety

- [x] Replace the accepting-all verifier in `apps/api/src/runtime.ts` with real ERC-1271 verification through the configured Permit2 signature checker. _(commit d0deea — `chain-verifier.ts` wraps `buildPermit2Verifier` with `assertPermit2Deployed`; runtime wires it unconditionally.)_
- [x] Add integration tests proving invalid, expired, revoked, wrong-chain, wrong-token, wrong-recipient, and underpaid envelopes are rejected by the production composition root. _(integration.test.ts covers invalid, expired, revoked, wrong-chain, wrong-token, wrong-recipient. `underpaid` stays in `verify.test.ts`: the seller's demand-derivation uses `witness.amount` when present, so a seller-level underpaid assertion requires changing that logic.)_
- [x] Replace the in-memory settler in `apps/api/src/runtime.ts` with a chain-backed settler that submits `Permit2.permitWitnessTransferFrom`. _(commit d0deea — `chain-settler.ts` drives `permitWitnessTransferFrom` via viem `writeContract`; runtime wires it when `SETTLER_PRIVATE_KEY` + `RPC_URL` are configured.)_
- [x] Record settlement submission, confirmation, revert, timeout, and gasless-settler failures from the real chain path. _(commit d0deea — `recordPaymentSettlement{Submitted,Confirmed,Failed,Lost}` helpers in `packages/ledger/src/events.ts`, wired in `chain-settler.ts`; round-trip covered in `payment-settlement.test.ts`.)_
- [x] Connect confirmed settlement to `recordSettle` so `accruedUnpaid` decreases by the settled amount. _(seller wires `attachSettlementHooks` into `createSettlementQueue`; `onSettlementConfirmed` credits `min(amount, accruedUnpaid)` via `streams.recordSettle`. Covered in `index.test.ts` and `settlement-hooks.test.ts`.)_
- [x] Define and implement failed-settlement accounting, exposure handling, and recovery semantics. _(failed/lost settlements do not credit the meter and do not release the exposure slot; queue records `settlement.failed` and invokes `onFailed`. Automatic retry/outbox recovery remains P1.)_
- [x] Ensure settlement confirmation releases seller exposure; ensure failed settlements remain visible as unrecovered exposure. _(exposure releases only in `onSettlementConfirmed`; failed/lost paths keep the acquired slot. Stalling-settler test proves delivery resumes after confirm; revert test proves the slot stays held.)_
- [x] Wire `fetchWithX402` into a real buyer/agent process that loads a persisted session and signs payments server-side. _(`demo-real-signing.ts` registers `signerSource` from `SESSION_PRIVATE_KEY`, hydrates a live SDK `Session` via `createBuyerPaymentContext`, and calls `fetchWithX402`. Covered by `hydrate.test.ts` / `buyer.test.ts`.)_
- [x] Add a real signed-payment demo separate from `apps/api/scripts/demo-stream.ts`'s synthetic placeholder envelope. _(`pnpm --filter @neuro-pay/api demo:real`. Grant with the same `SESSION_PRIVATE_KEY` so the buyer process can reattach the signer the store never persists.)_

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

- [ ] Wire on-chain revoke into a secured API/operator service rather than returning only the local revoke result.
- [ ] Verify live authority state after revoke and report authorized, expired, and revoked states from chain reads.
- [ ] Add integration coverage for local revoke, on-chain revoke success, on-chain revoke failure, and retry.
- [ ] Run the complete funded BNB testnet provisioning flow and record wallet-funding, grant, rail-provisioning, and revoke transaction hashes.
- [ ] Verify the documented doubled first-admin-action fee behavior on a fresh wallet.

## P1 — end-to-end verification

- [ ] Run the full chain-97 loop: open stream, accrue, receive 402, sign, verify, deliver, submit settlement, confirm settlement, and reconcile the ledger.
- [ ] Verify the threshold path independently.
- [ ] Verify the tick path independently with traffic below the threshold.
- [ ] Verify over-budget refusal before signing.
- [ ] Verify demanded-versus-expected tolerance refusal before signing.
- [ ] Verify expired-session refusal before signing.
- [ ] Verify revoked-session refusal before signing.
- [ ] Verify idempotency by replaying an accepted envelope and comparing the exact response and unchanged accrual.
- [ ] Verify kill switch behavior mid-stream, including immediate local signing stop and confirmed on-chain revocation.
- [ ] Verify exposure bounding by stalling settlement, reaching the configured limit, and confirming delivery resumes after settlement clears.
- [ ] Add a repeatable local EVM integration environment for ERC-1271, Permit2, token decimals, settlement, and revoke.

## P1 — security and access control

- [ ] Add authentication and authorization for console APIs.
- [ ] Protect the revoke endpoint with explicit operator authorization and audit logging.
- [ ] Confirm no endpoint, log, ledger row, browser bundle, or error response exposes private/admin/session key material.
- [ ] Add rate limiting and abuse controls for stream creation and segment requests.
- [ ] Add limits and cleanup for abandoned clients and excessive concurrent streams.
- [ ] Review CORS and deployment defaults for non-local environments; keep the allowlist explicit and never default to `*`.

## P2 — observability and operations

- [ ] Add metrics for payment verification, settlement latency, settlement failures, gasless settler state, exposure saturation, budget exhaustion, and session expiry/revocation.
- [ ] Add alerts or operator-visible health status for failed settlement accumulation and a drained settler account.
- [ ] Add readiness/health checks for RPC connectivity, token decimals, Permit2 deployment, settler balance, ledger availability, and session authority.
- [ ] Add ledger schema versioning and migrations.
- [ ] Document ledger backup, restore, corruption recovery, and retention procedures.
- [ ] Document settlement reconciliation and operator retry procedures.
- [ ] Add structured audit events for revoke, provisioning, configuration changes, and administrative actions.

## P2 — product and API completeness

- [ ] Resolve the USDC/USDT naming inconsistency between product copy and BNB testnet configuration.
- [ ] Validate token address, symbol, and decimals together at startup, not decimals alone.
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

- [ ] Run `pnpm check` on the current checkout after implementation and resolve all lint, typecheck, test, build, and format failures.
- [ ] Re-run `git status --short` and confirm only intended files are changed.
- [ ] Update `README.md` and the OpenSpec tasks/specs whenever an item above is implemented or its scope changes.
