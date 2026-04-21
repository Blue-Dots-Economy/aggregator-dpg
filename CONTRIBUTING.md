# Contributing

## Prerequisites

- **Node.js** ≥ 20 (use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schickling/fnm))
- **pnpm** ≥ 10 — install via `npm i -g pnpm` or `corepack enable pnpm`

## Setup

```bash
pnpm install
```

This installs all workspace dependencies across `apps/*`, `services/*`, and `packages/*`.

## Common commands

| Command | What it does |
|---------|-------------|
| `pnpm -w build` | Build all packages (topological order, cached) |
| `pnpm -w test` | Run all tests |
| `pnpm -w lint` | Lint all packages |
| `pnpm -w typecheck` | Type-check all packages |
| `pnpm -w dev` | Start all packages in dev/watch mode |
| `pnpm --filter <name> <cmd>` | Run a command in one package only |

## Workspace layout

```
apps/       application entrypoints (api, web)
services/   standalone services (signal-processing)
packages/   shared libraries consumed by apps and services
```

Package names use the `@aggregator-dpg/` scope.

## Adding a new package

1. Create `packages/<name>/package.json` with `"name": "@aggregator-dpg/<name>"`.
2. Add `build`, `test`, `lint`, `typecheck` scripts.
3. Run `pnpm install` — turbo picks it up automatically.
4. No changes needed to root config.

## Commit style

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

```
feat(scope): short imperative description
fix(scope): short imperative description
chore(scope): ...
```

Task commits must include the sub-issue number:

```
#189 feat(T-01.1.1): init pnpm and pnpm-workspace.yaml
```

Do **not** bypass pre-commit hooks with `--no-verify`.
