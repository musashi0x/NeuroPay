import type { SessionPolicyView } from "@neuro-pay/types";
import { Amount } from "@/components/console/Amount";
import {
  Row,
  formatDuration,
  formatPeriod,
  useRemaining,
} from "@/components/console/shared";

export function SessionPanel({
  session,
  symbol,
}: {
  session: SessionPolicyView | null;
  symbol: string;
}) {
  const remaining = useRemaining(session?.expiresAt ?? null);
  if (!session) {
    return (
      <section className="border p-5" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
          Session policy
        </h2>
        <p className="mt-4 text-sm text-[var(--muted)]">
          No active session. Run the provisioning script, then refresh.
        </p>
      </section>
    );
  }

  return (
    <section className="border p-5" style={{ borderColor: "var(--line)" }}>
      <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
        Session policy
      </h2>
      <dl className="mt-4 space-y-3 text-sm">
        <Row label="Wallet" value={session.walletAddress} mono />
        <Row label="Public key" value={session.publicKey} mono />
        <Row label="Status" value={session.status} />
        <Row
          label="Allowed contracts"
          value={
            session.allowedCalls.length === 0
              ? "none"
              : session.allowedCalls
                  .map((call) =>
                    call.selector ? `${call.to} ${call.selector}` : call.to,
                  )
                  .join("\n")
          }
          mono
        />
        <div>
          <dt className="text-[var(--muted)]">Spend cap</dt>
          <dd className="mt-1">
            <Amount
              amount={session.spendCap.limit}
              decimals={session.spendCap.tokenDecimals}
              symbol={session.spendCap.tokenSymbol || symbol}
            />
            <span className="ml-2 text-[var(--muted)]">
              / {formatPeriod(session.spendCap.periodSeconds)}
            </span>
          </dd>
        </div>
        <Row label="Expires" value={session.expiresAt} />
        <Row label="Remaining" value={formatDuration(remaining)} />
      </dl>
    </section>
  );
}
