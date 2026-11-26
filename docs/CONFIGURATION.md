# Configuration

Every gameplay number lives in `src/game/config.ts`. Balance changes should never require touching `engine.ts`, the renderer or React.

## Where things live

| File | Owns |
| --- | --- |
| `src/game/config.ts` | weapons, physics constants, aim limits, teams, difficulty, defaults, sanitisation |
| `src/game/types.ts` | contracts (`GameSettings`, `MatchConfig`, `GameSnapshot`, `WeaponDef`…) |
| `src/state/storage.ts` | settings, identity, results and sessions: persistence and validation |
| `src/state/profile.ts` | typed profile repository, schema versioning and safe defaults |
| `src/api/mockServer.ts` | fixtures, pagination, idempotency, latency/error scenarios |

## World and physics

| Constant | Value | Unit | Notes |
| --- | --- | --- | --- |
| `BASE_W` / `BASE_H` | 1280 × 720 | px | renderer scale reference |
| `WORLD_SCALE` | 3 | × | world size multiplier; `?mapSize=1` selects the 1× debug arena |
| `WORLD_W` / `WORLD_H` | 3840 × 2160 | px | default logical arena; renderer camera pans through it |
| `WATER_Y` | 668 | px | below this worms and mobs drown, projectiles splash |
| `GRAVITY` | 780 | px/s² | worms and mobs |
| `PROJECTILE_GRAVITY` | 520 | px/s² | multiplied by the weapon's `gravityScale` |
| `MOB.speed` | 160 | px/s | engine-owned walking speed |
| `MOB.maxHp` / `damage` / `attackRange` | 60 / 5 / 60 | HP / HP / px | mob health, melee damage and reach |
| `MOB.orderSeconds` | 2 | s | movement budget issued by each hostile phase |
| `MOB.radius` / `maxGroundStep` | 18 / 40 | px | body radius and maximum supported ground-height change |
| `MOB.collisionStep` / `groundProbe` | 4 / 6 | px | collision substep and ground probe above the feet |
| `MOB.groundTolerance` / `supportRange` / `landingRange` | 1 / 80 / 18 | px | settling tolerance and terrain search ranges |
| `WORM.walkSpeed` | 74 | px/s | unaffected by wind |
| `WORM.jumpVelocity` | 300 | px/s | jump start only from the ground; one jump per landing |
| `WORM.jumpPush` | 180 | px/s | horizontal carry of a jump, and the air-steer speed while holding a direction |
| `JUMP_REACH` | ≈58 | px | peak jump height, derived from `jumpVelocity` and `GRAVITY`; one jump is the walkable climb limit |
| `AI.jumpWindowSeconds` | 6 | s | a blocked AI walk may keep jumping before it shoots from where it stands |
| `AI.ropeWindowSeconds` | 4 | s | how long the AI may try to rope over a ledge before it gives up |
| `AI.aimRadiansPerSecond` | 8.5 | rad/s | CPU reticle slew rate; the CPU fires only once the reticle matches the plan |
| `WORM.maxHp` | 100 | HP | per worm |
| `WORM.fallSafePx` | 150 | px | free fall before damage |
| `WORM.fallDamagePerPx` | 0.16 | HP/px | linear after the safe distance |
| `WORM.knockbackScale` / `knockbackMax` | 260 / 320 | px/s | ragdoll impulse = (damage/100) * scale * per-source scale, capped |
| `WORM.restitution` / `wallRestitution` | 0.35 / 0.4 | - | bounce off ground and walls while launched |
| `WORM.spinScale` / `landingStopSpeed` | 6 / 60 | px/s | tumble spin and the speed above which a landing bounces |
| `LOOT.gravity` | 720 | px/s² | loot falls to the terrain and drops when a blast carves under it |
| `LOOT.blastSpeed` | 260 | px/s | push at a blast centre, scaled down to 0 at the radius |
| `LOOT.radius` / `restitution` | 5 / 0.3 | px / - | item half-height and bounce off ground |
| `LOOT.bounceSpeed` / `friction` | 90 / 0.7 | px/s / - | speed above which a landing bounces; ground friction while resting |
| `AIM.min` / `AIM.max` | -3.04 / -0.1 | rad | upper half-plane only |
| `AIM.radius` | 130 | px | the reticle never leaves this circle around the worm |
| `FIXED_DT` | 1/60 | s | simulation step; rendering may run at any frame rate |
| `CHARGE_SECONDS` | 1.1 | s | time from 0 to 100% power |
| `RETREAT_SECONDS` | 3 | s | post-fire movement window before the turn passes |
| `PREVIEW_SECONDS` | 3 | s | free-flight span the dotted aim preview samples when a weapon has no fuse or life |

`WIND_ACCEL` maps the three wind settings to maximum wind units (`off: 0`, `light: 46`, `strong: 105`). Actual wind is re-rolled each turn in `[-max, +max]`, then applied to projectiles as `wind * windScale * 0.9` px/s².

## Rope

The anchored rope is a tool, not a weapon: every worm gets it, it has no ammo slot, and it never deals damage.

| Constant | Value | Unit | Notes |
| --- | --- | --- | --- |
| `ROPE.range` | 220 | px | maximum attach distance, also the maximum rope length |
| `ROPE.minLength` | 24 | px | shortest reel-in distance |
| `ROPE.reelSpeed` | 130 | px/s | W/S reel rate |
| `ROPE.swingAccel` | 3.5 | rad/s² | A/D swing acceleration while attached |
| `ROPE.damping` | 0.999 | per step | energy lost by the pendulum |
| `ROPE.maxAngularSpeed` | 4 | rad/s | swing-speed ceiling |

Aim at terrain, then press `R` or the Rope card to attach. A/D swings, W/S reels in and out, and Jump (or the Rope card again) lets go with the pendulum's velocity. The rope is cleared on turn end, firing, death, water and game over.

## Weapons

`WEAPONS` is a `Record<WeaponId, WeaponDef>`; adding a weapon means adding one entry, one icon branch in `renderer.drawProjectile`, one branch in `WormView.drawHeldWeapon` (the switch is exhaustive over `WeaponId`), and one entry in `WEAPON_ORDER`.

| Property | Meaning |
| --- | --- |
| `kind` | `projectile` (drawn with a reticle) or `drop` (placed at the worm, no reticle) |
| `ammo` | `null` = infinite, otherwise per-team stock per match |
| `damage` | base damage at the centre of the blast |
| `radius` | damage radius (px) |
| `terrainRadius` | crater radius (px); intentionally smaller than `radius` |
| `speedMin` / `speedMax` | muzzle speed at 0% / 100% power (px/s) |
| `gravityScale` | fraction of projectile gravity |
| `windScale` | fraction of wind acceleration |
| `fuse` | seconds before detonation, `null` = detonate on impact |
| `bounces` | reflects off terrain with 0.45 damping |

Current loadout: bazooka 42 dmg / 48 px, grenade 52 / 54 with 3 s fuse, shotgun 24 / 12 (flat, 0.34 s life), dynamite 78 / 78 with a 2.2 s fuse (a drop weapon).

Damage falloff: `max(0.22, 1 - distance / (radius + 11))`. A worm on the edge still takes 22%.

## Difficulty

`DIFFICULTY[difficulty].angleError` and `.powerError` are the half-width of random jitter applied to the AI's best solved shot. Rookie ≈ 4.3°/9% power, Veteran ≈ 2°/4.5%, Elite ≈ 0.7°/1.5%. The solver itself is identical; a dynamite drop has no angle or power to jitter.

## Match rules

- Turn timer: 20–90 s in 5 s steps (`TURN_SECONDS`), default 45.
- After firing, the shooter may walk for up to 3 s (`RETREAT_SECONDS`) before the turn passes.
- Teams: 2–4 per match, 3 worms each, 100 HP. Palette: Ironclad, Rustbelt, Verdant, Amber (editable names, dice generator).
- Scoring: `kills × 100 + surviving HP + 150 win bonus + max(0, 420 - elapsed)`.
- End reasons: `wipeout`, `surrender` (the result screen also understands `time` for fixture data).

## Settings lifecycle

1. `loadSettings()` reads localStorage, passes it through `sanitizeSettings()`, and clamps invalid values.
2. The /project Options panel and the /demo Settings dialog edit drafts; saving persists and updates React state.
3. Starting a match freezes those values into `MatchConfig` (plus a seed). Later edits apply to the next match only.
4. `configKey` = `` `${turnSeconds}s-${wind}-${difficulty}` `` travels with every match record so the leaderboard only compares like with like.

## Controls lifecycle

1. `loadBindings()` reads `wormage.bindings.v1`, parses it with Zod and merges the valid fields over `DEFAULT_BINDINGS` through `sanitizeBindings()`. Corrupt JSON, an old schema or a reserved code falls back per action instead of throwing.
2. A binding is a `KeyboardEvent.code` of 1–32 capitalised alphanumeric characters (for example `KeyF`, `Numpad1`, `IntlBackslash`). Modifier-only codes (`Shift*`, `Control*`, `Alt*`, `Meta*`, `OS*`), the fixed movement aliases (`Arrow*`) and browser keys (`Escape`, `Tab`, `F5`, `F12`, `ContextMenu`, `Unidentified`) are rejected.
3. The Controls dialog (New Game card and pause card) edits a draft. Capture rejects a reserved code with an inline message and stays in capture mode; `Esc` cancels capture and `Tab` cancels it to keep focus moving. Outside capture, `Esc` closes an open Settings or Controls panel back to the card that opened it and returns focus to that button; on the pause card `Esc` resumes, and while fullscreen the browser owns `Esc` (nothing else happens — the pause key still closes the panel). The overlay moves focus into the dialog, wraps Tab, pulls back focus that lands behind it and returns focus when the dialog closes; the backdrop closes an open panel. A key already in use swaps the two actions; **Reset** restores the defaults.
4. Saving persists the map and updates App state; `GameView` reads it immediately. Arrow keys remain fixed aliases for walking and aiming, so a rebind never removes them; `Ctrl`/`Meta`/`Alt` combinations stay with the browser.

## Demo network scenarios

`src/api/mockServer.ts` stores a scenario in localStorage and applies it to both transports:

| Scenario | Behaviour |
| --- | --- |
| `normal` | ~120 ms latency |
| `slow` | ~1500 ms latency (shows skeletons and background refresh) |
| `empty` | valid empty pages (shows empty states) |
| `error` | HTTP 503 on reads and writes (shows error states and retry) |

Reset with **Reset demo data** in Options, or `localStorage.removeItem('wormage.mockdb.v1')`.

## Debug logging

- Engine state: `GameEngine.debugLog` (bounded to 5000 entries) and `debugSnapshots` (bounded to 200).
- Client flush: `src/api/debugLog.ts` posts to `POST /api/debug-logs` with a 7-day `expiresAt`, chunked by a 200 KB byte budget (500 entries / 20 snapshots upper bounds) and serialized per engine so overlapping timers cannot duplicate or drop buffered entries.
- Server cap: `DEBUG_LOG_MAX_PAYLOAD_BYTES` (default 256 KB); oversized requests return 413.
- S3 layout: `debug-logs/<env>/<yyyy>/<mm>/<dd>/<sessionId>/<flushId>-<chunk>.json`, so periodic and final flushes never overwrite each other.
- Backend: `infra/lib/wormage-stack.ts` provisions the S3 bucket, SSM parameters and Lambda route.
- SSM parameters:
  - `/wormage/debug-logs/enabled` (default `false`)
  - `/wormage/debug-logs/retention-days`
  - `/wormage/debug-logs/max-payload-bytes`
  - `/wormage/debug-logs/prefix`
- Browser instrumentation: `window.__WORMAGE__.debugLog()`, `clearDebugLog()`, `flushDebugLog()`.
- Note: SSM values are read at deploy time and baked into the Lambda's environment variables; changing a parameter requires a redeploy. `retention-days` is enforced by the S3 lifecycle rule (7 days), not by the Lambda. Emergency: `aws lambda update-function-configuration` can flip the env immediately, then reconcile in CDK. The Lambda treats a missing env value as disabled (fail-closed).
- CloudWatch Logs retention is also 7 days (Lambda log group retention set in CDK).

## Bug reports

- Entry point: **Report bug** on the pause card. The note is optional.
- Capture: `src/ui/screenCapture.ts` calls `getDisplayMedia` for the current tab (`displaySurface: 'browser'`), rejects window/screen shares and missing `displaySurface`, and records two frames while `GameView` hides the pause overlay. The PNG is the real tab pixels (game + HUD, no menu); no DOM reconstruction is uploaded.
- Client budget: PNG up to 2.4 MB raw, downscaled in 0.8 steps if needed, JPEG at 0.92 only as a last resort. The preview shows exactly what is sent. Uploads use a 60 s request timeout.
- Payload: URL, app version, user agent, locale/timezone, viewport/DPR, seed and full match config, current snapshot, latest 1000 debug entries and 20 snapshots, the online action log and the screenshot.
- Server: `POST /api/bug-reports`; 4 MB body cap (`BUG_REPORT_MAX_BYTES`), PNG/JPEG magic-byte check, 2.6 MB screenshot cap and 40 MP cap. The Lambda env values are authoritative; the client mirrors them to fail early and budget the payload. Kill switch `/wormage/bug-reports/enabled` (default `false`) feeds `BUG_REPORTS_ENABLED`; prefix `BUG_REPORT_PREFIX` (default `bug-reports`). SSM values are read at deploy time, so changing a parameter requires a redeploy (emergency: `aws lambda update-function-configuration`, then reconcile in CDK). A missing env value means disabled. When disabled, the endpoint returns `202 {stored:false}` for a valid body (invalid bodies still return `400` because validation runs first) and the client surfaces a temporary-unavailable error without discarding the preview. The debug-log client stops POSTing after the first `stored:false`. Re-enable only after per-IP control (WAF per-IP or auth), not on per-route throttling alone.
- Throttle: the HTTP API default stage allows 10 rps with a burst of 20. Isolated limits: bug reports 1 rps / burst 2, debug logs 2 / 5, match registration and online create/join/action/forfeit 5 / 10 (300 writes/minute per route, shared across matches), online polling 5 / 10 and replay 1 / 2. A throttled request returns `429`; the client shows the generic send error and keeps the preview for retry. Limits live in `infra/lib/wormage-stack.ts`; route throttling is per API route, not per IP.
- S3: `bug-reports/<env>/<yyyy>/<mm>/<dd>/<reportId>.json` + `.png`, same bucket and 7-day lifecycle as the debug logs. There is no listing UI; read with the AWS CLI or console.
- Fallback: iOS Safari, denied permissions, and browsers that cannot confirm the tab send the data without a screenshot. The UI never uploads an approximate or unintended image.
- Trust boundary: `note`, `url`, `userAgent`, `timezone` and the screenshot are stored verbatim. Escape them before rendering in any future admin view.
- Alerts and operations: bug-report volume, handled application errors, API 5xx, Lambda and DynamoDB signals route to SNS; see [RUNBOOK.md](RUNBOOK.md).

## Common tweaks

- **Faster, bloodier matches:** `WORM.maxHp = 70`, bazooka `damage = 55`.
- **No wind:** settings only, no code change (`wind: 'off'`).
- **New weapon:** add to `WeaponId`, `WEAPONS` (with `kind`), `WEAPON_ORDER`, then a `drawProjectile` branch.
- **Longer matches:** raise `turnSeconds` in Options; the board separates rulesets automatically.
