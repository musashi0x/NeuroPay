"use client";

import { useEffect, useState } from "react";
import type { AutoRevokeOnFailureView } from "@neuro-pay/types";
import { fetchAutoRevoke, setAutoRevoke } from "@/lib/api";
import { Switch, useToast } from "@/components/ui";

/**
 * Renders the runtime auto-revoke-on-failure state as a labelled Switch.
 *
 * Reads the current state from `GET /v1/session/auto-revoke` on mount
 * and after every flip. On a flip, the PUT optimistically updates the
 * local state and rolls back on failure — the next render then reflects
 * the server's view.
 *
 * `lastFiredAt` is shown as a relative time so the operator can tell
 * at a glance whether the safety net has actually fired since arming.
 */
export function AutoRevokeSwitch() {
  const { push } = useToast();
  const [state, setState] = useState<AutoRevokeOnFailureView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAutoRevoke()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "fetch failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onFlip(next: boolean) {
    if (!state) return;
    const before = state;
    setState({ ...state, enabled: next });
    setPending(true);
    setError(null);
    try {
      const updated = await setAutoRevoke({ enabled: next });
      setState(updated);
    } catch (err) {
      // Roll back to the previous state on failure.
      setState(before);
      const message = err instanceof Error ? err.message : "update failed";
      setError(message);
      push({
        title: "Auto-revoke update failed",
        description: message,
        tone: "bad",
      });
    } finally {
      setPending(false);
    }
  }

  if (!state) {
    return (
      <section
        className="mt-6 border p-4"
        style={{ borderColor: "var(--line)" }}
      >
        <p className="text-sm text-[var(--muted)]">
          Auto-revoke is not wired in this deployment.
        </p>
      </section>
    );
  }

  return (
    <section
      className="mt-6 flex flex-wrap items-center justify-between gap-3 border p-4"
      style={{ borderColor: "var(--line)" }}
    >
      <div>
        <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
          Auto-revoke on critical failure
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          When armed, the runtime fires the kill switch automatically if the
          unrecovered-failure count crosses the critical threshold. Process-local;
          resets on restart.
        </p>
        {state.lastFiredAt ? (
          <p className="mt-1 font-mono text-xs text-[var(--muted)]">
            last fired: {state.lastFiredAt}
          </p>
        ) : null}
        {error ? (
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--bad)" }}
          >
            {error}
          </p>
        ) : null}
      </div>
      <label className="flex items-center gap-3 text-sm">
        <span>{state.enabled ? "Armed" : "Not armed"}</span>
        <Switch
          checked={state.enabled}
          disabled={pending}
          onCheckedChange={onFlip}
          aria-label="Auto-revoke on critical failure"
        />
      </label>
    </section>
  );
}
