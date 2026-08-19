# TODO

This file tracks missing, incomplete, and unverified project capabilities. Items are grouped by priority and should be checked off only after implementation and verification.

## P0 — signed-payment wire format & settlement plumbing (discovered 2026-08-19)

Discovered by running the real signed-payment path against a funded BNB testnet wallet for the first time (provisioning succeeded — grant `0x4b1277ecd3aad93a8d3373fbe230d673f54d9372bddc9abecdb318cb37cd0922`, approve-token `0x9d9c9973f51e7be5f3d5df599e058cb7b8c9f0531c533d64d376ce412e2bf579`, approve-checker `0x5954682cb60f85966b6188824c9ab5ad8742fdf7b755de468204947bc7ac85f7`, all confirmed on-chain). Every payment attempt after that failed. The seller-side envelope parser and verifier, and the buyer-side encoder, were each unit-tested only against their own synthetic fixtures and never cross-checked against the other side or against `@altananetwork/sdk`'s actual output — none of it has ever round-tripped for real. This invalidates the functional (not structural) claims behind P0 items 1–3 and 9 below: the wiring described there is real, but the data flowing through it is not what the real protocol produces or needs.

- [x] Header dedup: `extractEnvelope` (`apps/api/src/seller/envelope.ts`) treated the buyer's compliant dual `X-PAYMENT` + `PAYMENT-SIGNATURE` headers (same payload, sent for facilitator compatibility — see the module's own docstring) as ambiguous and rejected them. Fixed to only flag `"multiple"` when the two headers actually disagree; `envelope.test.ts` updated and green. _(commit — see `apps/api/src/seller/envelope.ts` / `envelope.test.ts`.)_
- [ ] Envelope shape mismatch: the buyer's encoder (`packages/altana/src/payment/encode.ts`) nests `from`/`permit`/`permit2Authorization` under `payload.*`; the seller's parser (`apps/api/src/seller/envelope.ts` `parseEnvelope`, ~line 190) reads them at the envelope's top level. Every real envelope fails with `missing-from`.
- [ ] Encoder data loss: `encodeB402Envelope` (`packages/altana/src/payment/encode.ts` ~line 117) _replaces_ the SDK's `permit`/`permit2Authorization` objects with a bare `{from, signature}` instead of merging into them, discarding `permitted` (token/amount), `spender`, `nonce`, `deadline`, `witness` — data settlement needs downstream.
- [ ] Hash never transmitted: the seller trusts a wire-supplied `permit.hash` for the ERC-1271 check (`apps/api/src/seller/verify.ts` ~line 172). The real SDK never sends one (`signX402Payment` in `@altananetwork/sdk`'s `x402.js` returns only `signature` + the Permit2 struct). The seller must recompute the EIP-712 digest itself — the SDK exports `buildPermit2WitnessTypedData` for exactly this, currently unused by this project.
- [ ] Witness field shape: `readPermit2WitnessFields` (`apps/api/src/seller/envelope.ts` ~line 259) expects `{payTo, amount, token, chainId}` on one object. The real wire has `amount`/`token` under `permit.permitted`, `payTo` as `witness.to`, and `chainId` is never transmitted at all (it's implicit in the EIP-712 domain the signature covers, not a checkable field) — `wrong-chain` rejection needs to move from a local field comparison to relying on the recomputed-digest/signature mismatch.
- [ ] Wrong spender bound into the signature: `toSdkRequirement` (`packages/altana/src/payment/sign.ts` ~line 176) sets `extra.spenderAddress: requirement.payTo`. Permit2 requires the signed `spender` to equal `msg.sender` of whoever calls `permitWitnessTransferFrom` — that's the **settler EOA** (`SETTLER_PRIVATE_KEY`'s address), a third address distinct from `payTo`. The seller doesn't even echo a settler address in the 402's `extra` field today (`apps/api/src/seller/requirements.ts` `requirementsFor`, ~line 773, sets no `extra` at all).
- [ ] Settlement submission uses fabricated values, not the real signed data: `chain-settler.ts` `submitSettle` (~line 145–170) hardcodes `signature: "0x"` (empty — the buyer's real signature is never threaded through), fabricates `witness` from the nonce (`witnessPlaceholderHash`, ~line 397) instead of hashing the real witness struct, and `witnessTypeStringFor` (~line 392) returns a malformed, non-EIP-712 type string instead of the real proxy's `Witness(address to,uint256 validAfter)`. Permit2 recomputes the digest from these exact arguments and checks it against `signature` on-chain — with all three fabricated, **every real settlement reverts unconditionally**. `SettlementInput` (`apps/api/src/seller/settle.ts`) needs to carry the real signature/witness/permit struct from `verify.ts` through the settlement queue into the chain settler.
- [ ] Needs an ISA/plan before more code changes: this is a coordinated rewrite across `packages/altana` (encoder, spender wiring) and `apps/api` (envelope parser, witness reader, digest recomputation, settlement plumbing), not an isolated patch. Scaffold one before resuming.

## P0 — payment correctness and safety

- [x] Replace the accepting-all verifier in `apps/api/src/runtime.ts` with real ERC-1271 verification through the configured Permit2 signature checker. _(commit d0deea — `chain-verifier.ts` wraps `buildPermit2Verifier` with `assertPermit2Deployed`; runtime wires it unconditionally.)_ ⚠ Wiring is real; the `hash` it's called with is not — see "P0 — signed-payment wire format" above.
- [x] Add integration tests proving invalid, expired, revoked, wrong-chain, wrong-token, wrong-recipient, and underpaid envelopes are rejected by the production composition root. _(integration.test.ts covers invalid, expired, revoked, wrong-chain, wrong-token, wrong-recipient. `underpaid` stays in `verify.test.ts`: the seller's demand-derivation uses `witness.amount` when present, so a seller-level underpaid assertion requires changing that logic.)_ ⚠ These fixtures use the seller's assumed envelope shape, never cross-checked against `@altananetwork/sdk`'s real output — see "P0 — signed-payment wire format" above.
- [x] Replace the in-memory settler in `apps/api/src/runtime.ts` with a chain-backed settler that submits `Permit2.permitWitnessTransferFrom`. _(commit d0deea — `chain-settler.ts` drives `permitWitnessTransferFrom` via viem `writeContract`; runtime wires it when `SETTLER_PRIVATE_KEY` + `RPC_URL` are configured.)_ ⚠ The call is wired but its `signature`/`witness`/`witnessTypeString` arguments are placeholders that would revert every real settlement — see "P0 — signed-payment wire format" above.
- [x] Record settlement submission, confirmation, revert, timeout, and gasless-settler failures from the real chain path. _(commit d0deea — `recordPaymentSettlement{Submitted,Confirmed,Failed,Lost}` helpers in `packages/ledger/src/events.ts`, wired in `chain-settler.ts`; round-trip covered in `payment-settlement.test.ts`.)_
- [x] Connect confirmed settlement to `recordSettle` so `accruedUnpaid` decreases by the settled amount. _(seller wires `attachSettlementHooks` into `createSettlementQueue`; `onSettlementConfirmed` credits `min(amount, accruedUnpaid)` via `streams.recordSettle`. Covered in `index.test.ts` and `settlement-hooks.test.ts`.)_
- [x] Define and implement failed-settlement accounting, exposure handling, and recovery semantics. _(failed/lost settlements do not credit the meter and do not release the exposure slot; queue records `settlement.failed` and invokes `onFailed`. Automatic retry/outbox recovery remains P1.)_
- [x] Ensure settlement confirmation releases seller exposure; ensure failed settlements remain visible as unrecovered exposure. _(exposure releases only in `onSettlementConfirmed`; failed/lost paths keep the acquired slot. Stalling-settler test proves delivery resumes after confirm; revert test proves the slot stays held.)_
- [x] Wire `fetchWithX402` into a real buyer/agent process that loads a persisted session and signs payments server-side. _(`demo-real-signing.ts` registers `signerSource` from `SESSION_PRIVATE_KEY`, hydrates a live SDK `Session` via `createBuyerPaymentContext`, and calls `fetchWithX402`. Covered by `hydrate.test.ts` / `buyer.test.ts`.)_
- [ ] Add a real signed-payment demo separate from `apps/api/scripts/demo-stream.ts`'s synthetic placeholder envelope. _(`pnpm --filter @neuro-pay/api demo:real` exists and reattaches a real signer, but the payment it sends is rejected end-to-end — see "P0 — signed-payment wire format" above. Reopened 2026-08-19: this has never actually completed a real payment.)_

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
- [ ] Run the complete funded BNB testnet provisioning flow and record wallet-funding, grant, rail-provisioning, and revoke transaction hashes. _(Partial, 2026-08-19: wallet `0x65da8DB91431B54d437883eB70F9a13Ea3722C24` funded, grant `0x4b1277ecd3aad93a8d3373fbe230d673f54d9372bddc9abecdb318cb37cd0922`, approve-token `0x9d9c9973f51e7be5f3d5df599e058cb7b8c9f0531c533d64d376ce412e2bf579`, approve-checker `0x5954682cb60f85966b6188824c9ab5ad8742fdf7b755de468204947bc7ac85f7` — all confirmed. Revoke not yet run against this wallet; paused to scope the payment-pipeline findings above first.)_
- [ ] Verify the documented doubled first-admin-action fee behavior on a fresh wallet. _(Suggestive evidence, 2026-08-19: the grant transaction above used 968,320 gas versus ~120,000–130,000 gas for each single-purpose approve transaction that followed — consistent with `initialRegisterKey` riding along, but not a rigorous 1x-vs-2x comparison.)_

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
