# Selective test workflow

- **Status:** Accepted
- **Issue:** [#260](https://github.com/fworks-tech/wormage-demo/issues/260)
- **Date:** 2026-11-25

## Goal

A developer should be able to run the tests that cover the player journey they changed without remembering spec paths or running the full browser suite. CI should catch critical regressions on every pull request while keeping the expensive desktop/mobile matrix on a scheduled or manual path.

## Non-goals

- New test frameworks, dependencies, visual baselines, sharding or browser farms.
- Refactoring game fixtures or the per-page MSW store.
- Making every PR run the full Playwright matrix.

## Decisions

1. Keep Vitest, Playwright and the existing affected-selector approach.
2. Add semantic npm commands for the common local workflows.
3. Let `scripts/affected.mjs` filter unit, infra and browser runs and forward Playwright project/grep options.
4. Over-select rather than hide a regression: `GameView`, API/mock and infra changes must reach online/Lambda coverage.
5. Tag exactly five critical journeys with `@smoke`.
6. Run affected unit/infra checks plus smoke E2E on pull requests. Run the full desktop/mobile matrix nightly and on manual dispatch. The existing `ci:full` label remains an explicit full-run override.
7. Run Playwright in parallel by default with a four-worker cap. `PW_WORKERS=1` restores serial debugging.

## Command contract

| Command | Runs |
| --- | --- |
| `npm test` / `npm run test:unit` | All Vitest unit tests |
| `npm run test:unit:watch` | Vitest watch mode |
| `npm run test:combat` | `tests/combat.spec.ts`, desktop and mobile |
| `npm run test:online` | `tests/online.spec.ts`, desktop and mobile |
| `npm run test:infra` | Lambda tests under `infra/` |
| `npm run test:smoke` | The five `@smoke` journeys, desktop and mobile |
| `npm run test:quick` | Affected Vitest and infra tests; no browser tests |
| `npm run test:affected` | Affected unit, infra and browser tests |
| `npm run test:e2e` | Full Playwright matrix |

`test:quick` uses `--unit-only`; that flag means “no browser tests” and still includes Node-based infra tests when selected.

## Selector contract

`affected.mjs` supports:

- `--unit-only`: skip Playwright, keep selected Vitest and infra tests.
- `--e2e-only`: skip Vitest and infra, run selected Playwright specs.
- `--project=desktop|mobile`: forward a Playwright project filter.
- `--grep=<text>`: forward a Playwright title filter.
- `--dry-run`: print the plan without executing it, even if `--run` is also present.
- Existing `--base`, `--labels`, `--full` and `--run` flags remain valid.

Required mapping changes:

- `src/ui/GameView.tsx` reaches online gameplay specs.
- `src/api/` and `src/mocks/` reach data plus online specs.
- `infra/` reaches `tests/unit/lambdaReplay.test.ts` and `npm --prefix infra test`.
- Unmapped/shared paths and `ci:full` still fall back to the full applicable set.

## Smoke set

Each tagged test runs in both Playwright projects:

1. Online create/join reaches a ready room.
2. An online shot hands the turn to the other human before the timer.
3. Pause freezes the turn timer and resume restarts it.
4. A finished match is registered once and appears in history/ranking.
5. Menu options persist after reload and apply to the active ruleset.

The smoke set is intentionally small. Detailed edge cases stay in the full matrix.

## CI shape

- **Pull request:** typecheck, content validation, affected Vitest, selected infra tests, build, and smoke E2E. `ci:full` upgrades the PR browser job to the complete matrix.
- **Push to `main`:** typecheck, content validation, full Vitest, infra tests and build.
- **Nightly/manual:** full Playwright desktop/mobile matrix with the bounded default worker count.
- Playwright reports and failure artifacts upload from both browser jobs.

## Task list

- [x] Add the local command matrix to `package.json`.
- [x] Extend and unit-test selector flags, run planning, online mappings and infra selection.
- [x] Tag the five existing smoke journeys; extend online create coverage through join.
- [x] Enable bounded parallel Playwright by default with `PW_WORKERS` override.
- [x] Enable PR smoke E2E and add nightly/manual full E2E workflows.
- [x] Document commands, selector flags, smoke policy and serial debugging.
- [x] Point the optional pre-push hook at the affected Node-only command.
- [x] Run focused unit, selector dry-run, smoke and build checks; leave the full Playwright matrix for the scheduled/manual path unless explicitly requested.

## Validation

Completed locally:

- `npm run typecheck`
- `npm test` — 207 tests
- `npm run test:infra` — 59 tests
- `node scripts/affected.mjs --base HEAD --unit-only --run` — Windows end-to-end selector run, 207 unit + 59 infra tests
- `npm run build`
- `node --check scripts/affected.mjs` and `sh -n .githooks/pre-push`
- Workflow YAML parse
- `npm run test:smoke` — 10 tests on desktop/mobile with four workers
- Selector `--dry-run` checks, including `test:quick -- --dry-run`

The full Playwright matrix was not run in this change; it remains on the nightly/manual path until explicitly requested.

## Risks and mitigations

- **Parallel browser load causes timing flakes:** cap workers at four and keep state assertions/predicate waits; use one worker when debugging.
- **A missed mapping hides a regression:** preserve the full fallback and add mapping tests.
- **Smoke becomes the whole suite:** cap the tagged set at the five journeys above.
- **Infra dependencies are not installed by root `npm ci`:** CI installs `infra/` dependencies only when the selector includes infra tests.
