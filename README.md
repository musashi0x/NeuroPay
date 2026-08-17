# neuro-pay

pnpm + Turborepo workspace for the neuro-pay web app and API.

## Prerequisites

- Node.js 22 or newer (see `.nvmrc`)
- [pnpm](https://pnpm.io) 10 (`corepack enable` then `corepack prepare pnpm@10.34.5 --activate`)

## Setup

```bash
pnpm install
```

Copy each app's `.env.example` to `.env` if you need to override defaults.

## Scripts

Run these from the repository root:

| Command          | What it does                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`       | Open the Turborepo TUI and start `@neuro-pay/web` on [http://localhost:3000](http://localhost:3000) and `@neuro-pay/api` on [http://localhost:4000](http://localhost:4000) |
| `pnpm build`     | Production build of every package                                                                                                                                          |
| `pnpm lint`      | ESLint across the workspace                                                                                                                                                |
| `pnpm typecheck` | TypeScript `--noEmit` across the workspace                                                                                                                                 |
| `pnpm test`      | Vitest across packages that ship tests                                                                                                                                     |
| `pnpm check`     | Lint, typecheck, test, build, and format check (local CI gate)                                                                                                             |
| `pnpm format`    | Prettier write across the workspace                                                                                                                                        |

Turbo scripts use the interactive TUI. Switch task logs with the arrow keys; quit with `q` or `Ctrl+C`. Non-interactive terminals fall back to streamed logs (`TURBO_UI=false` or `--ui stream` forces that).

Filter a single package:

```bash
pnpm --filter @neuro-pay/web dev
pnpm --filter @neuro-pay/api dev
```

## CI

GitHub Actions runs on every push to `main` and every pull request. One job installs once, then checks each app and formatting:

| Step     | What it runs                                                  |
| -------- | ------------------------------------------------------------- |
| Frontend | `turbo run lint typecheck test build --filter=@neuro-pay/web` |
| Backend  | `turbo run lint typecheck test build --filter=@neuro-pay/api` |
| Format   | `prettier --check .`                                          |

Turbo still builds workspace dependencies such as `@neuro-pay/types` via `^build`. Locally, `pnpm check` is the same quality gate (whole workspace + format).

## Layout

```
apps/web             Next.js App Router frontend
apps/api             Hono TypeScript HTTP API
packages/logger      Shared pino logger (structured JSON in prod, pretty in dev)
packages/tsconfig    Shared TypeScript configs
packages/eslint-config
packages/types       Shared public types (HealthResponse, …)
```

## Logging & observability

The API uses [`pino`](https://getpino.io) via the shared `@neuro-pay/logger` package.

- **Format**: JSON in production (`NODE_ENV=production`), pretty-printed in development.
- **Level**: `LOG_LEVEL` (default: `info` in prod, `debug` in dev).
- **Per-request id**: every request gets an `x-request-id` header (inherited from the upstream if present, otherwise a v4 UUID). The id is echoed back on the response and attached to every log line for that request.
- **Request log**: one structured line per request with `method`, `path`, `status`, `durationMs`, and `requestId`.
- **Errors**: every thrown error is logged with the stack and returns a structured JSON error body that includes the `requestId` so support can correlate user reports with server logs.
- **Redaction**: `authorization`, `cookie`, `set-cookie`, `password`, `token`, and `secret` fields are redacted from log output.

To watch the API logs in dev:

```bash
pnpm --filter @neuro-pay/api dev
```

To override the log level:

```bash
LOG_LEVEL=debug pnpm --filter @neuro-pay/api dev
```
