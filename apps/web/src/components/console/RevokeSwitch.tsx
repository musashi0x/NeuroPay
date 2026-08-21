"use client";

import { useState } from "react";
import type { RevokeResult } from "@neuro-pay/types";
import { ExplorerLink } from "@/components/console/ExplorerLink";
import { Row } from "@/components/console/shared";
import { explorerUrl } from "@/lib/explorer";
import {
  Button,
  DialogCancelButton,
  DialogContent,
  DialogRoot,
  DialogTrigger,
  TooltipProvider,
} from "@/components/ui";

/**
 * Renders a `result` block when one is available, otherwise nothing.
 * Kept separate so the main component's flow stays linear and the result
 * presentation can be swapped without re-wiring the form.
 */
function RevokeResultBlock({
  result,
  chainId,
}: {
  result: RevokeResult;
  chainId: number;
}) {
  const hash = result.onChain.transactionHash;
  const statusLabel = result.onChain.revoked
    ? "revoked"
    : `not revoked${result.onChain.status ? ` · ${result.onChain.status}` : ""}`;

  return (
    <TooltipProvider delayDuration={150}>
      <dl className="mt-4 space-y-2 text-sm">
        <Row
          label="Local"
          value={result.local.revoked ? "signing stopped" : "still loaded"}
        />
        <Row
          label="On-chain"
          value={
            hash ? (
              <span>
                {statusLabel}
                {" · "}
                <ExplorerLink
                  href={explorerUrl(chainId, "tx", hash)}
                  value={hash}
                />
              </span>
            ) : (
              statusLabel
            )
          }
        />
      </dl>
    </TooltipProvider>
  );
}

export function RevokeSwitch({
  confirming,
  phrase,
  revoking,
  result,
  chainId,
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
  chainId: number;
  onBegin: () => void;
  onCancel: () => void;
  onPhrase: (value: string) => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  // The Radix dialog needs its own open state so that confirming/result
  // transitions still flow through the parent's existing callbacks
  // unchanged. We mirror `confirming` into the dialog open prop so esc and
  // click-outside propagate back through onCancel.
  const [dialogOpen, setDialogOpen] = useState(false);

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

      {result ? <RevokeResultBlock result={result} chainId={chainId} /> : null}

      {!confirming ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <DialogRoot
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (open) onBegin();
              else onCancel();
            }}
          >
            <DialogTrigger asChild>
              <Button tone="danger">Revoke session</Button>
            </DialogTrigger>
            <DialogContent
              title="Revoke session"
              description="This stops signing immediately. On-chain revoke is reported separately and can take a block."
            >
              <p className="text-sm">
                Type <span className="font-mono">REVOKE</span> to confirm. This
                cannot be undone from the console.
              </p>
              <input
                value={phrase}
                onChange={(event) => onPhrase(event.target.value)}
                className="mt-3 w-full max-w-xs border bg-transparent px-3 py-2 font-mono text-sm"
                style={{ borderColor: "var(--line)" }}
                autoComplete="off"
                autoFocus
              />
              <div className="mt-4 flex gap-3">
                <Button
                  tone="danger"
                  disabled={phrase !== "REVOKE" || revoking}
                  onClick={onConfirm}
                >
                  {revoking ? "Revoking…" : "Confirm revoke"}
                </Button>
                <DialogCancelButton>Cancel</DialogCancelButton>
              </div>
            </DialogContent>
          </DialogRoot>
          {result && !result.onChain.revoked ? (
            <Button tone="neutral" onClick={onRetry}>
              Retry on-chain revoke
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
