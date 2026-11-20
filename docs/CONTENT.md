# Content Authoring Guide

All gameplay content lives under `src/content/` and is validated by Zod schemas in `src/content/schema.ts`. Run `npm run validate:content` after edits.

## Adding a weapon

1. Add an entry to `src/content/weapons.ts` matching `WeaponSchema`.
2. Append its id to `WEAPON_ORDER`.
3. Add ammo to the engine's ammo map (engine.ts constructor) if limited.
4. Add an icon case in `src/ui/WeaponIcon.tsx` (optional).

## Adding a map theme

Edit `Terrain` constructor in `src/game/terrain.ts` (theme tweaks surface amplitude/base height). Themes: island, mesa, canyon, desert, arctic.

## Adding a mode

Add to ModeSchema usage via `ModeId` in `src/game/types.ts` and handle in engine (checkWipeout/finishTurn).

## Adding loot

Loot spawns in `engine.spawnLoot()`. Types: ammo, mine, secret. Proximity pickup in `updateLoot`.

## Adding a mob

Append to `engine.spawnMobs()` or content. Mob acts in `hostilePhase()`.

## Stages

Edit `STAGES` in `src/state/stages.ts`. Progress persisted in localStorage.

## Testing checklist

- `npm run typecheck`
- `npm run validate:content`
- `npm test`
