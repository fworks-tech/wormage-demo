import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import { LOOT } from '../../src/game/config';
import type { MatchConfig } from '../../src/game/types';

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  turnSeconds: 30,
  wind: 'light',
  difficulty: 'veteran',
  seed: 4242,
  wormsPerTeam: 2,
  ...overrides,
});

const DT = 1 / 60;

describe('loot physics', () => {
  test('loot falls back onto the terrain after being lifted', () => {
    const engine = new GameEngine(config());
    const item = engine.loot[0];
    item.y -= 80;
    const startY = item.y;
    for (let i = 0; i < 240; i += 1) (engine as any).stepLoot(item, DT);
    expect(item.y).toBeGreaterThan(startY);
    expect(item.vy).toBe(0);
    expect(engine.terrain.isSolid(item.x, item.y + LOOT.radius + 1)).toBe(true);
  });

  test('a blast throws nearby loot upwards', () => {
    const engine = new GameEngine(config());
    const item = engine.loot[0];
    item.x = 600;
    item.y = 400;
    (engine as any).blastLoot(600, 460, 100);
    expect(item.vy).toBeLessThan(0);
  });

  test('initial loot spawns clear of worm spawn positions', () => {
    for (const seed of [4242, 7, 99, 2024]) {
      const engine = new GameEngine(config({ seed }));
      for (const item of engine.loot) {
        for (const team of engine.teams) for (const worm of team.worms) {
          expect(Math.abs(item.x - worm.x)).toBeGreaterThanOrEqual(60);
        }
      }
    }
  });

  test('loot far from a blast is untouched', () => {
    const engine = new GameEngine(config());
    const item = engine.loot[0];
    item.x = 600;
    item.y = 400;
    (engine as any).blastLoot(1500, 400, 100);
    expect(item.vx).toBe(0);
    expect(item.vy).toBe(0);
  });
});
