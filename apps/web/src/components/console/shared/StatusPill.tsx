export type StatusTone = "ok" | "bad" | "warn" | "neutral";

const STYLES: Record<StatusTone, { color: string; background: string }> = {
  ok: { color: "var(--ok)", background: "var(--ok-wash)" },
  bad: { color: "var(--bad)", background: "var(--bad-wash)" },
  warn: { color: "#7a4b00", background: "#f3e6c8" },
  neutral: { color: "var(--ink)", background: "transparent" },
};

export function StatusPill({
  tone,
  label,
}: {
  tone: StatusTone;
  label: string;
}) {
  const styles = STYLES[tone];
  return (
    <span
      className="inline-block border px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase"
      style={{ ...styles, borderColor: "currentColor" }}
    >
      {label}
    </span>
  );
}
