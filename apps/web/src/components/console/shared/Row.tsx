import type { ReactNode } from "react";

export function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd
        className={`mt-1 whitespace-pre-wrap break-all ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
