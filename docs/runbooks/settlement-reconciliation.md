# Runbook: settlement reconciliation and operator retry

What to do when a settlement has not confirmed, when the process
restarted mid-flight, or when failed settlements start piling up.

Companion docs: `packages/ledger/README.md` covers ledger backup and
recovery; this one covers the money in flight.

---

## The model in one paragraph

Delivery and settlement are deliberately separate. The seller delivers a
segment, writes an immutable delivery record and a **settlement intent**
to the ledger, and returns 200 — all before any transaction is sent. The
settlement queue then drives the intent through `pending → submitted →
confirmed | failed`. That split is what makes a crash survivable: the
intent is durable, so the work between "we delivered" and "we got paid"
is never only in memory. It is also why reconciliation exists at all —
the queue's in-memory state can be lost, but its intents cannot.

Each in-flight settlement holds one **exposure slot**. Slots are released
on confirmation only. A failed settlement keeps its slot on purpose: the
seller delivered value it has not been paid for, and that is real
exposure until someone resolves it. When every slot is held, delivery
stops. That is the system working, not a bug — see
[Exposure saturated](#exposure-saturated).

---

## Automatic reconciliation at startup

`seller.reconcileSettlements()` runs on every boot, before traffic. It
walks the durable outbox and, per intent status:

| Status on disk                            | What reconciliation does                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pending`                                 | Resubmits. The transaction was never sent, or was sent and lost before the hash was recorded. |
| `submitted`                               | Resumes waiting for the receipt, using the recorded transaction hash.                         |
| `confirmed` / `failed`                    | Leaves alone. Terminal.                                                                       |
| _no intent, but a delivery record exists_ | Reports the nonce as `unknown`.                                                               |

Resumed intents re-acquire their exposure slot, so the ceiling still
means what it meant before the restart.

`unknown` is the one that needs a human. It means the process delivered a
segment and died before writing the intent, so there is a delivery on
record with no settlement attached. Check the boot log for
`settlement outbox reconciliation failed at startup` or the report's
`unknown` list, then decide: if the buyer's authorization is still
within its deadline the payment can be re-demanded on the next segment;
if not, that delivery is unrecoverable and should be written off.

---

## Reading the current state

Everything below is behind the console bearer token
(`CONSOLE_API_TOKEN`). Substitute your own host and token.

```bash
curl -sS -H "Authorization: Bearer $CONSOLE_API_TOKEN" http://localhost:4000/v1/health
```

The health report carries the probe verdicts and every firing alert. For
numbers rather than conclusions:

```bash
curl -sS -H "Authorization: Bearer $CONSOLE_API_TOKEN" http://localhost:4000/v1/metrics
```

The fields that matter here live under `ledger.settlement`:

- `inFlight` — submitted, not yet resolved. Normal in small numbers.
- `failedUnrecovered` — failed or lost with no recovery. **This is
  delivered value that is unpaid.** Any non-zero value is worth a look.
- `latency` — submitted-to-confirmed times. A p95 that has climbed
  usually means the chain is congested or the RPC is slow, not that
  anything is broken.
- `retried` / `recovered` — how much operator recovery has already
  happened.

To find the specific settlements, read the payment ledger and look for
`settlement.failed` or `payment.settlement.lost` entries; the `nonce` on
each is the key everything else is addressed by.

```bash
curl -sS -H "Authorization: Bearer $CONSOLE_API_TOKEN" http://localhost:4000/v1/payments \
  | jq '.payments[] | select(.event | test("settlement\\.(failed|lost)$")) | {nonce, timestamp, classification, detail}'
```

---

## Retrying one settlement

```bash
curl -sS -X POST -H "Authorization: Bearer $CONSOLE_API_TOKEN" \
  http://localhost:4000/v1/settlements/<nonce>/retry
```

This moves the intent back to `pending` and resubmits it with the
buyer's original signed authorization. Responses:

- **200** with a transaction hash — resubmitted. Watch for
  `settlement.confirmed` on that nonce.
- **409** — the retry was attempted and did not go through. The message
  says why. This is the answer to your question, not a server fault.
- **404** — no such intent, or this deployment has no settlement queue
  wired (an in-memory settler has nothing to retry).

Every retry is recorded in the audit trail as
`settlement.retry.requested`, with the request id, whether it succeeded,
and the reason if it did not:

```bash
curl -sS -H "Authorization: Bearer $CONSOLE_API_TOKEN" \
  "http://localhost:4000/v1/audit?action=settlement.retry.requested"
```

### Diagnose before you retry

Retrying blindly wastes gas and tells you nothing new. The
classification on the failure entry says which case you are in:

| Classification                     | What happened                                   | Does a retry help?                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settler-out-of-gas`               | The settler EOA cannot pay for the transaction. | Not until you refill it. See [Settler drained](#settler-drained).                                                                                                                                                                |
| `settlement-reverted`              | The transaction reached the chain and reverted. | Only if the cause was transient. A revert on Permit2 usually means the signature no longer validates — an expired deadline, a nonce already spent, or a permit whose spender is not the settler. None of those improve on retry. |
| _lost_ (`payment.settlement.lost`) | Submitted, but no receipt within the timeout.   | Yes. Check the recorded hash on a block explorer first: if it confirmed, the settlement landed and the ledger simply lost track.                                                                                                 |

A transient submit error (an RPC hiccup) is already retried
automatically with backoff; a terminal out-of-gas or revert is not,
which is why it is sitting in front of you.

---

## Alert playbook

### Failed settlement accumulation

Fires at one unrecovered failure and escalates at five (tune with
`ALERT_FAILED_SETTLEMENTS_WARN` / `ALERT_FAILED_SETTLEMENTS_CRITICAL`).

1. List the failures and their classifications (query above).
2. If they share a classification, fix the shared cause first — one
   drained settler produces many failures, and retrying them
   individually before refilling just burns the attempts.
3. Retry each nonce.
4. Anything that reverts for a non-transient reason is a write-off.
   Record it: the exposure slot stays held until the intent leaves the
   failed state, so a permanent write-off eventually needs a decision,
   not just an acknowledgement.

### Settler drained

The settler EOA pays gas for every `permitWitnessTransferFrom`. Empty, it
fails to submit while verification keeps passing — the seller keeps
delivering and stops getting paid, which is the worst shape this failure
can take.

1. Confirm from `/v1/health`: the `settler-balance` probe reports the
   address and balance.
2. Refill it. The alert floor is `SETTLER_MIN_BALANCE_WEI` (default 0.01
   native token, roughly ten settlements of headroom on BNB testnet).
3. Retry the failed settlements. They are still valid as long as the
   buyer's signed deadline has not passed — which is the real deadline
   on this response, and why the warning threshold sits well above zero.

### Exposure saturated

Every slot is held and the seller is refusing segments with 503 +
`Retry-After`. This is the exposure bound doing its job.

- If the held slots are `inFlight` (submitted, unconfirmed), the chain is
  slow. Slots free themselves as confirmations land; no action needed.
- If they are `failedUnrecovered`, they will not free themselves. Work
  the failures above.
- Raising `MAX_IN_FLIGHT_SETTLEMENTS` raises the ceiling and the maximum
  unrecoverable loss along with it. It is a deliberate risk decision, not
  a fix for a stuck settlement.

---

## After the incident

Reconstruct what was done from the audit trail — it records the
administrative actions, which the payment ledger does not:

```bash
curl -sS -H "Authorization: Bearer $CONSOLE_API_TOKEN" \
  "http://localhost:4000/v1/audit?limit=50" | jq '.events'
```

Every record carries the actor, the outcome, and the HTTP request id,
which ties it back to the access log line with the source and timing.
