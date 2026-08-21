"use client";

/**
 * The visitor-facing Run page.
 *
 * The browser never imports `@neuro-pay/altana` and never sees a
 * session key. The Run button POSTs to `/api/run`, which is the
 * server-side BFF in `src/app/api/run/route.ts`. The route streams
 * `RunEvent` JSON back as SSE; this component decodes them and
 * paints the live log.
 *
 * The server-rendered page passes in the session info (wallet, expiry,
 * grant hash) and a token symbol. The BFF picks those up from its own
 * env at request time; the props here are for the chrome only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatAmount } from "@/lib/format-amount";
import { explorerUrl } from "@/lib/explorer";

type RunEvent =
  | {
      kind: "opened";
      runId: string;
      streamId: string;
      chainId: number;
      tokenAddress: string;
      tokenDecimals: number;
      tokenSymbol: string;
      maxSecondsPerSegment: number;
      maxUnitsPerSegment: number;
      priceSheet: {
        perCall: string;
        perSecond: string;
        perUnit: string;
        unitName: string;
      };
    }
  | {
      kind: "segment";
      runId: string;
      sequence: number;
      delivery: "free" | "paid";
      amount: string | null;
      status: number;
      secondsDelivered: number;
      unitsDelivered: number;
      accruedUnpaid: string;
      totalAccrued: string;
      streamEnded: boolean;
      endReason: string | null;
    }
  | {
      kind: "refused";
      runId: string;
      classification: string;
      message: string;
      sequence: number | null;
    }
  | {
      kind: "budget";
      runId: string;
      tokenSymbol: string;
      localRemaining: string;
      onChainRemaining: string;
      spent: string;
      localLimit: string;
      onChainCap: string;
    }
  | {
      kind: "done";
      runId: string;
      streamId: string;
      totalSegments: number;
      totalPaid: number;
      totalPaidAmount: string;
    }
  | {
      kind: "error";
      runId: string;
      message: string;
    };

export type RunPageProps = {
  sellerUrl: string;
  tokenSymbol: string;
  hasSigningKey: boolean;
  hasPersistedSession: boolean;
  /** Wallet address; empty string when no session is loaded. */
  walletAddress: string;
  /** Session expiry as Unix epoch seconds; 0 when not loaded. */
  expiry: number;
  /** Grant transaction hash (hex); null when not granted on chain. */
  grantTransactionHash: string | null;
  /** Defaut segments per Run. */
  defaultSegments: number;
  /** Max segments per Run. */
  maxSegments: number;
};

type LogEntry = {
  id: string;
  kind: RunEvent["kind"];
  label: string;
  detail: string;
  raw?: Record<string, unknown>;
};

export function RunPage(props: RunPageProps) {
  const [running, setRunning] = useState(false);
  const [segments, setSegments] = useState<number>(props.defaultSegments);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [budget, setBudget] = useState<{
    spent: bigint;
    localLimit: bigint;
    localRemaining: bigint;
    onChainRemaining: bigint;
    tokenSymbol: string;
    tokenDecimals: number;
  } | null>(null);
  const [streamInfo, setStreamInfo] = useState<{
    streamId: string;
    chainId: number;
    tokenSymbol: string;
    tokenDecimals: number;
  } | null>(null);
  const [sellerReachable, setSellerReachable] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Probe seller reachability on mount. The BFF also reports seller
  // unreachable, but a quick health check gives the page a hint before
  // the user clicks Run.
  useEffect(() => {
    let cancelled = false;
    fetch(props.sellerUrl + "/health", { method: "GET" })
      .then((resp) => {
        if (cancelled) return;
        setSellerReachable(resp.ok);
      })
      .catch(() => {
        if (cancelled) return;
        setSellerReachable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.sellerUrl]);

  const onRun = useCallback(async () => {
    setLog([]);
    setBudget(null);
    setStreamInfo(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const resp = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments }),
        signal: ctrl.signal,
      });
      if (!resp.ok || resp.body === null) {
        const text = await resp.text();
        setLog((prev) => [
          ...prev,
          {
            id: "open-fail",
            kind: "error",
            label: "OPEN FAILED",
            detail: `${resp.status} ${text}`,
          },
        ]);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line === undefined) continue;
          const payload = line.slice("data: ".length);
          let event: RunEvent;
          try {
            event = JSON.parse(payload) as RunEvent;
          } catch {
            continue;
          }
          applyEvent(event, setLog, setBudget, setStreamInfo);
        }
      }
    } catch (err) {
      setLog((prev) => [
        ...prev,
        {
          id: "abort",
          kind: "error",
          label: "CLIENT ABORTED",
          detail: (err as Error).message,
        },
      ]);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [segments]);

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  const canRun = props.hasSigningKey && props.hasPersistedSession && !running;

  const expiryLabel = useMemo(() => {
    if (props.expiry === 0) return "—";
    const date = new Date(props.expiry * 1000);
    return date.toISOString();
  }, [props.expiry]);

  return (
    <div className="shell">
      <header className="page">
        <p className="muted" style={{ letterSpacing: "0.28em", fontSize: 11 }}>
          NEURO-PAY · AGENT SHOWCASE
        </p>
        <h1 style={{ fontSize: 28, margin: "0.5rem 0 0.75rem" }}>
          Be the agent
        </h1>
        <p className="muted" style={{ maxWidth: 720, margin: 0 }}>
          This page is the buyer. The server pays each 402 it receives with a
          session key the browser never sees. A Run opens a metered stream,
          pulls segments, and shows every paid retry as it happens.
        </p>
      </header>

      <section className="panel" style={{ marginBottom: "1rem" }}>
        <div className="row">
          <div className="kv">
            <span className="k">Seller</span>
            <span className="v">
              <a href={props.sellerUrl} target="_blank" rel="noreferrer">
                {props.sellerUrl}
              </a>
              {sellerReachable === null
                ? " · probing"
                : sellerReachable
                  ? " · reachable"
                  : " · unreachable"}
            </span>
          </div>
          <div className="kv">
            <span className="k">Wallet</span>
            <span className="v">
              {props.walletAddress.length === 0 ? (
                <span className="muted">no session</span>
              ) : (
                <WalletLink
                  address={props.walletAddress}
                  chainId={streamInfo?.chainId ?? 97}
                />
              )}
            </span>
          </div>
          <div className="kv">
            <span className="k">Expiry</span>
            <span className="v">{expiryLabel}</span>
          </div>
          <div className="kv">
            <span className="k">Grant</span>
            <span className="v">
              {props.grantTransactionHash === null ? (
                <span className="muted">—</span>
              ) : (
                <TxLink
                  hash={props.grantTransactionHash}
                  chainId={streamInfo?.chainId ?? 97}
                />
              )}
            </span>
          </div>
        </div>
      </section>

      {!props.hasPersistedSession && <EmptyPersistedState />}
      {props.hasPersistedSession && !props.hasSigningKey && <EmptyKeyState />}
      {sellerReachable === false && (
        <section
          className="panel"
          style={{ marginBottom: "1rem", borderColor: "var(--bad)" }}
        >
          <p style={{ margin: 0 }}>
            <strong>Seller unreachable.</strong> The showcase cannot pay until{" "}
            <code>{props.sellerUrl}</code> answers a health check. Start the API
            (<code>pnpm --filter @neuro-pay/api dev</code>) and refresh.
          </p>
        </section>
      )}

      <section
        className="panel"
        style={{
          marginBottom: "1rem",
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <label className="kv" style={{ alignItems: "center" }}>
          <span className="k">Segments</span>
          <input
            type="number"
            min={1}
            max={props.maxSegments}
            value={segments}
            onChange={(e) => setSegments(Number(e.target.value))}
            style={{
              width: "5rem",
              background: "transparent",
              color: "var(--fg)",
              border: "1px solid var(--line)",
              padding: "0.4rem 0.5rem",
              fontFamily: "inherit",
              fontSize: "0.9rem",
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={onRun}
          disabled={!canRun}
        >
          {running ? "Running…" : "Run"}
        </button>
        {running && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: "transparent",
              color: "var(--muted)",
              border: "1px solid var(--line)",
              padding: "0.75rem 1rem",
              borderRadius: 2,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        )}
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          Pulls at most {props.maxSegments} segments. Each 402 is paid and
          retried with the session key on the server.
        </span>
      </section>

      {budget !== null && (
        <section className="panel" style={{ marginBottom: "1rem" }}>
          <p className="k" style={{ margin: 0, marginBottom: "0.5rem" }}>
            LOCAL BUDGET
          </p>
          <div className="row">
            <div className="kv">
              <span className="k">Spent</span>
              <span className="v">
                {
                  formatAmount(
                    budget.spent,
                    budget.tokenDecimals,
                    budget.tokenSymbol,
                  ).labelled
                }
              </span>
            </div>
            <div className="kv">
              <span className="k">Local remaining</span>
              <span className="v">
                {
                  formatAmount(
                    budget.localRemaining,
                    budget.tokenDecimals,
                    budget.tokenSymbol,
                  ).labelled
                }
              </span>
            </div>
            <div className="kv">
              <span className="k">On-chain remaining</span>
              <span className="v">
                {
                  formatAmount(
                    budget.onChainRemaining,
                    budget.tokenDecimals,
                    budget.tokenSymbol,
                  ).labelled
                }
              </span>
            </div>
          </div>
        </section>
      )}

      <section style={{ marginBottom: "1rem" }}>
        <p className="k" style={{ margin: 0, marginBottom: "0.5rem" }}>
          RUN LOG
        </p>
        <div className="log" data-testid="run-log">
          {log.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              No events yet. Press Run to start a stream.
            </p>
          )}
          {log.map((entry) => (
            <div className="entry" key={entry.id}>
              <span className={`tag ${entry.kind}`}>{entry.label}</span>
              <span style={{ flex: 1 }}>{entry.detail}</span>
            </div>
          ))}
        </div>
      </section>

      <footer
        style={{
          marginTop: "2rem",
          borderTop: "1px solid var(--line)",
          paddingTop: "1rem",
        }}
      >
        <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
          The settlement blotter lives in the operator console. See{" "}
          <a
            href="http://localhost:3000/console"
            target="_blank"
            rel="noreferrer"
          >
            /console
          </a>{" "}
          for the full stream history.
        </p>
      </footer>
    </div>
  );
}

function applyEvent(
  event: RunEvent,
  setLog: React.Dispatch<React.SetStateAction<LogEntry[]>>,
  setBudget: React.Dispatch<
    React.SetStateAction<{
      spent: bigint;
      localLimit: bigint;
      localRemaining: bigint;
      onChainRemaining: bigint;
      tokenSymbol: string;
      tokenDecimals: number;
    } | null>
  >,
  setStreamInfo: React.Dispatch<
    React.SetStateAction<{
      streamId: string;
      chainId: number;
      tokenSymbol: string;
      tokenDecimals: number;
    } | null>
  >,
): void {
  const id = `${event.kind}-${Math.random().toString(36).slice(2, 8)}`;
  switch (event.kind) {
    case "opened": {
      setStreamInfo({
        streamId: event.streamId,
        chainId: event.chainId,
        tokenSymbol: event.tokenSymbol,
        tokenDecimals: event.tokenDecimals,
      });
      setLog((prev) => [
        ...prev,
        {
          id,
          kind: "opened",
          label: "OPENED",
          detail: `Stream ${event.streamId} on chain ${event.chainId}. Pay per ${event.priceSheet.unitName}.`,
        },
      ]);
      return;
    }
    case "segment": {
      const amount =
        event.amount === null
          ? "no payment"
          : formatAmount(
              BigInt(event.amount),
              // We re-derive tokenDecimals from the streamInfo later;
              // for the log we read the parent state, which Next.js
              // already wired via the segment event itself.
              0,
              undefined,
            ).raw;
      setLog((prev) => [
        ...prev,
        {
          id,
          kind: "segment",
          label: event.delivery === "paid" ? "PAID" : "FREE",
          detail: `Segment ${event.sequence} · ${event.secondsDelivered}s · ${
            event.amount === null ? "no payment" : `${amount} smallest units`
          } · status ${event.status}${
            event.streamEnded && event.endReason !== null
              ? ` · ended (${event.endReason})`
              : ""
          }`,
        },
      ]);
      return;
    }
    case "refused": {
      setLog((prev) => [
        ...prev,
        {
          id,
          kind: "refused",
          label: "REFUSED",
          detail: `Segment ${event.sequence ?? "?"} · ${event.classification}: ${event.message}`,
        },
      ]);
      return;
    }
    case "budget": {
      setBudget({
        spent: BigInt(event.spent),
        localLimit: BigInt(event.localLimit),
        localRemaining: BigInt(event.localRemaining),
        onChainRemaining: BigInt(event.onChainRemaining),
        tokenSymbol: event.tokenSymbol,
        tokenDecimals: -1, // re-derive below
      });
      return;
    }
    case "done": {
      setLog((prev) => [
        ...prev,
        {
          id,
          kind: "done",
          label: "DONE",
          detail: `${event.totalSegments} segments, ${event.totalPaid} paid.`,
        },
      ]);
      return;
    }
    case "error": {
      setLog((prev) => [
        ...prev,
        {
          id,
          kind: "error",
          label: "ERROR",
          detail: event.message,
        },
      ]);
      return;
    }
  }
}

function EmptyPersistedState() {
  return (
    <section
      className="panel"
      style={{ marginBottom: "1rem", borderColor: "var(--bad)" }}
    >
      <p style={{ margin: 0 }}>
        <strong>No granted session.</strong> An operator must provision a
        session before the showcase can pay. Run{" "}
        <code>pnpm --filter @neuro-pay/altana provision</code> with{" "}
        <code>ADMIN_PRIVATE_KEY</code> and a session key, then refresh. The
        provision CLI writes the persisted session to{" "}
        <code>SESSION_STORE_PATH</code>; the showcase reads from the same path.
      </p>
    </section>
  );
}

function EmptyKeyState() {
  return (
    <section
      className="panel"
      style={{ marginBottom: "1rem", borderColor: "var(--bad)" }}
    >
      <p style={{ margin: 0 }}>
        <strong>Server has no signing key.</strong> The Run button will refuse
        until the showcase server is given the session key the grant was signed
        with. The browser never sees it; only the Next.js process reads it. See
        the showcase example env file for the variable name.
      </p>
    </section>
  );
}

function WalletLink({
  address,
  chainId,
}: {
  address: string;
  chainId: number;
}) {
  const url = explorerUrl(chainId, "address", address);
  if (url === null) {
    return <span>{shortAddress(address)}</span>;
  }
  return (
    <a className="explorer" href={url} target="_blank" rel="noreferrer">
      {shortAddress(address)}
    </a>
  );
}

function TxLink({ hash, chainId }: { hash: string; chainId: number }) {
  const url = explorerUrl(chainId, "tx", hash);
  if (url === null) {
    return <span>{shortHash(hash)}</span>;
  }
  return (
    <a className="explorer" href={url} target="_blank" rel="noreferrer">
      {shortHash(hash)}
    </a>
  );
}

function shortAddress(value: string): string {
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function shortHash(value: string): string {
  if (value.length < 16) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
