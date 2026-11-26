import { expect, test } from 'vitest';
import { GameEngine } from '../../src/game/engine';

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

    let guard = 0;
    while (!isOver(engine.phase) && guard < 8000) {
      const turnAtStart = engine.turn;
      const isCpuTurn =
        engine.phase === 'aim' && engine.teams[engine.activeTeam]?.isAi === true;
      const worm = engine.phase === 'aim' ? engine.activeWorm : null;
      const wormId = worm?.id;
      const startX = worm?.x ?? 0;
      const startTick = engine.tick;

      while (engine.turn === turnAtStart && !isOver(engine.phase) && guard < 8000) {
        engine.update(DT);
        guard += 1;
      }
      if (isOver(engine.phase)) break;
      if (!isCpuTurn || !wormId) continue;

      const logged = (category: string): boolean =>
        engine.debugLog.some((e) => e.category === category && e.turn === turnAtStart);
      if (!logged('ai.noPlan')) continue;

      const durationTicks = engine.tick - startTick;
      const ended = engine.teams.flatMap((t) => t.worms).find((w) => w.id === wormId);
      const moved = Math.abs((ended?.x ?? startX) - startX);
      // The core regression: the turn must outlive the ~0.9s think window.
      expect(durationTicks).toBeGreaterThan(90);
      // ...and the worm must have done something: advanced, fired after a
      // retry, or at least logged the fallback walk before passing stuck.
      expect(moved > 5 || logged('ai.fire') || logged('ai.fallbackWalk')).toBe(true);
      return;
    }

    throw new Error('no no-plan CPU turn observed; seed no longer reproduces #298');
  },
  30000,
);
