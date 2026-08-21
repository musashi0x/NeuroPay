import type { StreamView } from "@neuro-pay/types";
import { Amount } from "@/components/console/Amount";
import { Row, StatusPill, type StatusTone } from "@/components/console/shared";

function streamTone(status: StreamView["status"]): StatusTone {
  if (status === "active") return "ok";
  if (status === "abandoned") return "warn";
  return "bad";
}

function streamLabel(stream: StreamView): string {
  if (stream.status === "active") return "active";
  if (stream.status === "abandoned") return "abandoned";
  return `ended · ${stream.endReason ?? "unknown"}`;
}

export function StreamPanel({
  streams,
  symbol,
}: {
  streams: StreamView[];
  symbol: string;
}) {
  return (
    <section className="mt-6 border p-5" style={{ borderColor: "var(--line)" }}>
      <h2 className="text-sm tracking-[0.2em] uppercase text-[var(--muted)]">
        Streams
      </h2>
      {streams.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">No streams yet.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {streams.map((stream) => (
            <li
              key={stream.streamId}
              className="border p-4"
              style={{ borderColor: "var(--line)" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-sm">{stream.streamId}</p>
                <StatusPill
                  tone={streamTone(stream.status)}
                  label={streamLabel(stream)}
                />
              </div>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--muted)]">Pinned prices</dt>
                  <dd className="mt-1 space-y-1">
                    <div>
                      per call{" "}
                      <Amount
                        amount={stream.priceSheet.perCall}
                        decimals={stream.priceSheet.tokenDecimals}
                        symbol={stream.tokenSymbol || symbol}
                      />
                    </div>
                    <div>
                      per second{" "}
                      <Amount
                        amount={stream.priceSheet.perSecond}
                        decimals={stream.priceSheet.tokenDecimals}
                        symbol={stream.tokenSymbol || symbol}
                      />
                    </div>
                    <div>
                      per {stream.priceSheet.unitName}{" "}
                      <Amount
                        amount={stream.priceSheet.perUnit}
                        decimals={stream.priceSheet.tokenDecimals}
                        symbol={stream.tokenSymbol || symbol}
                      />
                    </div>
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--muted)]">Accrued unpaid</dt>
                  <dd className="mt-1">
                    <Amount
                      amount={stream.accruedUnpaid}
                      decimals={stream.priceSheet.tokenDecimals}
                      symbol={stream.tokenSymbol || symbol}
                    />
                  </dd>
                </div>
                <Row
                  label="Consumed"
                  value={`${stream.deliveredSeconds}s · ${stream.deliveredUnits} ${stream.priceSheet.unitName}s · ${stream.deliveredCalls} calls`}
                />
                <Row
                  label="Next tick"
                  value={
                    stream.status === "active"
                      ? `${stream.secondsUntilNextTick}s`
                      : "—"
                  }
                />
                <Row
                  label="In-flight settlements"
                  value={String(stream.inFlightSettlements)}
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
