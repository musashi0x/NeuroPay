"use client";

import { Switch, useToast } from "@/components/ui";

/**
 * Local-only preference row. Mutes the corner toast stack without
 * touching the API or any persisted state — the toggle resets on
 * reload, which is the right default for an operator console (a
 * muted state that survives a reload is a muted state that survives
 * a different operator sitting down at the same machine).
 */
export function MuteToastsRow() {
  const { muted, setMuted } = useToast();
  return (
    <section
      className="mt-6 flex flex-wrap items-center justify-between gap-3 border p-4"
      style={{ borderColor: "var(--line)" }}
    >
      <div>
        <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
          Notifications
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Mute the corner toast stack for settlement lifecycle events. Inline
          history is unaffected.
        </p>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <span>{muted ? "Muted" : "On"}</span>
        <Switch
          checked={muted}
          onCheckedChange={setMuted}
          aria-label="Mute settlement notifications"
        />
      </label>
    </section>
  );
}
