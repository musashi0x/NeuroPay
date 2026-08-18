import type {
  BudgetState,
  ConsoleSnapshot,
  LedgerEntry,
  RevokeResult,
  SessionPolicyView,
  StreamView,
} from "@neuro-pay/types";
import { reviveWire } from "./wire";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
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

export async function fetchPayments(): Promise<LedgerEntry[]> {
  const body = await getJson<{ payments: LedgerEntry[] }>("/v1/payments");
  return body.payments;
}

export async function fetchBudget(): Promise<BudgetState> {
  return getJson<BudgetState>("/v1/budget");
}

export async function fetchSnapshot(): Promise<ConsoleSnapshot> {
  const [session, streams, payments, budget] = await Promise.all([
    fetchSession().catch(() => null),
    fetchStreams().catch(() => []),
    fetchPayments().catch(() => []),
    fetchBudget().catch(() => null),
  ]);
  return { session, streams, payments, budget };
}

export async function revokeSession(): Promise<RevokeResult> {
  const response = await fetch(`${API_URL}/v1/session/revoke`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`revoke failed with ${response.status}`);
  }
  return (await response.json()) as RevokeResult;
}

export function openConsoleEvents(
  onSnapshot: (snapshot: ConsoleSnapshot) => void,
): () => void {
  const source = new EventSource(`${API_URL}/v1/events`);
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
