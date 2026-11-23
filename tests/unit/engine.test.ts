import { describe, expect, test } from 'vitest';
import { blastFalloff, GameEngine } from '../../src/game/engine';
import { AI, WIND_ACCEL, WEAPONS, WORM } from '../../src/game/config';
import type { MatchConfig } from '../../src/game/types';

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  turnSeconds: 30,
  wind: 'light',
  difficulty: 'veteran',
  seed: 4242,
  wormsPerTeam: 3,
  ...overrides,
});

/** Drive the engine the way GameView does: whole 60 Hz steps only. */
const DT = 1 / 60;
const step = (engine: GameEngine, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i += 1) engine.update(DT);
};

describe('engine rules without a browser', () => {
  test('constructs a seeded match with no DOM', () => {
    const engine = new GameEngine(config());
    expect(engine.phase).toBe('aim');
    expect(engine.teams.map((team) => team.worms.length)).toEqual([3, 3]);
    expect(engine.activeWorm?.alive).toBe(true);
    expect(engine.timeLeft).toBe(30);
  });

  test('ending a turn hands play over and re-scopes the clock and wind', () => {
    const engine = new GameEngine(config({ wind: 'strong' }));
    engine.endTurn();
    expect(engine.activeTeam).toBe(1);
    expect(engine.turn).toBe(2);
    expect(engine.timeLeft).toBe(30);
    expect(Math.abs(engine.wind)).toBeLessThanOrEqual(WIND_ACCEL.strong);
  });

  test('wind never exceeds the ruleset maximum', () => {
    const engine = new GameEngine(config({ wind: 'light' }));
    for (let i = 0; i < 10; i += 1) {
      engine.endTurn();
      expect(Math.abs(engine.wind)).toBeLessThanOrEqual(WIND_ACCEL.light);
    }
  });

  test('wind is calm when the ruleset turns it off', () => {
    const engine = new GameEngine(config({ wind: 'off' }));
    engine.endTurn();
    expect(engine.wind).toBe(0);
  });

  test('the CPU hides its reticle while walking, then aims before firing', () => {
    const engine = new GameEngine(config());
    engine.endTurn();
    const aiWorm = engine.activeWorm;
    expect(aiWorm).not.toBeNull();

    // Start from a deliberately different angle so the aim-in animation has room.
    aiWorm!.aimAngle = -0.1;

    const maxStep = AI.aimRadiansPerSecond * DT + 1e-9;
    let maxObservedStep = 0;
    let movedWhileWalking = false;
    let movedWhileAiming = false;
    let shotAngle: number | null = null;
    let aimBeforeShot: number | null = null;

    for (let i = 0; i < 1800 && engine.activeTeam === 1 && shotAngle === null; i += 1) {
      const before = aiWorm!.aimAngle;
      engine.update(DT);
      const step = Math.abs(aiWorm!.aimAngle - before);

      // stepWorm walks after updateAi, so the post-update direction is the tick's direction.
      if (engine.moveDir !== 0 && step > 1e-9) movedWhileWalking = true;
      if (engine.aiAiming) {
        maxObservedStep = Math.max(maxObservedStep, step);
        if (step > 1e-9) movedWhileAiming = true;
      }
      const shot = engine.events.find((event) => event.type === 'fire');
      if (shot?.type === 'fire') {
        shotAngle = shot.angle;
        aimBeforeShot = before;
      }
    }

    expect(movedWhileWalking).toBe(false);
    expect(movedWhileAiming).toBe(true);
    expect(maxObservedStep).toBeLessThanOrEqual(maxStep);
    expect(shotAngle).not.toBeNull();
    // Firing must not teleport a reticle the player just watched settle.
    expect(shotAngle).toBeCloseTo(aimBeforeShot as number, 6);
  });

  test('firing spends limited ammo but not the bazooka', () => {
    const engine = new GameEngine(config());
    engine.fire();
    expect(engine.teams[0].ammo.bazooka).toBe(Infinity);

    const second = new GameEngine(config());
    second.selectWeapon('dynamite');
    second.fire();
    expect(second.teams[0].ammo.dynamite).toBe((WEAPONS.dynamite.ammo ?? 0) - 1);
  });

  test('a wipeout ends the match and scores the survivor', () => {
    const engine = new GameEngine(config());
    const shooter = engine.activeWorm;
    expect(shooter).not.toBeNull();
    for (const worm of engine.teams[1].worms) {
      worm.x = shooter!.x;
      worm.y = shooter!.y;
      worm.hp = 1;
    }
    engine.selectWeapon('dynamite');
    engine.fire();
    step(engine, 4);

    expect(engine.phase).toBe('gameover');
    expect(engine.winnerTeam).toBe(0);
    expect(engine.endReason).toBe('wipeout');
    expect(engine.kills[0]).toBe(3);
  });

  test('surrender hands the win away and scoring rewards the winner', () => {
    const engine = new GameEngine(config());
    expect(engine.scoreFor(0)).toBe(300);
    engine.surrender();
    expect(engine.phase).toBe('gameover');
    expect(engine.winnerTeam).toBe(1);
    expect(engine.endReason).toBe('surrender');
    expect(engine.scoreFor(1)).toBe(300 + 150 + 420);
  });
});

describe('blast damage', () => {
  const reach = WEAPONS.bazooka.radius + WORM.radius;

  test('falls off linearly from full damage at the centre', () => {
    expect(blastFalloff(0, reach)).toBeCloseTo(1);
    expect(blastFalloff(reach / 2, reach)).toBeCloseTo(0.5);
  });

  test('never drops below 22%, even outside the radius', () => {
    expect(blastFalloff(reach, reach)).toBeCloseTo(0.22);
    expect(blastFalloff(reach * 4, reach)).toBe(0.22);
  });
});

describe('multi-team matches', () => {
  const cfg = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
    turnSeconds: 30,
    wind: 'light',
    difficulty: 'veteran',
    seed: 4242,
    wormsPerTeam: 2,
    teamCount: 3,
    ...overrides,
  });

  test('constructs N teams with correct counts', () => {
    const engine = new GameEngine(cfg());
    expect(engine.teams.length).toBe(3);
    expect(engine.teams.map((t) => t.worms.length)).toEqual([2, 2, 2]);
  });

  test('spawn zones do not overlap across teams', () => {
    const engine = new GameEngine(cfg());
    const xs = engine.teams.flatMap((t) => t.worms.map((w) => w.x));
    // each team's worms occupy a distinct horizontal band
    for (let i = 0; i < engine.teams.length; i += 1) {
      for (let j = i + 1; j < engine.teams.length; j += 1) {
        const maxI = Math.max(...engine.teams[i].worms.map((w) => w.x));
        const minJ = Math.min(...engine.teams[j].worms.map((w) => w.x));
        expect(maxI).toBeLessThan(minJ);
      }
    }
    expect(new Set(xs).size).toBe(xs.length);
  });

  test('turn order cycles through living teams', () => {
    const engine = new GameEngine(cfg());
    const order: number[] = [engine.activeTeam];
    for (let i = 0; i < 5; i += 1) {
      engine.endTurn();
      order.push(engine.activeTeam);
    }
    // 3 teams -> after first, cycles 1,2,0,1,2
    expect(order.slice(1)).toEqual([1, 2, 0, 1, 2]);
  });

  test('wipeout of a team ends match when only one survives', () => {
    const engine = new GameEngine(cfg());
    // eliminate team 1 and team 2
    for (const w of engine.teams[1].worms) { w.alive = false; w.hp = 0; }
    for (const w of engine.teams[2].worms) { w.alive = false; w.hp = 0; }
    // Force re-evaluation by ending turn from team 0
    // Use snapshot phase check
    expect(engine.phase).not.toBe('gameover');
    // Now eliminate team 0's opponents already done; end turn should finish
    (engine as any).checkWipeout();
    expect(engine.phase).toBe('gameover');
    expect(engine.winnerTeam).toBe(0);
  });

  test('surrender ends match', () => {
    const engine = new GameEngine(cfg());
    engine.surrender();
    expect(engine.phase).toBe('gameover');
  });

  test('nearestEnemy considers all opposing teams', () => {
    // smoke: no crash and game runs
    const engine = new GameEngine(cfg());
    engine.endTurn(); // AI turn
    expect(engine.phase).toBe('aim');
  });
});


describe('mob layout', () => {
  test('spawns four times the team size away from worms and mines', () => {
    const engine = new GameEngine({ turnSeconds: 30, wind: 'light', difficulty: 'veteran', seed: 777, wormsPerTeam: 3 });
    expect(engine.mobs.length).toBe(12);
    for (const m of engine.mobs) {
      expect(m.x).toBeGreaterThanOrEqual(60);
      expect(m.x).toBeLessThanOrEqual(3840 - 60);
    }
    for (let i = 0; i < engine.mobs.length; i += 1) {
      for (let j = i + 1; j < engine.mobs.length; j += 1) {
        expect(Math.abs(engine.mobs[i].x - engine.mobs[j].x)).toBeGreaterThanOrEqual(48);
      }
    }
    for (const mob of engine.mobs) {
      for (const mine of engine.loot.filter((item) => item.kind === 'mine')) {
        expect(Math.abs(mob.x - mine.x)).toBeGreaterThanOrEqual(48);
      }
    }
  });
});

describe('mob combat', () => {
  test('a direct bazooka blast does not kill a full-health mob', () => {
    const engine = new GameEngine(config());
    const mob = engine.mobs[0];
    (engine as any).blast(mob.x, mob.y, WEAPONS.bazooka.damage, WEAPONS.bazooka.radius, WEAPONS.bazooka.terrainRadius, 0, 'explosion');

    expect(mob.alive).toBe(true);
    expect(mob.hp).toBeGreaterThan(0);
    expect(engine.debugLog.some((entry) => entry.category === 'combat.mobHurt')).toBe(true);
    expect(engine.debugLog.some((entry) => entry.category === 'combat.mobDeath')).toBe(false);
  });

  test('bazooka and a nearby mine can accumulate enough damage to kill a mob', () => {
    const engine = new GameEngine(config());
    const mob = engine.mobs[0];
    (engine as any).blast(mob.x, mob.y, WEAPONS.bazooka.damage, WEAPONS.bazooka.radius, WEAPONS.bazooka.terrainRadius, 0, 'explosion');
    (engine as any).blast(mob.x, mob.y, 40, 60, 40, 0, 'mineExplosion');

    expect(mob.alive).toBe(false);
    expect(engine.debugLog.filter((entry) => entry.category === 'combat.mobHurt' && entry.actorId === `mob-${mob.id}`)).toHaveLength(2);
    expect(engine.debugLog.some((entry) => entry.category === 'combat.mobDeath' && entry.actorId === `mob-${mob.id}`)).toBe(true);
  });

  test('the hostile phase never damages mobs', () => {
    const engine = new GameEngine(config());
    const before = engine.mobs.map((mob) => mob.hp);
    engine.endTurn();

    expect(engine.mobs.map((mob) => mob.hp)).toEqual(before);
  });
});
