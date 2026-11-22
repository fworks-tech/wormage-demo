import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../src/game/engine';
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
const step = (engine: GameEngine, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i += 1) engine.update(DT);
};

describe('ragdoll knockback', () => {
  test('hurt() applies velocity impulse, not a teleport', () => {
    const engine = new GameEngine(config());
    const worm = engine.activeWorm!;
    (engine as any).hurt(worm, 40, worm.x - 50, worm.y, 1, 1.0);
    expect(worm.vx).toBeGreaterThan(0);
    expect(worm.vy).toBeLessThan(0);
    expect(worm.launched).toBe(true);
    expect(worm.rope).toBeNull();
  });

  test('launched worm cannot air-steer', () => {
    const engine = new GameEngine(config());
    const worm = engine.activeWorm!;
    (engine as any).hurt(worm, 40, worm.x - 50, worm.y, 1, 1.0);
    expect(worm.launched).toBe(true);
    engine.setMove(1);
    engine.update(1 / 60);
    expect(worm.vx).not.toBe(180);
  });

  test('launched worm bounces on landing', () => {
    const engine = new GameEngine(config());
    const worm = engine.activeWorm!;
    (engine as any).hurt(worm, 40, worm.x, worm.y + 50, 1, 1.0);
    expect(worm.launched).toBe(true);
    step(engine, 2);
    expect(worm.launched).toBe(false);
    expect(worm.onGround).toBe(true);
  });

  test('hurt cancels charging on the active worm', () => {
    const engine = new GameEngine(config());
    engine.startCharge();
    const worm = engine.activeWorm!;
    (engine as any).hurt(worm, 40, worm.x - 50, worm.y, 1, 1.0);
    expect(engine.charging).toBe(false);
    expect(engine.power).toBe(0);
  });

  test('a launched worm cannot fire', () => {
    const engine = new GameEngine(config());
    const worm = engine.activeWorm!;
    (engine as any).hurt(worm, 40, worm.x - 50, worm.y, 1, 1.0);
    expect(worm.launched).toBe(true);
    engine.fire();
    expect(engine.hasFired).toBe(false);
  });

  test('beginTurn settles a worm that is still mid-flight', () => {
    const engine = new GameEngine(config());
    const worm = engine.activeWorm!;
    (engine as any).hurt(worm, 40, worm.x - 50, worm.y, 1, 1.0);
    expect(worm.onGround).toBe(false);
    (engine as any).beginTurn();
    expect(worm.vx).toBe(0);
    expect(worm.vy).toBe(0);
    expect(worm.launched).toBe(false);
    expect(worm.onGround).toBe(true);
  });

  test('shotgun fires two projectiles', () => {
    const engine = new GameEngine(config({}));
    engine.selectWeapon('shotgun');
    engine.record({ type: 'fire' });
    expect(engine.projectilesInFlight.length).toBe(2);
  });

  test('per-source impulseScale: shotgun < explosion', () => {
    const engine = new GameEngine(config());
    const w1 = engine.activeWorm!;
    (engine as any).hurt(w1, 24, w1.x - 50, w1.y, 1, 0.35);
    const shotgunVx = Math.abs(w1.vx);

    const engine2 = new GameEngine(config());
    const w2 = engine2.activeWorm!;
    (engine2 as any).hurt(w2, 42, w2.x - 50, w2.y, 1, 1.0);
    const explVx = Math.abs(w2.vx);

    expect(explVx).toBeGreaterThan(shotgunVx);
  });
});
