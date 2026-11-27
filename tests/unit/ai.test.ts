import { expect, test } from 'vitest';
import { aimPoint } from '../../src/game/aim';
import {
  chooseRetreat,
  clampAngle,
  firingPositions,
  planAiShot,
  planAiTurn,
  planRopeClimb,
  previewFlight,
  simulateShot,
} from '../../src/game/ai';
import { AIM, DIFFICULTY, JUMP_REACH, RETREAT_SECONDS, ROPE, WEAPONS, WORM } from '../../src/game/config';
import { GameEngine } from '../../src/game/engine';
import { Terrain } from '../../src/game/terrain';
import type { MatchConfig } from '../../src/game/types';
import { terrain } from './terrainFixture';

test('reticle sits on the fixed-radius circle in open air', () => {
  const point = aimPoint(terrain(), 400, 500, -0.5);
  expect(point.hitTerrain).toBe(false);
  const distance = Math.hypot(point.x - 400, point.y - (500 - 14));
  expect(distance).toBeCloseTo(AIM.radius, 0);
});

test('reticle stops on terrain inside the circle', () => {
  const point = aimPoint(terrain(440), 400, 500, -0.2);
  expect(point.hitTerrain).toBe(true);
  const distance = Math.hypot(point.x - 400, point.y - (500 - 14));
  expect(distance).toBeLessThan(AIM.radius);
});

test('reticle never leaves the radius, even aiming along the floor', () => {
  const point = aimPoint(terrain(), 1260, 500, -0.08);
  const distance = Math.hypot(point.x - 1260, point.y - (500 - 14));
  expect(distance).toBeLessThanOrEqual(AIM.radius + 1);
});

test('a shot stops on the first worm in its path', () => {
  const open = simulateShot(terrain(), 418, 486, 0, 1, 'shotgun', 0);
  const blocked = simulateShot(terrain(), 418, 486, 0, 1, 'shotgun', 0, null, false, [
    { x: 700, y: 500 },
  ]);
  expect(open.x).toBeGreaterThan(900);
  expect(blocked.x).toBeGreaterThan(660);
  expect(blocked.x).toBeLessThan(700);
  expect(blocked.valid).toBe(true);
});

const ammo = { bazooka: Infinity, grenade: 3, shotgun: 4, dynamite: 2, medkit: 2, shield: 1 } as const;

const plan = (wormX: number, enemyX: number) => {
  const worm = { id: 'a', teamId: 0, x: wormX, y: 500 };
  const enemy = { id: 'b', teamId: 1, x: enemyX, y: 500 };
  return planAiTurn({
    terrain: terrain(),
    worm,
    worms: [worm, enemy],
    ammo: { ...ammo },
    wind: 0,
    timeLeft: 45,
    difficulty: { angleError: 0, powerError: 0 },
    rng: () => 0.5,
  });
};

test('AI firing positions never require more than one jump', () => {
  // A 80 px step: too high to jump (the jump apex is about 58 px), but inside
  // the old 90 px window.
  const ledge = {
    isSolid: (x: number, y: number) => y >= (x >= 460 ? 420 : 500),
    groundY: (x: number, fromY: number, maxDown = 260) => {
      const top = x >= 460 ? 420 : 500;
      const start = Math.max(top, Math.ceil(fromY / 4) * 4);
      return start <= fromY + maxDown ? start : null;
    },
  };
  const positions = firingPositions(ledge, { id: 'a', teamId: 0, x: 400, y: 500 }, 400);

  expect(positions.length).toBeGreaterThan(0);
  for (const position of positions) {
    expect(500 - position.y).toBeLessThanOrEqual(JUMP_REACH);
  }
});

test('AI firing positions keep the ground under a shelf', () => {
  const shelf = {
    isSolid: (x: number, y: number) => y >= 500 || (x >= 300 && x <= 500 && y >= 300 && y <= 340),
    groundY: (x: number, fromY: number, maxDown = 260) => {
      const shelfTop = x >= 300 && x <= 500 ? 300 : 500;
      if (fromY <= shelfTop && fromY + maxDown >= shelfTop) return shelfTop;
      if (fromY <= 500 && fromY + maxDown >= 500) return 500;
      return null;
    },
  };
  const positions = firingPositions(shelf, { id: 'a', teamId: 0, x: 400, y: 500 }, 0, ROPE.range);

  expect(positions.some((position) => position.x === 400 && position.y === 500)).toBe(true);
  expect(positions.some((position) => position.x === 400 && position.y === 300)).toBe(false);
});

test('rope reach expands AI firing positions to high ledges', () => {
  const ledge = {
    isSolid: (x: number, y: number) => y >= (x >= 460 ? 420 : 500),
    groundY: (x: number, fromY: number, maxDown = 260) => {
      const top = x >= 460 ? 420 : 500;
      const start = Math.max(top, Math.ceil(fromY / 4) * 4);
      return start <= fromY + maxDown ? start : null;
    },
  };
  const positions = firingPositions(ledge, { id: 'a', teamId: 0, x: 400, y: 500 }, 400, ROPE.range);

  expect(positions.some((position) => position.y === 420)).toBe(true);
  expect(positions.every((position) => 500 - position.y <= ROPE.range)).toBe(true);
});

test('the AI finds a rope anchor above a ledge it cannot jump', () => {
  const wall = {
    isSolid: (_x: number, y: number) => y >= 500 || _x >= 520,
    groundY: (_x: number, fromY: number, maxDown = 260) =>
      fromY <= 500 && fromY + maxDown >= 500 ? 500 : null,
  };

  const plan = planRopeClimb(wall, { id: 'a', teamId: 0, x: 400, y: 500 }, 520, 420);

  expect(plan).not.toBeNull();
  expect(plan!.anchorX).toBeGreaterThanOrEqual(520);
  expect(plan!.anchorY).toBeLessThanOrEqual(400);
  expect(plan!.length).toBeLessThanOrEqual(ROPE.range);
});

test('the AI finds no rope anchor in open air or beyond range', () => {
  const open = { isSolid: () => false, groundY: () => null };
  expect(planRopeClimb(open, { id: 'a', teamId: 0, x: 400, y: 500 }, 520, 420)).toBeNull();

  const farWall = {
    isSolid: (x: number, y: number) => y >= 500 || x >= 900,
    groundY: (_x: number, fromY: number, maxDown = 260) =>
      fromY <= 500 && fromY + maxDown >= 500 ? 500 : null,
  };
  expect(planRopeClimb(farWall, { id: 'a', teamId: 0, x: 400, y: 500 }, 900, 420)).toBeNull();
});

const impactOf = (turn: NonNullable<ReturnType<typeof plan>>, targetX: number) => {
  const def = WEAPONS[turn.weapon];
  const impact = simulateShot(
    terrain(),
    turn.fireX + Math.cos(turn.angle) * 18,
    turn.fireY - 14 + Math.sin(turn.angle) * 18,
    turn.angle,
    turn.power,
    turn.weapon,
    0,
    def.fuse,
    def.bounces,
    [{ x: targetX, y: 500 }],
  );
  return impact.valid ? Math.hypot(impact.x - targetX, impact.y - (500 - 13)) : Infinity;
};

/** Flat ground at y = 500 with solid vertical walls spanning body height. */
const walled = (...walls: Array<[number, number]>) => ({
  isSolid: (x: number, y: number) => y >= 500 || walls.some(([from, to]) => x >= from && x <= to),
  groundY: (_x: number, fromY: number, maxDown = 260) =>
    fromY <= 500 && fromY + maxDown >= 500 ? 500 : null,
});

const enemy = { id: 'b', teamId: 1, x: 440, y: 500 };

test('the legacy fallback rejects a shot that only hits terrain', () => {
  const shooter = { id: 'a', teamId: 0, x: 400, y: 500 };
  const target = { id: 'b', teamId: 1, x: 200, y: 500 };
  const shot = planAiShot(walled([300, 360]), shooter, [shooter, target], 0, { angleError: 0, powerError: 0 }, () => 0.5);

  expect(shot).toBeNull();
});

test('the legacy fallback still finds a damaging shot in the open', () => {
  const shooter = { id: 'a', teamId: 0, x: 400, y: 500 };
  const target = { id: 'b', teamId: 1, x: 900, y: 500 };
  const shot = planAiShot(terrain(), shooter, [shooter, target], 0, { angleError: 0, powerError: 0 }, () => 0.5);

  expect(shot).not.toBeNull();
  const impact = simulateShot(
    terrain(),
    shooter.x + Math.cos(shot!.angle) * 18,
    shooter.y - 14 + Math.sin(shot!.angle) * 18,
    shot!.angle,
    shot!.power,
    'bazooka',
    0,
    null,
    false,
    [target],
  );
  expect(Math.hypot(impact.x - target.x, impact.y - (target.y - 13))).toBeLessThanOrEqual(
    WEAPONS.bazooka.radius + WORM.radius,
  );
});

test('the legacy fallback rejects rookie jitter that removes all damage', () => {
  const shooter = { id: 'a', teamId: 0, x: 100, y: 500 };
  const target = { id: 'b', teamId: 1, x: 500, y: 500 };
  expect(planAiShot(terrain(), shooter, [shooter, target], 0, { angleError: 0, powerError: 0 }, () => 0.5)).not.toBeNull();
  expect(planAiShot(terrain(), shooter, [shooter, target], 0, DIFFICULTY.rookie, () => 1)).toBeNull();
});

test('the AI rejects a plan when rookie jitter removes all damage', () => {
  const worm = { id: 'a', teamId: 0, x: 100, y: 500 };
  const target = { id: 'b', teamId: 1, x: 700, y: 500 };
  const input = {
    terrain: terrain(),
    worm,
    worms: [worm, target],
    ammo: { bazooka: Infinity, grenade: 0, shotgun: 0, dynamite: 0, medkit: 0, shield: 0 },
    wind: 0,
    timeLeft: 45,
  };
  expect(planAiTurn({ ...input, difficulty: { angleError: 0, powerError: 0 }, rng: () => 0.5 })).not.toBeNull();

  expect(planAiTurn({ ...input, difficulty: DIFFICULTY.rookie, rng: () => 1 })).toBeNull();
});

test('the aim preview traces an arc for a fuse-less weapon', () => {
  const points = previewFlight(terrain(), 400, 486, -0.6, 0.8, 'bazooka', 0);
  expect(points.length).toBeGreaterThan(3);
  expect(new Set(points.map((p) => `${p.x.toFixed(2)}:${p.y.toFixed(2)}`)).size).toBe(points.length);
});

test('a fused preview ends on the detonation point', () => {
  const points = previewFlight(terrain(), 400, 486, -0.6, 0.8, 'grenade', 0);
  const end = simulateShot(
    terrain(),
    400,
    486,
    -0.6,
    0.8,
    'grenade',
    0,
    WEAPONS.grenade.fuse,
    WEAPONS.grenade.bounces,
  );
  const last = points.at(-1)!;
  expect(Math.hypot(last.x - end.x, last.y - end.y)).toBeLessThan(3);
});

test('the aim clamp uses the configured limits', () => {
  expect(clampAngle(0)).toBe(AIM.max);
  expect(clampAngle(-Math.PI)).toBe(AIM.min);
});

test('the AI never retreats through a wall to escape its own blast', () => {
  // The best blast-safe spot is left of the wall, but the worm cannot get there.
  const spot = chooseRetreat(
    walled([300, 330]),
    { x: 400, y: 500 },
    [enemy],
    { x: 400, y: 492 },
    95,
    RETREAT_SECONDS,
  );
  expect(spot).not.toBeNull();
  expect(spot!).toBeGreaterThan(400);
});

test('the AI finds no retreat spot when every blast-safe spot is walled off', () => {
  const spot = chooseRetreat(
    walled([300, 330], [470, 500]),
    { x: 400, y: 500 },
    [enemy],
    { x: 400, y: 492 },
    95,
    RETREAT_SECONDS,
  );
  expect(spot).toBeNull();
});

test('AI picks a weapon and a firing spot whose real shot lands on the enemy', () => {
  const turn = plan(200, 900);
  expect(turn).not.toBeNull();
  expect(turn!.weapon).not.toBe('dynamite');
  expect(impactOf(turn!, 900)).toBeLessThan(70);
});

test('AI aims at an enemy on its left, not away from it', () => {
  const turn = plan(900, 200);
  expect(turn).not.toBeNull();
  expect(impactOf(turn!, 200)).toBeLessThan(70);
});

test('AI retreats away from the enemy after firing', () => {
  const turn = plan(200, 900);
  expect(turn).not.toBeNull();
  expect(Math.abs(turn!.retreatX - 900)).toBeGreaterThan(Math.abs(turn!.fireX - 900));
});

test('AI drops dynamite at point-blank only when it can escape the blast', () => {
  const turn = plan(400, 440);
  expect(turn).not.toBeNull();
  expect(turn!.weapon).toBe('dynamite');
  expect(Math.abs(turn!.retreatX - turn!.fireX)).toBeGreaterThan(
    WEAPONS.dynamite.radius + WORM.radius,
  );
});

test('AI scores dynamite self damage at its escape instead of the planting point', () => {
  const worm = { id: 'a', teamId: 0, x: 400, y: 500 };
  const target = { id: 'b', teamId: 1, x: 480, y: 500 };
  const bazookaAmmo = WEAPONS.bazooka.ammo;
  WEAPONS.bazooka.ammo = 0;
  try {
    const turn = planAiTurn({
      terrain: terrain(),
      worm,
      worms: [worm, target],
      ammo: { bazooka: 0, grenade: 0, shotgun: 0, dynamite: 1, medkit: 0, shield: 0 },
      wind: 0,
      timeLeft: 30,
      difficulty: { angleError: 0, powerError: 0 },
      rng: () => 0.5,
    });

    expect(turn).not.toBeNull();
    expect(turn!.weapon).toBe('dynamite');
  } finally {
    WEAPONS.bazooka.ammo = bazookaAmmo;
  }
});

test('AI scores projectile plans from the selected firing position', () => {
  const worm = { id: 'a', teamId: 0, x: 400, y: 500, hp: 100 };
  const target = { id: 'b', teamId: 1, x: 380, y: 500, hp: 100 };
  const turn = planAiTurn({
    terrain: terrain(),
    worm,
    worms: [worm, target],
    ammo: { bazooka: Infinity, grenade: 0, shotgun: 0, dynamite: 0, medkit: 0, shield: 0 },
    wind: 0,
    timeLeft: 3,
    difficulty: { angleError: 0, powerError: 0 },
    rng: () => 0.5,
  });

  // Moving right puts more distance between the shooter and the close-range blast.
  expect(turn).toMatchObject({ weapon: 'bazooka', fireX: 452, power: 0.4 });
  const impact = simulateShot(
    terrain(),
    turn!.fireX + Math.cos(turn!.angle) * 18,
    turn!.fireY - 14 + Math.sin(turn!.angle) * 18,
    turn!.angle,
    turn!.power,
    turn!.weapon,
    0,
    WEAPONS.bazooka.fuse,
    WEAPONS.bazooka.bounces,
    [target],
  );
  expect(Math.hypot(impact.x - target.x, impact.y - (target.y - 13))).toBeLessThanOrEqual(
    WEAPONS.bazooka.radius + WORM.radius,
  );
});

test('the AI skips its turn rather than shooting terrain with no reachable target', () => {
  // Turn 20 from report 8a5cb2ce-7aa1-4152-8130-c68fce744431.
  const worm = { id: 't1-w1', teamId: 1, x: 3734.8, y: 612, hp: 100 };
  const turn = planAiTurn({
    terrain: new Terrain(321884985),
    worm,
    worms: [
      { id: 't0-w0', teamId: 0, x: 1050.1666666666683, y: 584, hp: 100 },
      { id: 't0-w1', teamId: 0, x: 1280.2793875407722, y: 532, hp: 69 },
      { id: 't1-w0', teamId: 1, x: 3734.766666666648, y: 612, hp: 150 },
      worm,
    ],
    ammo: { bazooka: Infinity, grenade: 3, shotgun: 4, dynamite: 2, medkit: 2, shield: 0 },
    wind: -52,
    timeLeft: 16.666666666666856,
    difficulty: { angleError: 0, powerError: 0 },
    rng: () => 0.5,
  });

  expect(turn).toBeNull();
});

test('the AI never plans a shot through an ally', () => {
  const worm = { id: 'a', teamId: 0, x: 900, y: 500 };
  const ally = { id: 'c', teamId: 0, x: 600, y: 500 };
  const enemy = { id: 'b', teamId: 1, x: 200, y: 500 };
  const turn = planAiTurn({
    terrain: terrain(),
    worm,
    worms: [worm, ally, enemy],
    ammo: { ...ammo },
    wind: 0,
    timeLeft: 45,
    difficulty: { angleError: 0, powerError: 0 },
    rng: () => 0.5,
  });
  expect(turn).not.toBeNull();
  // The enemy is out of dynamite walking range, so the plan must be a projectile.
  expect(turn!.weapon).not.toBe('dynamite');

  const def = WEAPONS[turn!.weapon];
  const impact = simulateShot(
    terrain(),
    turn!.fireX + Math.cos(turn!.angle) * 18,
    500 - 14 + Math.sin(turn!.angle) * 18,
    turn!.angle,
    turn!.power,
    turn!.weapon,
    0,
    def.fuse,
    def.bounces,
    [ally, enemy],
  );
  expect(Math.hypot(impact.x - ally.x, impact.y - (ally.y - 13))).toBeGreaterThan(
    14 + WORM.radius * 0.4,
  );
});

test('the reported seeded no-plan stall jumps the crater ahead', () => {
  const config: MatchConfig = {
    turnSeconds: 20,
    wind: 'strong',
    difficulty: 'rookie',
    seed: 403416938,
    wormsPerTeam: 2,
    map: 'island',
    mode: 'deathmatch',
    loadout: 'default',
    hotseat: false,
    teamCount: 2,
  };
  const engine = new GameEngine(config);
  // Reproduce the crater that blocked the report's fallback look-ahead.
  engine.terrain.carve(3024, 552, 42);
  engine.mobs.splice(0);
  engine.loot.splice(0);
  engine.loot.push(
    { id: 1, x: 2376.3811716251075, y: 507, vx: 0, vy: 0, kind: 'mine', armed: false, fuse: 1.5, ammoGrant: 0 },
    { id: 2, x: 2426.64316046983, y: 515, vx: 0, vy: 0, kind: 'mine', armed: false, fuse: 1.5, ammoGrant: 0 },
  );
  const states = [
    { x: 1300.2224806012664, y: 312, hp: 95 },
    { x: 1267.4499111270925, y: 312, hp: 100 },
    { x: 3071.2333333334286, y: 552, hp: 150 },
    { x: 3071.2666666667783, y: 552, hp: 50 },
  ];
  for (const [teamIndex, team] of engine.teams.entries()) {
    for (const [wormIndex, worm] of team.worms.entries()) {
      const state = states[teamIndex * 2 + wormIndex];
      worm.x = state.x;
      worm.y = state.y;
      worm.hp = state.hp;
      worm.vy = 0;
      worm.vx = 0;
      worm.onGround = true;
      worm.fallDistance = 0;
    }
  }
  engine.teams[1].ammo = { bazooka: Infinity, grenade: 3, shotgun: 4, dynamite: 2, medkit: 2, shield: 0 };
  engine.wind = -56;
  engine.turn = 14;
  engine.timeLeft = 19.2;
  engine.activeTeam = 1;
  engine.activeWormId = 't1-w0';
  engine.aiThinking = true;
  const cpu = engine.activeWorm!;
  cpu.aimAngle = -2.5790465438906147;
  cpu.facing = -1;
  const startX = cpu.x;

  for (let i = 0; i < 5 * 60 && !engine.events.some((event) => event.type === 'jump'); i += 1) {
    engine.update(1 / 60);
  }
  for (let i = 0; i < 15; i += 1) engine.update(1 / 60);

  expect(engine.debugLog.some((entry) => entry.category === 'ai.noPlan')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.fallbackWalk')).toBe(true);
  expect(engine.debugLog.some((entry) => entry.category === 'ai.jump')).toBe(true);
  expect(cpu.x).toBeLessThan(startX - 10);
});
