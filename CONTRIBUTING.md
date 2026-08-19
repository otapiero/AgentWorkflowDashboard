# Contributing

## Getting set up

```powershell
npm install
npm run build
powershell -File scripts\install.ps1

cd <the repository you want to drive>
npm run mc -- init
```

## The three principles

Changes are reviewed against these, so they are worth reading in the README
before opening a pull request.

1. **Deterministic scripts over agents.** Worktrees, branches, markers and `gh`
   reads are done by scripts. Agents are reserved for cognition.
2. **The app is a reconciler over durable facts.** The running app is never the
   source of truth. Closing or crashing it must never lose state.
3. **Zero footprint in the project repo.** Nothing is written into the
   repository Mission Control is driving.

## Working on it

```powershell
npm run dev        # Vite dev server + Fastify, live reload
npm test           # the unit suite
npm run test:watch
npm run typecheck
```

The reconciler (`src/orchestrator/reconcile.ts`) is pure and is the main
verification surface — it is tested exhaustively against hand-built facts and
against real recorded `gh` payloads. New behaviour there needs a test.

Tests isolate by pointing `MC_ROOT` and/or `MC_HOME` at a `mkdtempSync`
directory. Never let a test touch the real `~/.mission-control`.

### Path environment variables

| Variable | Overrides |
|---|---|
| `MC_ROOT` | The install root. Shared scripts and the T3 credential live here. |
| `MC_PROJECT` | Which project under `projects/` is active, for one process. |
| `MC_HOME` | The project home outright, bypassing the project lookup. |

### The VS Code companion

```powershell
npm run extension:install-deps
npm run extension:verify        # typecheck, unit tests, perf budgets, build
npm run extension:test-host     # downloads a real VS Code; run by hand
```

CI runs the first three of those but not the performance budgets — they are
wall-clock measurements that swing with machine load and would fail at random
on a shared runner. Run `extension:verify` locally before sending a change that
touches the extension.

## Layout

See the Layout section of the README.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
One logical change per commit.
