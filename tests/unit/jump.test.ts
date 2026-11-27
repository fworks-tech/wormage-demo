import { describe, expect, test } from 'vitest';
import { chooseRetreat, isUsefulAiShot, planAiTurn, simulateShot } from '../../src/game/ai';
import { WEAPONS, WORM } from '../../src/game/config';
import { GameEngine } from '../../src/game/engine';
import type { MatchConfig } from '../../src/game/types';
import { terrain } from './terrainFixture';

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

/** Flat ground at y = 500 so a jump arc is independent of the generated island. */
const flatEngine = () => {
  const engine = new GameEngine(config());
  Object.assign(engine.terrain, terrain());
  const worm = engine.activeWorm!;
  worm.x = 400;
  worm.y = 500;
  worm.vy = 0;
  worm.onGround = true;
  worm.fallDistance = 0;
  return { engine, worm };
};

describe('jump physics', () => {
  test('a jump with a held direction carries the worm forward or back', () => {
    const front = flatEngine();
    front.engine.jump(1);
    step(front.engine, 0.4);
    expect(front.worm.x).toBeGreaterThan(430);

    const back = flatEngine();
    back.engine.jump(-1);
    step(back.engine, 0.4);
    expect(back.worm.x).toBeLessThan(370);
  });

  test('a jump in the air is ignored', () => {
    const { engine, worm } = flatEngine();
    engine.jump(0);
    step(engine, 0.2);
    const vy = worm.vy;
    const jumps = engine.events.filter((event) => event.type === 'jump').length;

    engine.jump(0);

    expect(worm.vy).toBe(vy);
    expect(engine.events.filter((event) => event.type === 'jump')).toHaveLength(jumps);
  });

  test('holding a direction steers a vertical jump in the air', () => {
    const { engine, worm } = flatEngine();
    engine.jump(0);
    step(engine, 0.15);
    const startX = worm.x;

    engine.setMove(1);
    step(engine, 0.3);

    expect(worm.onGround).toBe(false);
    expect(worm.x).toBeGreaterThan(startX + 30);
  });

  test('a worm must land before it can jump again', () => {
    const { engine, worm } = flatEngine();
    engine.jump(0);
    step(engine, 1.2);
    expect(worm.onGround).toBe(true);

    engine.jump(0);

    expect(engine.events.filter((event) => event.type === 'jump')).toHaveLength(2);
  });

  test('jumping is legal after firing, while the projectile is in flight', () => {
    const { engine, worm } = flatEngine();
    engine.fire();
    expect(engine.phase).toBe('projectile');
    expect(engine.retreatActive).toBe(true);

    engine.jump(0);

    expect(worm.vy).toBeLessThan(0);
    expect(engine.events.some((event) => event.type === 'jump')).toBe(true);
  });

  test('a dead worm cannot jump', () => {
    const { engine, worm } = flatEngine();
    worm.alive = false;
    engine.jump(0);

    expect(engine.events.some((event) => event.type === 'jump')).toBe(false);
  });

  test('a replay records the jump direction', () => {
    const { engine, worm } = flatEngine();
    engine.record({ type: 'jump', dir: -1 });

    expect(engine.log[0].action).toEqual({ type: 'jump', dir: -1 });
    expect(worm.vx).toBeLessThan(0);
  });

  test('the player jump action cannot move the AI worm', () => {
    const engine = new GameEngine(config());
    engine.endTurn();
    expect(engine.activeTeam).toBe(1);

    const worm = engine.activeWorm!;
    engine.jump(1);

    expect(worm.vy).toBe(0);
    expect(engine.events.some((event) => event.type === 'jump')).toBe(false);
  });

  test('the AI does not jump at a ledge above jump reach', () => {
    const engine = new GameEngine(config());
    Object.assign(engine.terrain, {
      isSolid: (x: number, y: number) => y >= (x >= 460 ? 420 : 500),
      groundY: (x: number, fromY: number, maxDown = 260) => {
        const top = x >= 460 ? 420 : 500;
        const start = Math.max(top, Math.ceil(fromY / 4) * 4);
        return start <= fromY + maxDown ? start : null;
      },
    });
    engine.endTurn();
    const worm = engine.activeWorm!;
    worm.x = 400;
    worm.y = 500;
    worm.vy = 0;
    worm.onGround = true;
    worm.fallDistance = 0;

    const internals = engine as unknown as {
      aiPlan: {
        weapon: 'bazooka';
        fireX: number;
        fireY: number;
        angle: number;
        power: number;
        retreatX: number;
      } | null;
      aiThinking: boolean;
    };
    internals.aiPlan = {
      weapon: 'bazooka',
      fireX: 500,
      fireY: 420,
      angle: -0.5,
      power: 0.5,
      retreatX: worm.x,
    };
    internals.aiThinking = false;

    step(engine, 2.5);

    expect(engine.events.filter((event) => event.type === 'jump')).toHaveLength(0);
    expect(engine.debugLog.some((entry) => entry.category === 'ai.jump')).toBe(false);
    expect(engine.debugLog.some((entry) => entry.category === 'ai.noFallbackShot')).toBe(true);
  });

  test('the AI does not fire after drowning when its firing spot vanished', () => {
    const engine = new GameEngine(config());
    Object.assign(engine.terrain, {
      isSolid: (x: number) => x >= 430,
      groundY: (x: number) => (x >= 430 ? null : 500),
    });
    engine.endTurn();
    const worm = engine.activeWorm!;
    worm.x = 400;
    worm.y = 500;
    worm.vy = 0;
    worm.onGround = true;
    worm.fallDistance = 0;

    const internals = engine as unknown as {
      aiPlan: {
        weapon: 'bazooka';
        fireX: number;
        fireY: number;
        angle: number;
        power: number;
        retreatX: number;
      } | null;
      aiThinking: boolean;
    };
    internals.aiPlan = {
      weapon: 'bazooka',
      fireX: 500,
      fireY: 500,
      angle: -0.5,
      power: 0.5,
      retreatX: worm.x,
    };
    internals.aiThinking = false;

    step(engine, 2.5);

    expect(engine.events.filter((event) => event.type === 'jump')).toHaveLength(0);
    expect(worm.alive).toBe(false);
    expect(engine.hasFired).toBe(false);
  });

  test('the AI validates the same minimum power that fire uses', () => {
    const angle = -0.5;
    const shooter = { id: 'cpu', teamId: 1, x: 400, y: 500, hp: 100 };
    const muzzleX = shooter.x + Math.cos(angle) * 18;
    const muzzleY = shooter.y - 14 + Math.sin(angle) * 18;
    const actual = simulateShot(terrain(), muzzleX, muzzleY, angle, 0.12, 'bazooka', 0);
    const stale = simulateShot(terrain(), muzzleX, muzzleY, angle, 0, 'bazooka', 0);
    const target = { id: 'player', teamId: 0, x: actual.x, y: actual.y + 13, hp: 100 };
    expect(Math.hypot(actual.x - target.x, actual.y - (target.y - 13))).toBeLessThanOrEqual(
      WEAPONS.bazooka.radius + WORM.radius,
    );
    expect(Math.hypot(stale.x - target.x, stale.y - (target.y - 13))).toBeGreaterThan(
      WEAPONS.bazooka.radius + WORM.radius,
    );
    expect(isUsefulAiShot({
      terrain: terrain(),
      shooter,
      worms: [shooter, target],
      weapon: 'bazooka',
      angle,
      power: 0.12,
      wind: 0,
    })).toBe(true);
    expect(isUsefulAiShot({
      terrain: terrain(),
      shooter,
      worms: [shooter, target],
      weapon: 'bazooka',
      angle,
      power: 0,
      wind: 0,
    })).toBe(false);

    const engine = new GameEngine(config({ wormsPerTeam: 1 }));
    Object.assign(engine.terrain, terrain());
    engine.wind = 0;
    engine.endTurn();
    const worm = engine.activeWorm!;
    worm.x = 400;
    worm.y = 500;
    worm.vy = 0;
    worm.onGround = true;
    worm.aimAngle = angle;
    const enemy = engine.teams[0].worms[0];
    enemy.x = target.x;
    enemy.y = target.y;
    engine.power = 0;
    engine.weapon = 'bazooka';

    const internals = engine as unknown as { aiPlan: { weapon: 'bazooka'; fireX: number; fireY: number; angle: number; power: number; retreatX: number }; aiThinking: boolean };
    internals.aiPlan = { weapon: 'bazooka', fireX: 400, fireY: 500, angle, power: 0.25, retreatX: 400 };
    internals.aiThinking = false;

    engine.update(DT);

    expect(engine.hasFired).toBe(true);
    expect(engine.debugLog.find((entry) => entry.category === 'ai.fire')?.data?.power).toBe(0.12);
  });

  test('the AI fires a dynamite plan using the escape it validated', () => {
    const shooter = { id: 'cpu', teamId: 1, x: 400, y: 500, hp: 100 };
    const target = { id: 'player', teamId: 0, x: 480, y: 500, hp: 100 };
    const retreatX = chooseRetreat(
      terrain(),
      shooter,
      [target],
      { x: shooter.x, y: shooter.y - 8 },
      WEAPONS.dynamite.radius + WORM.radius + 6,
      WEAPONS.dynamite.fuse!,
    );
    expect(retreatX).not.toBeNull();
    const turn = {
      weapon: 'dynamite' as const,
      fireX: shooter.x,
      fireY: shooter.y,
      angle: -0.5,
      power: 0.5,
      retreatX: retreatX!,
    };

    const engine = new GameEngine(config({ wormsPerTeam: 1 }));
    Object.assign(engine.terrain, terrain());
    engine.wind = 0;
    engine.endTurn();
    const worm = engine.activeWorm!;
    worm.x = turn.fireX;
    worm.y = turn.fireY;
    worm.vy = 0;
    worm.onGround = true;
    worm.fallDistance = 0;
    worm.aimAngle = turn.angle;
    const enemy = engine.teams[0].worms[0];
    enemy.x = target.x;
    enemy.y = target.y;
    engine.power = turn.power;
    engine.weapon = 'dynamite';

    const internals = engine as unknown as { aiPlan: typeof turn; aiThinking: boolean };
    internals.aiPlan = turn;
    internals.aiThinking = false;

    engine.update(DT);

    expect(engine.hasFired).toBe(true);
  });

  test('the AI revalidates its plan from the pose where it will fire', () => {
    const shooter = { id: 'cpu', teamId: 1, x: 400, y: 500, hp: 100 };
    const target = { id: 'player', teamId: 0, x: 900, y: 500, hp: 100 };
    const plan = planAiTurn({
      terrain: terrain(),
      worm: shooter,
      worms: [shooter, target],
      ammo: { bazooka: Infinity, grenade: 0, shotgun: 0, dynamite: 0, medkit: 0, shield: 0 },
      wind: 0,
      timeLeft: 30,
      difficulty: { angleError: 0, powerError: 0 },
      rng: () => 0.5,
    });
    expect(plan).not.toBeNull();

    const impact = simulateShot(
      terrain(),
      shooter.x + Math.cos(plan!.angle) * 18,
      460 - 14 + Math.sin(plan!.angle) * 18,
      plan!.angle,
      plan!.power,
      'bazooka',
      0,
    );
    expect(Math.hypot(impact.x - target.x, impact.y - (target.y - 13))).toBeGreaterThan(
      WEAPONS.bazooka.radius + WORM.radius,
    );

    const engine = new GameEngine(config({ wormsPerTeam: 1 }));
    Object.assign(engine.terrain, terrain());
    engine.wind = 0;
    engine.endTurn();
    const worm = engine.activeWorm!;
    worm.x = 400;
    worm.y = 460;
    worm.vy = 0;
    worm.onGround = false;
    worm.aimAngle = plan!.angle;
    const enemy = engine.teams[0].worms[0];
    enemy.x = 900;
    enemy.y = 500;
    engine.power = plan!.power;
    engine.weapon = plan!.weapon;

    const internals = engine as unknown as { aiPlan: typeof plan; aiThinking: boolean };
    internals.aiPlan = { ...plan!, fireX: 400, fireY: 500 };
    internals.aiThinking = false;

    engine.update(DT);

    expect(engine.hasFired).toBe(false);
    expect(engine.debugLog.some((entry) => entry.category === 'ai.planInvalid')).toBe(true);
  });

  test('the AI keeps jumping while its walk is blocked', () => {
    const engine = new GameEngine(config());
    const blockedX = 1200;
    Object.assign(engine.terrain, terrain(blockedX));
    engine.endTurn();
    expect(engine.activeTeam).toBe(1);

    const worm = engine.activeWorm!;
    worm.y = 500;
    worm.vy = 0;
    worm.onGround = true;
    worm.fallDistance = 0;

    // A plan beyond the wall forces the AI to walk into it and stall.
    const internals = engine as unknown as {
      aiPlan: {
        weapon: 'bazooka';
        fireX: number;
        fireY: number;
        angle: number;
        power: number;
        retreatX: number;
      } | null;
      aiThinking: boolean;
    };
    internals.aiPlan = {
      weapon: 'bazooka',
      fireX: blockedX + 100,
      fireY: 500,
      angle: -0.5,
      power: 0.5,
      retreatX: worm.x,
    };
    internals.aiThinking = false;

    step(engine, 5.2);

    // Jumps are bounded; when the fallback cannot damage an enemy, the CPU
    // passes instead of firing into the wall.
    expect(engine.events.filter((event) => event.type === 'jump').length).toBeLessThanOrEqual(2);
    expect(engine.hasFired).toBe(false);
    expect(engine.debugLog.some((entry) => entry.category === 'ai.noFallbackShot')).toBe(true);
  });
});
