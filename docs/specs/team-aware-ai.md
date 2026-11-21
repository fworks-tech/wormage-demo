# Spec: Team-aware CPU AI (friendly fire, focus fire, threat, revenge)

Status: partially implemented (friendly-fire veto, focus/threat/revenge scoring, decay wired; defaults tuned)
Scope: `src/game/config.ts`, `src/game/ai.ts`, `src/game/engine.ts`, `src/game/types.ts` (minimal)
Default difficulty: veteran

## Goal
Make the Rustbelt CPU behave like a team: avoid killing allies, concentrate fire on the most dangerous/threatened targets, and react with "revenge" aggression after an ally is hurt. Add light anticipation of the human player's likely impact by prioritizing enemies that can reach our worms.

## Non-goals
- No pathfinding changes; no new weapons; no persistence of player patterns.
- No change to physics or renderer.
- No multiplayer/online.

## Config additions (`config.ts` → `AI`)
- `friendlyFireVeto: boolean` (default true)
- `friendlyFireTolerance: number` (default 8) — max ally+self damage allowed before a candidate is vetoed.
- `focusFireBonus: number` (default 18) — bonus when impact lands on the lowest-HP enemy.
- `threatBonus: number` (default 22) — bonus for hitting an enemy within `threatRadius` of any ally.
- `threatRadius: number` (default 320)
- `revengeBonus: number` (default 30) — flat aggression bonus while revenge is active.
- `revengeDecayTurns: number` (default 2) — turns before revenge state clears.

## Engine changes (`engine.ts`)
1. Add `revengeFocusByTeam: Record<number, { x; y } | null>` and `revengeTurnsByTeam: Record<number, number>`.
2. In `hurt()`, when `sourceTeam !== null && sourceTeam !== worm.teamId`: set `revengeFocusByTeam[worm.teamId] = { x: worm.x, y: worm.y }` and `revengeTurnsByTeam[worm.teamId] = AI.revengeDecayTurns`.
3. Decrement revenge turns at `beginTurn()` for the active team; clear focus when 0.
4. In `updateAi` planning call, pass `revengeFocus` (current team's focus or null) into `AiTurnInput`.
5. Track `teamHpBefore` not needed.

## AI changes (`ai.ts`)
1. `AiTurnInput` gains `revengeFocus: { x; y } | null`.
2. `damageScore` gains `revengeFocus` param:
   - Existing enemy/ally/self aggregation.
   - Focus fire: identify lowest-HP enemy; if impact within blast reach of that worm, add `focusFireBonus`.
   - Threat: for each enemy within `threatRadius` of any ally worm, add `threatBonus` (once, if hit).
   - Revenge: if `revengeFocus` set, add `revengeBonus`.
3. Friendly fire veto in `planProjectile` and `planDrop`:
   - Compute collateral `{ ally, self }` for candidate.
   - If `self + ally > friendlyFireTolerance`, veto (skip) unless no non-vetoed candidate exists; then allow lowest-collateral.
4. Pass `revengeFocus` through to `damageScore`.

## Anticipation (deduction)
- Threat bonus above covers "enemy can reach us" by proximity. Additionally, in `planAiTurn`, when choosing target, prefer enemies whose distance to our weakest worm ≤ `threatRadius` (already via bonus). No new simulation of player shots (deferred).

## Telemetry / tests
- Unit tests in `tests/unit/ai*.test.ts`: veto behavior, focus fire bonus, revenge bonus, decay.
- Playwright: smoke (no friendly-fire kills in 5 seeded matches? optional).

## Risks
- Veto may leave no candidate → fallback relaxes; ensure never null-return due solely to veto.
- Revenge bonus could make AI reckless; keep default moderate and tunable.

## Acceptance
- `npm run typecheck`, `npm test`, `npm run build` pass.
- New tests fail without change.
- Docs updated.