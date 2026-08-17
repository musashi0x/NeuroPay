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

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start `@neuro-pay/web` on [http://localhost:3000](http://localhost:3000) and `@neuro-pay/api` on [http://localhost:4000](http://localhost:4000) |
| `pnpm build` | Production build of every package |
| `pnpm lint` | ESLint across the workspace |
| `pnpm typecheck` | TypeScript `--noEmit` across the workspace |
| `pnpm test` | Vitest across packages that ship tests |
| `pnpm format` | Prettier write across the workspace |

Filter a single package:

```bash
pnpm --filter @neuro-pay/web dev
pnpm --filter @neuro-pay/api dev
```

## Layout

```
apps/web             Next.js App Router frontend
apps/api             Hono TypeScript HTTP API
packages/tsconfig    Shared TypeScript configs
packages/eslint-config
packages/types       Shared public types (HealthResponse, …)
```
