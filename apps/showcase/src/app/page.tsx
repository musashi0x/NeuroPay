/**
 * The server-rendered page.
 *
 * The page is the only place that reads the persisted session on
 * load. The BFF has its own copy, but the page needs the public half
 * to render the wallet / expiry / grant hash before the user clicks
 * Run.
 *
 * The default segments and segment-delay values come from env so an
 * operator can tune a stock run without editing code.
 */
import { RunPage } from "@/components/RunPage";
import { readPersistedSession, hasSigningKey } from "@/lib/session-read";

const DEFAULT_SELLER_URL = "http://localhost:4000";
const DEFAULT_DEFAULT_SEGMENTS = 8;
const DEFAULT_TOKEN_SYMBOL = "npUSD";
const DEFAULT_MAX_SEGMENTS = 20;

export const dynamic = "force-dynamic";

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export default function HomePage() {
  const sellerUrl = process.env.SELLER_URL?.trim() || DEFAULT_SELLER_URL;
  const tokenSymbol =
    process.env.SHOWCASE_TOKEN_SYMBOL?.trim() || DEFAULT_TOKEN_SYMBOL;
  const defaultSegments = readIntEnv(
    "DEFAULT_SEGMENTS",
    DEFAULT_DEFAULT_SEGMENTS,
  );
  const maxSegments = readIntEnv("MAX_SEGMENTS", DEFAULT_MAX_SEGMENTS);

  const sessionStorePath = process.env.SESSION_STORE_PATH?.trim() || "";
  const persisted =
    sessionStorePath.length > 0 ? readPersistedSession(sessionStorePath) : null;
  const key = hasSigningKey();

  // The page passes the configured token symbol through. The chain
  // config (see apps/api example file) is the source of the symbol; the
  // showcase only re-labels display values.

  return (
    <RunPage
      sellerUrl={sellerUrl}
      tokenSymbol={tokenSymbol}
      hasSigningKey={key}
      hasPersistedSession={persisted !== null}
      walletAddress={persisted?.walletAddress ?? ""}
      expiry={persisted?.expiry ?? 0}
      grantTransactionHash={persisted?.grantTransactionHash ?? null}
      defaultSegments={defaultSegments}
      maxSegments={maxSegments}
    />
  );
}
