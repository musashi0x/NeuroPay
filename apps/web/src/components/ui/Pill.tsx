import type { CSSProperties, ReactNode } from "react";

export type PillTone = "ok" | "bad" | "warn" | "neutral";

const TONE_STYLES: Record<PillTone, CSSProperties> = {
  ok: { color: "var(--ok)", background: "var(--ok-wash)" },
  bad: { color: "var(--bad)", background: "var(--bad-wash)" },
  warn: { color: "#7a4b00", background: "#f3e6c8" },
  neutral: { color: "var(--ink)", background: "transparent" },
};

/**
 * Themed status pill. Token-driven (ok/bad/warn/neutral) over the paper
 * palette defined in globals.css. Lives in ui/ rather than console/ so
 * future surfaces (alerts, banners, command palette results) can reuse it
 * without dragging in console-specific imports.
 */
export function Pill({
  tone,
  children,
}: {
  tone: PillTone;
  children: ReactNode;
}) {
  const toneStyle = TONE_STYLES[tone];
  return (
    <span
      className="inline-block border px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase"
      style={{ ...toneStyle, borderColor: "currentColor" }}
    >
      {children}
    </span>
  );
}
