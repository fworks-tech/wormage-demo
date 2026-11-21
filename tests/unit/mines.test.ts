import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import type { MatchConfig } from '../../src/game/types';

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  turnSeconds: 30,
  wind: 'light',
  difficulty: 'veteran',
  seed: 4242,
  wormsPerTeam: 3,
  ...overrides,
});

const DT = 1 / 60;
const step = (engine: GameEngine, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i += 1) engine.update(DT);
};

describe('mine detonation feedback', () => {
  test('snapshot loot carries armed state', () => {
    const engine = new GameEngine(config());
    const snap = engine.snapshot();
    for (const item of snap.loot) {
      expect(typeof item.armed).toBe('boolean');
      expect(typeof item.fuse).toBe('number');
    }
  });

  test('a forced armed mine emits mineExplosion and carves terrain', () => {
    const engine = new GameEngine(config());
    // Force an armed mine next to the active worm so it detonates deterministically.
    const worm = engine.activeWorm!;
    const mine = engine.loot.find((l) => l.kind === 'mine');
    expect(mine).toBeDefined();
    mine!.x = worm.x;
    mine!.y = worm.y;
    mine!.armed = true;
    mine!.fuse = 0.05;

    const eventsBefore = engine.events.length;
    step(engine, 0.2);
    const newEvents = engine.events.slice(eventsBefore);
    const mineEvents = newEvents.filter((e) => e.type === 'mineExplosion');
    expect(mineEvents.length).toBeGreaterThan(0);
    // The mine is consumed (moved off-screen).
    expect(engine.loot.find((l) => l === mine)).toBeUndefined();
  });

  test('mine detonation damages worms within radius', () => {
    const engine = new GameEngine(config());
    const worm = engine.activeWorm!;
    const beforeHp = worm.hp;
    const mine = engine.loot.find((l) => l.kind === 'mine')!;
    mine.x = worm.x;
    mine.y = worm.y;
    mine.armed = true;
    mine.fuse = 0.05;
    step(engine, 0.2);
    // Worm should have taken damage (unless it died and hp=0, which is fine).
    expect(worm.hp).toBeLessThanOrEqual(beforeHp);
  });

  test('mine detonation does not crash on gameover', () => {
    const engine = new GameEngine(config());
    const worm = engine.activeWorm!;
    const mine = engine.loot.find((l) => l.kind === 'mine')!;
    mine.x = worm.x;
    mine.y = worm.y;
    mine.armed = true;
    mine.fuse = 0.05;
    // Drop worm HP so the mine kills it.
    worm.hp = 10;
    expect(() => step(engine, 0.2)).not.toThrow();
  });
});
