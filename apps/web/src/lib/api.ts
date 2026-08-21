import type {
  AutoRevokeOnFailureView,
  BudgetState,
  ConsoleSnapshot,
  LedgerEntry,
  RevokeResult,
  SessionPolicyView,
  SetAutoRevokeRequest,
  StreamView,
} from "@neuro-pay/types";
import { reviveWire } from "./wire";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Console requests go through the same-origin proxy, not straight to the
 * API.
 *
 * The console is a client component, so anything it sends is sent by the
 * browser. The API's console routes require an operator bearer token,
 * and a token the browser can send is a token in the bundle. The proxy
 * at `/api/console/*` holds it server-side instead. See that route for
 * the full reasoning.
 */
export const CONSOLE_BASE = "/api/console";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${CONSOLE_BASE}${path}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return reviveWire(await response.json()) as T;
}

export async function fetchSession(): Promise<SessionPolicyView> {
  return getJson<SessionPolicyView>("/v1/session");
}

export async function fetchStreams(): Promise<StreamView[]> {
  const body = await getJson<{ streams: StreamView[] }>("/v1/streams");
  return body.streams;
}

export async function fetchPayments(input?: {
  cursor?: string | null;
  limit?: number;
}): Promise<{ payments: LedgerEntry[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (input?.limit !== undefined) params.set("limit", String(input.limit));
  if (input?.cursor) params.set("cursor", input.cursor);
  const query = params.toString();
  const path = query ? `/v1/payments?${query}` : "/v1/payments";
  const body = await getJson<{
    payments: LedgerEntry[];
    nextCursor: string | null;
  }>(path);
  return {
    payments: body.payments,
    nextCursor: body.nextCursor ?? null,
  };
}

export async function fetchBudget(): Promise<BudgetState> {
  return getJson<BudgetState>("/v1/budget");
}

export async function fetchSnapshot(): Promise<{
  snapshot: ConsoleSnapshot;
  nextPaymentCursor: string | null;
}> {
  const [session, streams, page, budget] = await Promise.all([
    fetchSession().catch(() => null),
    fetchStreams().catch(() => []),
    fetchPayments().catch(() => ({ payments: [], nextCursor: null })),
    fetchBudget().catch(() => null),
  ]);
  return {
    snapshot: { session, streams, payments: page.payments, budget },
    nextPaymentCursor: page.nextCursor,
  };
}

export async function revokeSession(): Promise<RevokeResult> {
  const response = await fetch(`${CONSOLE_BASE}/v1/session/revoke`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`revoke failed with ${response.status}`);
  }
  return (await response.json()) as RevokeResult;
}

/**
 * Read the runtime auto-revoke-on-failure state.
 *
 * The console reaches this through the same `/api/console` proxy the
 * rest of the operator routes use. A 404 from the proxy means the
 * watcher is not wired in this deployment; the caller renders a
 * "not configured" state rather than throwing.
 */
export async function fetchAutoRevoke(): Promise<AutoRevokeOnFailureView> {
  const response = await fetch(`${CONSOLE_BASE}/v1/session/auto-revoke`, {
    cache: "no-store",
  });
  if (response.status === 404) {
    throw new Error("auto-revoke watcher is not wired");
  }
  if (!response.ok) {
    throw new Error(
      `auto-revoke fetch failed with ${response.status}`,
    );
  }
  return reviveWire(await response.json()) as AutoRevokeOnFailureView;
}

/**
 * Arm or disarm the auto-revoke safety net. The PUT body is the
 * `SetAutoRevokeRequest` shape; the response is the new state.
 */
export async function setAutoRevoke(
  body: SetAutoRevokeRequest,
): Promise<AutoRevokeOnFailureView> {
  const response = await fetch(`${CONSOLE_BASE}/v1/session/auto-revoke`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 404) {
    throw new Error("auto-revoke watcher is not wired");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `auto-revoke set failed with ${response.status}: ${text}`,
    );
  }
  return reviveWire(await response.json()) as AutoRevokeOnFailureView;
}

export function openConsoleEvents(
  onSnapshot: (snapshot: ConsoleSnapshot) => void,
): () => void {
  // EventSource cannot set headers, so it cannot carry the operator
  // token. Same-origin proxy again.
  const source = new EventSource(`${CONSOLE_BASE}/v1/events`);
  const handle = (event: MessageEvent<string>) => {
    try {
      onSnapshot(reviveWire(JSON.parse(event.data)) as ConsoleSnapshot);
    } catch {
      // ignore malformed frames; the next snapshot will recover
    }
  };
  source.addEventListener("snapshot", handle);
  return () => {
    source.removeEventListener("snapshot", handle);
    source.close();
  };
}
