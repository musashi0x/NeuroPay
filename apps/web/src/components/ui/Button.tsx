import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonTone = "neutral" | "danger";

const TONE_STYLES: Record<ButtonTone, React.CSSProperties> = {
  neutral: { borderColor: "var(--line)", color: "var(--ink)" },
  danger: { borderColor: "var(--bad)", color: "var(--bad)" },
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
};

/**
 * Themed button. Owns the visual rules for the console — every other UI
 * primitive that renders a clickable surface (Dialog, Toast action) routes
 * through this so the paper/ink/bad tokens are the single source of truth.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { tone = "neutral", className, style, disabled, ...rest },
    ref,
  ) {
    const toneStyle = TONE_STYLES[tone];
    return (
      <button
        ref={ref}
        type="button"
        className={`border px-4 py-2 text-sm font-medium disabled:opacity-40 ${
          className ?? ""
        }`}
        style={{ ...toneStyle, ...style }}
        disabled={disabled}
        {...rest}
      />
    );
  },
);
