import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import type { AiTerrain } from '../../src/game/ai';
import { terrain } from './terrainFixture';

// Force the no-plan path every time: no seed can "heal" and break CI.
vi.mock('../../src/game/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/game/ai')>();
  return { ...actual, planAiTurn: () => null };
});

const DT = 1 / 60;

// Regression test for #298: when planAiTurn returned null the CPU ended its
// turn ~0.9s in with the clock nearly full. It must walk toward the enemy
// instead, and only pass when truly stuck.
test(
  'CPU without a plan walks toward the enemy instead of ending its turn',
  () => {
    const engine = new GameEngine({
      turnSeconds: 10,
      wind: 'light',
      difficulty: 'veteran',
      seed: 321884985,
      wormsPerTeam: 1,
    });
    // Takes a plain string so narrowing of engine.phase never rejects the check.
    const isOver = (phase: string): boolean => phase === 'gameover';

    // Drive to the first CPU turn (team 1 is CPU by default).
    let guard = 0;
    while (
      !isOver(engine.phase) &&
      !(engine.phase === 'aim' && engine.teams[engine.activeTeam]?.isAi === true) &&
      guard < 8000
    ) {
      engine.update(DT);
      guard += 1;
    }
    expect(isOver(engine.phase)).toBe(false);
    expect(engine.teams[engine.activeTeam]?.isAi).toBe(true);

    const wormId = engine.activeWorm?.id;
    const startX = engine.activeWorm?.x ?? 0;
    const startTick = engine.tick;
    const turnAtStart = engine.turn;
    expect(wormId).toBeDefined();

    while (engine.turn === turnAtStart && !isOver(engine.phase) && guard < 8000) {
      engine.update(DT);
      guard += 1;
    }
    if (isOver(engine.phase)) return;

    const logged = (category: string): boolean =>
      engine.debugLog.some((e) => e.category === category && e.turn === turnAtStart);
    // The fallback must have engaged: no-plan seen, walk announced.
    expect(logged('ai.noPlan')).toBe(true);
    expect(logged('ai.fallbackWalk')).toBe(true);
    // The core regression: the turn must outlive the ~0.9s think window...
    expect(engine.tick - startTick).toBeGreaterThan(90);
    // ...and the worm must have done something real: advanced or fired.
    // A bare log is not proof of movement.
    const ended = engine.teams.flatMap((t) => t.worms).find((w) => w.id === wormId);
    const moved = Math.abs((ended?.x ?? startX) - startX);
    expect(moved > 5 || logged('ai.fire')).toBe(true);
  },
  30000,
);

test('CPU without a plan jumps a crater instead of standing still', () => {
  const engine = new GameEngine({
    turnSeconds: 6,
    wind: 'off',
    difficulty: 'rookie',
    seed: 403416938,
    wormsPerTeam: 1,
  });
  const crater: AiTerrain = {
    isSolid: (x, y) => y >= 500 && !(x > 430 && x < 500),
    groundY: (x, fromY, maxDown = 260) => {
      if (x > 430 && x < 500) return null;
      return fromY <= 500 && fromY + maxDown >= 500 ? 500 : null;
    },
  };
  Object.assign(engine.terrain, crater);
  engine.endTurn();

  const cpu = engine.activeWorm!;
  const enemy = engine.teams[0].worms[0];
  cpu.x = 400;
  cpu.y = 500;
  cpu.onGround = true;
  enemy.x = 900;
  enemy.y = 500;
  const startX = cpu.x;

  for (let i = 0; i < 4 * 60; i += 1) engine.update(DT);

  expect(engine.events.some((event) => event.type === 'jump')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.jump')).toBe(true);
  expect(cpu.x).toBeGreaterThan(startX + 20);
});

test('CPU without a plan tries a validated shot after bounded blocked recovery', () => {
  const engine = new GameEngine({
    turnSeconds: 8,
    wind: 'off',
    difficulty: 'rookie',
    seed: 403416938,
    wormsPerTeam: 1,
  });
  const wall: AiTerrain = {
    isSolid: (x, y) => y >= 500 || (x >= 480 && x <= 500 && y >= 420),
    groundY: (x, fromY, maxDown = 260) => {
      if (x >= 480 && x <= 500) return fromY <= 420 && fromY + maxDown >= 420 ? 420 : null;
      return fromY <= 500 && fromY + maxDown >= 500 ? 500 : null;
    },
  };
  Object.assign(engine.terrain, wall);
  engine.endTurn();

  const cpu = engine.activeWorm!;
  const enemy = engine.teams[0].worms[0];
  cpu.x = 400;
  cpu.y = 500;
  cpu.onGround = true;
  enemy.x = 900;
  enemy.y = 500;

  for (let i = 0; i < 8 * 60; i += 1) engine.update(DT);

  expect(engine.events.filter((event) => event.type === 'jump').length).toBeLessThanOrEqual(2);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fallback')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fire')).toBe(true);
});

test('CPU without a plan passes after bounded recovery when no shot can help', () => {
  const engine = new GameEngine({
    turnSeconds: 10,
    wind: 'off',
    difficulty: 'rookie',
    seed: 403416938,
    wormsPerTeam: 1,
  });
  Object.assign(engine.terrain, terrain(480));
  engine.endTurn();

  const cpu = engine.activeWorm!;
  const enemy = engine.teams[0].worms[0];
  cpu.x = 400;
  cpu.y = 500;
  cpu.onGround = true;
  enemy.x = 900;
  enemy.y = 500;
  const turnAtStart = engine.turn;
  let ticks = 0;
  while (engine.turn === turnAtStart && ticks < 10 * 60) {
    engine.update(DT);
    ticks += 1;
  }

  expect(engine.events.filter((event) => event.type === 'jump').length).toBeLessThanOrEqual(2);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.noFallbackShot')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fire')).toBe(false);
  expect(engine.turn).toBeGreaterThan(turnAtStart);
  expect(ticks).toBeLessThan(10 * 60);
});

test('CPU without a plan attempts a shot when its fallback is blocked at the world edge', () => {
  const engine = new GameEngine({
    turnSeconds: 6,
    wind: 'off',
    difficulty: 'rookie',
    seed: 822537370,
    wormsPerTeam: 1,
  });
  engine.endTurn();
  engine.loot.splice(0);
  engine.mobs.splice(0);

  const cpu = engine.activeWorm!;
  const enemy = engine.teams[0].worms[0];
  cpu.x = 12;
  cpu.y = engine.terrain.groundY(12, 120, 500) ?? 500;
  enemy.x = 0;
  enemy.y = cpu.y;

  const turnAtStart = engine.turn;
  let ticks = 0;
  while (engine.turn === turnAtStart && ticks < 6 * 60) {
    engine.update(DT);
    ticks += 1;
  }

  expect(engine.debugLog.some((entry) => entry.category === 'ai.noPlan')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fallbackWalk')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fallbackShot')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fire')).toBe(true);
  expect(engine.turn).toBeGreaterThan(turnAtStart);
  expect(ticks).toBeLessThan(6 * 60);
});
