import type { RevokeResult } from "@neuro-pay/types";
import { Row } from "@/components/console/shared";

export function RevokeSwitch({
  confirming,
  phrase,
  revoking,
  result,
  onBegin,
  onCancel,
  onPhrase,
  onConfirm,
  onRetry,
}: {
  confirming: boolean;
  phrase: string;
  revoking: boolean;
  result: RevokeResult | null;
  onBegin: () => void;
  onCancel: () => void;
  onPhrase: (value: string) => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  return (
    <section
      className="mt-6 border p-5"
      style={{ borderColor: "var(--bad)", background: "var(--bad-wash)" }}
    >
      <h2
        className="text-sm tracking-[0.2em] uppercase"
        style={{ color: "var(--bad)" }}
      >
        Kill switch
      </h2>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Local revoke stops signing immediately. On-chain revoke is the provable
        stage and can take a block. They are reported separately.
      </p>

      {result ? (
        <dl className="mt-4 space-y-2 text-sm">
          <Row
            label="Local"
            value={result.local.revoked ? "signing stopped" : "still loaded"}
          />
          <Row
            label="On-chain"
            value={
              result.onChain.revoked
                ? `revoked${result.onChain.transactionHash ? ` · ${result.onChain.transactionHash}` : ""}`
                : `not revoked${result.onChain.status ? ` · ${result.onChain.status}` : ""}`
            }
          />
        </dl>
      ) : null}

      {!confirming ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            className="border px-4 py-2 text-sm font-medium"
            style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
            onClick={onBegin}
          >
            Revoke session
          </button>
          {result && !result.onChain.revoked ? (
            <button
              type="button"
              className="border px-4 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
              onClick={onRetry}
            >
              Retry on-chain revoke
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-sm">
            Type <span className="font-mono">REVOKE</span> to confirm. This
            cannot be undone from the console.
          </p>
          <input
            value={phrase}
            onChange={(event) => onPhrase(event.target.value)}
            className="w-full max-w-xs border bg-transparent px-3 py-2 font-mono text-sm"
            style={{ borderColor: "var(--line)" }}
            autoComplete="off"
          />
          <div className="flex gap-3">
            <button
              type="button"
              disabled={phrase !== "REVOKE" || revoking}
              className="border px-4 py-2 text-sm font-medium disabled:opacity-40"
              style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
              onClick={onConfirm}
            >
              {revoking ? "Revoking…" : "Confirm revoke"}
            </button>
            <button
              type="button"
              className="border px-4 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
