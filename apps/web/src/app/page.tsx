import type { HealthResponse } from "@neuro-pay/types";

export const dynamic = "force-dynamic";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function getHealth(): Promise<
  { ok: true; data: HealthResponse } | { ok: false }
> {
  try {
    const response = await fetch(`${API_URL}/health`, { cache: "no-store" });

    if (!response.ok) {
      return { ok: false };
    }

    const data = (await response.json()) as HealthResponse;

    if (
      data.status !== "ok" ||
      data.service !== "api" ||
      typeof data.timestamp !== "string"
    ) {
      return { ok: false };
    }

    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

export default async function HomePage() {
  const health = await getHealth();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <p className="text-sm tracking-[0.2em] text-[var(--muted)] uppercase">
        neuro-pay
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">
        Workspace is up
      </h1>
      <p className="mt-3 text-[var(--muted)]">
        Next.js on :3000 talking to the TypeScript API on :4000.
      </p>

      <section
        className="mt-10 border px-5 py-4"
        style={{
          borderColor: "var(--line)",
          background: health.ok ? "var(--ok-wash)" : "var(--bad-wash)",
        }}
      >
        <p
          className="text-sm font-medium"
          style={{ color: health.ok ? "var(--ok)" : "var(--bad)" }}
        >
          {health.ok ? "API healthy" : "API unavailable"}
        </p>
        {health.ok ? (
          <p className="mt-2 font-mono text-sm text-[var(--muted)]">
            {health.data.service} · {health.data.timestamp}
          </p>
        ) : (
          <p className="mt-2 text-sm text-[var(--muted)]">
            Could not reach {API_URL}/health. Start the API and refresh.
          </p>
        )}
      </section>
    </main>
  );
}
