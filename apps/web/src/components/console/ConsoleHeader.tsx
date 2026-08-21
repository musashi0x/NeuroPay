export function ConsoleHeader({ error }: { error: string | null }) {
  return (
    <header
      className="flex flex-wrap items-end justify-between gap-4 border-b pb-6"
      style={{ borderColor: "var(--line)" }}
    >
      <div>
        <p className="text-xs tracking-[0.28em] text-[var(--muted)] uppercase">
          neuro-pay · stream console
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Settlement blotter
        </h1>
        <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
          Live spend against the session a human approved. Signing stays on the
          API. This page never sees a private key.
        </p>
      </div>
      {error ? (
        <p
          className="border px-3 py-2 text-sm"
          style={{
            borderColor: "var(--bad)",
            background: "var(--bad-wash)",
            color: "var(--bad)",
          }}
        >
          {error}
        </p>
      ) : null}
    </header>
  );
}
