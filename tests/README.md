# tests — Playwright and Vitest

## Run

| Goal | Command |
| --- | --- |
| All unit tests | `npm test` / `npm run test:unit` |
| Watch units while editing | `npm run test:unit:watch` |
| Combat journey | `npm run test:combat` |
| Online journey | `npm run test:online` |
| Lambda/infra tests | `npm run test:infra` |
| Critical PR smoke | `npm run test:smoke` |
| Affected Node tests only | `npm run test:quick` |
| Affected unit, infra and browser tests | `npm run test:affected` |
| Full browser matrix | `npm run test:e2e` |

```bash
npx playwright test --project=desktop
npx playwright test tests/combat.spec.ts -g "firing"
PW_WORKERS=1 npm run test:online   # serial debugging
npx playwright show-report         # HTML report
```

Vitest only picks up `tests/unit/**/*.test.ts`. The Playwright config uses `channel: 'chrome'` so no browser download is required, and starts/reuses the Vite dev server on `http://localhost:5173`.

Run `npm --prefix infra ci` once after cloning so `test:quick` and `test:infra` can use the Lambda dependencies.

Playwright runs in parallel by default with up to four workers, leaving capacity for the Vite server. Set `PW_WORKERS` to a positive integer to override the cap; `PW_WORKERS=1` is the stable serial mode for debugging. CI runs the default PR smoke selection with one worker so concurrent PixiJS matches cannot exhaust the hosted runner's fixed test budgets; the `ci:full` matrix keeps the default parallelism.

## Smoke set

`npm run test:smoke` runs exactly five critical journeys on both `desktop` and `mobile`:

1. Online create/join reaches a ready room.
2. An online shot hands the turn to the other human before the timer.
3. Pause freezes the turn timer and resume restarts it.
4. A finished match is registered once and appears in history/ranking.
5. Menu options persist after reload and apply to the active ruleset.

Keep this set small. Detailed edge cases belong in the full matrix, not behind `@smoke`.

## CI test selection

Pull requests run typecheck, content validation, affected Vitest, selected infra tests, build and smoke E2E. Add the `ci:full` label to run the complete browser matrix on a PR. Pushes to `main` run the full Node/build checks. The nightly and manually dispatched **E2E** workflow runs the full desktop/mobile Playwright matrix.

The map lives in [`scripts/affected.mjs`](../scripts/affected.mjs): add a rule when a new spec needs a new source area, otherwise that spec only runs when the spec file itself changes. Unmapped paths fall back to the full applicable set.

```bash
npm run test:quick                              # affected Vitest + infra, no browser
npm run test:affected                           # runs the full affected selection
node scripts/affected.mjs --base origin/main    # print the selection without running it
node scripts/affected.mjs --e2e-only --project=desktop --grep="@smoke" --dry-run
```

Selector flags:

| Flag | Effect |
| --- | --- |
| `--unit-only` | Skip Playwright; keep selected Vitest and infra tests |
| `--e2e-only` | Skip Vitest and infra; run selected Playwright specs |
| `--project=desktop\|mobile` | Forward a Playwright project filter |
| `--grep=<text>` | Forward a Playwright title filter |
| `--dry-run` | Print the plan without executing, even alongside `--run` |
| `--full` | Select the full applicable set |
| `--labels=ci:full` | Force the full applicable set |

The same script runs in CI with the PR base commit, so local and CI agree. To run affected Node tests before every push, opt in once per clone:

```bash
git config core.hooksPath .githooks
```

`git push --no-verify` skips the hook.

## Instrumentation

Gameplay assertions read the authoritative simulation through:

```ts
window.__WORMAGE__.snapshot()   // GameSnapshot
window.__WORMAGE__.engine       // imperative engine (surrender, endTurn…)
window.__WORMAGE__.painter      // TerrainPainter, for canvas assertions
```

This hook exists only to make E2E deterministic; it is not used by the UI. Tests still drive real buttons, keys and pointer gestures for anything the user can do.

Seeds: `/demo?seed=4242` fixes terrain generation and AI jitter so combat tests are reproducible. `/?seed=4242` works too — the root redirect keeps the query string.

## Suites

| File | Covers |
| --- | --- |
| `unit/engine.test.ts` | seeded construction without a DOM, wind, ammo, turn transitions, wipeout, surrender, scoring, blast falloff, 2–4 team turn order and last-surviving win |
| `unit/ai.test.ts` | reticle radius, AI weapon/firing-spot choice, jump-reach limit, left-facing aim, retreat and dynamite escape, preview and aim clamp |
| `unit/mockServer.test.ts` | leaderboard pagination and ranking, ruleset filter, idempotent registration |
| `unit/replay.test.ts` | a recorded action log (walk, grenade bounce, kill) replays to the same final snapshot; jump/end-turn dispatch |
| `unit/jump.test.ts` | ground-only jumps, directional jumps, air steering, jump during flight, AI jump when blocked |
| `unit/rope.test.ts` | rope attach/range, reel, swing, release momentum, carved anchor, turn cleanup, AI rope attempt, replay |
| `unit/parity.test.ts` | `simulateShot`/`previewFlight` read speed, gravity, wind, lifetime, fuse and bounce damping from `WEAPONS`/`BOUNCE` |
| `unit/fullscreen.test.ts` | `/project` is excluded, unsupported/already-fullscreen/no-DOM no-ops, a refused request resolves false, landscape only on coarse pointers |
| `unit/manifest.test.ts` | manifest fields, icon files and PNG dimensions, and the `index.html` links |
| `unit/bindings.test.ts` | defaults, Zod sanitize (corrupt/old schema/reserved codes), arrow aliases, duplicate swap, rejection classes, labels |
| `unit/wind.test.ts` | wind tier thresholds and direction labels used by the HUD gauge |
| `unit/storage.test.ts` | empty, corrupt and old-schema localStorage fall back safely |
| `unit/profile.test.ts` | profile load/save/reset, version mismatch, corrupt data and storage failures |
| `unit/bugReport.test.ts` | report payload (seed, URL, viewport, caps), online action log, upload success/error |
| `menu.spec.ts` | root redirect, demo/project routes, menu, tabs, options validation/persistence, empty and error states, ruleset-scoped board |
| `fullscreen.spec.ts` | fullscreen after Start and Play Again, a deliberate exit plus pause-dialog re-entry, landscape lock/unlock on touch, `/project` stays windowed |
| `pwa.spec.ts` | the manifest link and every icon are served on both routes |
| `combat.spec.ts` | firing, turn handoff, walking (keyboard and pads), weapon selection, pause/freeze, retreat window, dynamite fuse, crater carving, end turn |
| `mobile-hud.spec.ts` | touch firing: tap/slop, deliberate drag, pointer cancel, pointer ownership, charge percentage |
| `hud-layout.spec.ts` | 360/390/412 portrait and 915 landscape: target sizes, overlaps, equal team cards, Jump, compact landscape HUD |
| `jump.spec.ts` | Jump button hop, in-air press ignored, front/back jumps, key-repeat guard, Jump stays enabled through retreat |
| `rope.spec.ts` | HUD rope card anchors, reels in, and Jump lets go |
| `data.spec.ts` | result screen, match registration, history/ranking visibility, persistence after refresh |
| `settings.spec.ts` | Settings/Controls dialogs, persistence, rebind/swap/reset/cancel, reserved-key rejection, arrow aliases, paused settings apply to the next match, Restart Match, focus trap and restore, focus pulled back from behind the dialog, Escape/backdrop/fullscreen close rules |
| `bug-report.spec.ts` | pause-card report, real frame preview without the menu, payload in mock storage, denied/unsupported/wrong-surface fallback, failed send retry |
| `bug-report-real-capture.spec.ts` | opt-in real tab capture (`REAL_CAPTURE=1 npx playwright test tests/bug-report-real-capture.spec.ts`) |

Each Playwright spec runs twice, once per project (`desktop` / `mobile`). There are no visual baselines yet; the suite asserts engine state through the instrumentation hook instead. Visual baselines are planned for M1.

## Conventions

- Unit tests run in plain Node: import the engine, terrain and AI directly; no DOM, no Playwright.
- Playwright gives each test a fresh browser context, so localStorage starts empty. Specs that need stored data seed it in `addInitScript`.
- Prefer `data-testid` selectors owned by the UI, not CSS structure.
- Never assert on animation timing; wait for a state predicate (`waitForFunction`) or a test id.
- Failures keep traces and screenshots in `test-results/`.
- Touch specs use `Input.dispatchTouchEvent` over CDP; the describe sets `isMobile`/`hasTouch` so the same spec runs on both projects.
