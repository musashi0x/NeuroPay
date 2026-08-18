import { formatAmount } from "@/lib/format-amount";

export function Amount({
  amount,
  decimals,
  symbol,
}: {
  amount: bigint;
  decimals: number;
  symbol?: string;
}) {
  const formatted = formatAmount(amount, decimals, symbol);
  return (
    <span className="font-mono tabular-nums">
      <span>{formatted.labelled}</span>
      <span className="ml-2 text-[11px] tracking-wide text-[var(--muted)]">
        {formatted.raw}
      </span>
    </span>
  );
}
