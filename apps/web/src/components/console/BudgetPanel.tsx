import type { BudgetState } from "@neuro-pay/types";
import { Amount } from "@/components/console/Amount";
import { Row } from "@/components/console/shared";

export function BudgetPanel({
  budget,
  symbol,
}: {
  budget: BudgetState | null;
  symbol: string;
}) {
  if (!budget) {
    return (
      <section className="border p-5" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
          Budget
        </h2>
        <p className="mt-4 text-sm text-[var(--muted)]">
          Budget is derived from the active session.
        </p>
      </section>
    );
  }

  return (
    <section
      className="border p-5"
      style={{
        borderColor: budget.exhausted ? "var(--bad)" : "var(--line)",
        background: budget.exhausted ? "var(--bad-wash)" : undefined,
      }}
    >
      <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
        Budget
      </h2>
      {budget.exhausted ? (
        <p className="mt-3 text-sm" style={{ color: "var(--bad)" }}>
          Local budget exhausted. Further payments will be refused until the
          window rolls.
        </p>
      ) : null}
      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-[var(--muted)]">Remaining local budget</dt>
          <dd className="mt-1">
            <Amount
              amount={budget.localRemaining}
              decimals={budget.tokenDecimals}
              symbol={budget.tokenSymbol || symbol}
            />
            <span className="ml-2 text-[var(--muted)]">
              of{" "}
              <Amount
                amount={budget.localLimit}
                decimals={budget.tokenDecimals}
              />
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Remaining on-chain cap</dt>
          <dd className="mt-1">
            <Amount
              amount={budget.onChainRemaining}
              decimals={budget.tokenDecimals}
              symbol={budget.tokenSymbol || symbol}
            />
            <span className="ml-2 text-[var(--muted)]">
              of{" "}
              <Amount
                amount={budget.onChainCap}
                decimals={budget.tokenDecimals}
              />
            </span>
          </dd>
        </div>
        <Row
          label="Window spend"
          value={
            <Amount
              amount={budget.spent}
              decimals={budget.tokenDecimals}
              symbol={budget.tokenSymbol || symbol}
            />
          }
        />
      </dl>
    </section>
  );
}
