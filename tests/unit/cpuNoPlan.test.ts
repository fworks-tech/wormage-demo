import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../src/game/engine';

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

test('CPU without a plan passes after a blocked fallback instead of waiting for the clock', () => {
  const engine = new GameEngine({
    turnSeconds: 4,
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
  while (engine.turn === turnAtStart && ticks < 4 * 60) {
    engine.update(DT);
    ticks += 1;
  }

  expect(engine.debugLog.some((entry) => entry.category === 'ai.noPlan')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fallbackWalk')).toBe(true);
  expect(engine.turn).toBeGreaterThan(turnAtStart);
  expect(ticks).toBeLessThan(3 * 60);
});
