import {
  AI,
  AIM,
  BOUNCE,
  GRAVITY,
  JUMP_REACH,
  PREVIEW_SECONDS,
  PROJECTILE_GRAVITY,
  RETREAT_SECONDS,
  ROPE,
  WATER_Y,
  WEAPON_ORDER,
  WEAPONS,
  WIND_ACCEL,
  WIND_FACTOR,
  WORM,
  WORLD_W,
} from './config';
import type { WeaponId } from './types';

/** The slice of Terrain a ballistic simulation needs. */
export interface ShotTerrain {
  isSolid(x: number, y: number): boolean;
}

/** The slice of Terrain a movement plan needs. */
export interface AiTerrain extends ShotTerrain {
  groundY(x: number, fromY: number, maxDown?: number): number | null;
}

export interface ShotPlan {
  angle: number;
  power: number;
}

export interface AiWorm {
  id: string;
  /** Real teams are >= 0; -1 marks a blast-only pseudo-target (e.g. a mob). */
  teamId: number;
  x: number;
  y: number;
  /** Current HP; optional for callers that don't carry it. */
  hp?: number;
}

/** Bodies that stop a simulated shot: real worms only. Mobs take blast damage but never stop a projectile, mirroring stepProjectiles. */
export function simBodies(worms: AiWorm[], shooter: AiWorm): AiWorm[] {
  return worms.filter((w) => w.id !== shooter.id && w.teamId >= 0);
}

export interface AiTurnPlan {
  weapon: WeaponId;
  /** Where the worm should stand before firing. */
  fireX: number;
  fireY: number;
  angle: number;
  power: number;
  /** Where the worm should walk once the shot is away. */
  retreatX: number;
}

export interface AiTurnInput {
  terrain: AiTerrain;
  worm: AiWorm;
  /** Alive worms only, including the actor. */
  worms: AiWorm[];
  ammo: Record<WeaponId, number>;
  wind: number;
  timeLeft: number;
  difficulty: { angleError: number; powerError: number };
  rng: () => number;
  /** Recent hurt position on our team; null when no revenge is active. */
  revengeFocus?: { x: number; y: number } | null;
  mines?: { x: number; y: number }[];
}

interface SimResult {
  x: number;
  y: number;
  valid: boolean;
}

interface Candidate {
  score: number;
  angle: number;
  power: number;
  retreatX: number;
}

/**
 * Forward-simulate a projectile with the exact combat constants so the AI
 * (and the aim preview) never diverge from the real physics.
 */
export function simulateShot(
  terrain: ShotTerrain,
  startX: number,
  startY: number,
  angle: number,
  power: number,
  weapon: WeaponId,
  wind: number,
  fuse: number | null = null,
  bounces = false,
  bodies: ReadonlyArray<{ x: number; y: number }> = [],
): SimResult {
  const def = WEAPONS[weapon];
  const speed = def.speedMin + (def.speedMax - def.speedMin) * power;

  let x = startX;
  let y = startY;
  let vx = Math.cos(angle) * speed;
  let vy = Math.sin(angle) * speed;
  const dt = 1 / 60;

  for (let t = 0; t < 5; t += dt) {
    if (fuse !== null && t >= fuse) return { x, y, valid: true };
    vy += PROJECTILE_GRAVITY * def.gravityScale * dt;
    vx += wind * def.windScale * WIND_FACTOR * dt;
    x += vx * dt;
    y += vy * dt;
    // Match the engine: the first worm in the path takes the hit.
    if (bodies.some((b) => Math.hypot(b.x - x, b.y - 13 - y) < 14 + WORM.radius * 0.4)) {
      return { x, y, valid: y < WATER_Y - 12 };
    }
    if (x < 0 || x > WORLD_W || y > WATER_Y) return { x, y, valid: false };
    if (terrain.isSolid(x, y)) {
      if (!bounces) return { x, y, valid: y < WATER_Y - 12 };
      if (terrain.isSolid(x - vx * dt, y)) {
        vx = -vx * BOUNCE.x;
      } else if (terrain.isSolid(x, y - vy * dt)) {
        vy = -vy * BOUNCE.y;
      } else {
        vx = -vx * BOUNCE.x;
        vy = -vy * BOUNCE.y;
      }
      x -= vx * dt;
      y -= vy * dt;
    }
    if (def.life !== null && t >= def.life) return { x, y, valid: true };
  }
  return { x, y, valid: false };
}

/**
 * Sample a shot's path for the dotted aim preview. Each point runs the shared
 * integrator up to its own slice of the weapon's horizon, so a fuse-less
 * weapon traces an arc instead of collapsing every dot on its impact point.
 */
export function previewFlight(
  terrain: AiTerrain,
  startX: number,
  startY: number,
  angle: number,
  power: number,
  weapon: WeaponId,
  wind: number,
  steps = 16,
): Array<{ x: number; y: number }> {
  const def = WEAPONS[weapon];
  const horizon = def.fuse ?? def.life ?? PREVIEW_SECONDS;
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= steps; i += 1) {
    const point = simulateShot(
      terrain,
      startX,
      startY,
      angle,
      power,
      weapon,
      wind,
      (horizon * i) / steps,
      def.bounces,
    );
    const previous = points[points.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 2) continue;
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

export interface AiShotCheck {
  terrain: AiTerrain;
  shooter: AiWorm;
  worms: AiWorm[];
  weapon: WeaponId;
  angle: number;
  power: number;
  wind: number;
  revengeFocus?: { x: number; y: number } | null;
  retreatX?: number | null;
}

/** True when the final shot can damage an enemy without breaking the friendly-fire veto. */
export function isUsefulAiShot({
  terrain,
  shooter,
  worms,
  weapon,
  angle,
  power,
  wind,
  revengeFocus = null,
  retreatX = null,
}: AiShotCheck): boolean {
  const def = WEAPONS[weapon];
  if (def.kind === 'utility') return true;
  let scoringWorms = worms;
  if (def.kind === 'drop') {
    if (retreatX === null) return false;
    const escapeWorms = dropEscapeWorms(terrain, shooter, worms, retreatX);
    if (!escapeWorms) return false;
    scoringWorms = escapeWorms;
  }
  const bodies = simBodies(worms, shooter);
  const impact = def.kind === 'drop'
    ? { x: shooter.x, y: shooter.y - 8, valid: true }
    : simulateShot(
        terrain,
        shooter.x + Math.cos(angle) * 18,
        shooter.y - 14 + Math.sin(angle) * 18,
        angle,
        power,
        weapon,
        wind,
        def.fuse,
        def.bounces,
        bodies,
      );
  if (!impact.valid) return false;
  const coll = collateral(impact.x, impact.y, weapon, shooter, scoringWorms);
  if (AI.friendlyFireVeto && coll.ally > AI.friendlyFireTolerance) return false;
  return damageScore(impact.x, impact.y, weapon, shooter, scoringWorms, revengeFocus) > 0;
}

/**
 * Legacy single-shot solver: best bazooka (angle, power) from a fixed spot.
 * Used as the fallback when the AI cannot walk to its planned position.
 */
export function planAiShot(
  terrain: AiTerrain,
  shooter: AiWorm,
  worms: AiWorm[],
  wind: number,
  difficulty: { angleError: number; powerError: number },
  rng: () => number,
): ShotPlan | null {
  const enemies = worms.filter((w) => w.id !== shooter.id && w.teamId !== shooter.teamId);
  const target = enemies.reduce<AiWorm | null>((nearest, enemy) => {
    if (!nearest) return enemy;
    return Math.hypot(enemy.x - shooter.x, enemy.y - shooter.y) < Math.hypot(nearest.x - shooter.x, nearest.y - shooter.y)
      ? enemy
      : nearest;
  }, null);
  if (!target) return null;
  const wormX = shooter.x;
  const wormY = shooter.y;
  const bodies = simBodies(worms, shooter);
  const facingLeft = target.x < wormX;
  const base = facingLeft ? -Math.PI : 0;
  // Angles grow from -π (left) to -0.08 (right), so left-facing adds and right-facing subtracts.
  const mirror = facingLeft ? 1 : -1;
  const offsets = [0.22, 0.5, 0.75, 1.0, 1.22, 1.42];
  let best: { score: number; angle: number; power: number } | null = null;

  for (const offset of offsets) {
    for (let power = 0.4; power <= 1.001; power += 0.06) {
      const angle = base + mirror * offset;
      const startX = wormX + Math.cos(angle) * 18;
      const startY = wormY - 14 + Math.sin(angle) * 18;
      const result = simulateShot(terrain, startX, startY, angle, power, 'bazooka', wind, null, false, bodies);
      if (!result.valid) continue;
      const coll = collateral(result.x, result.y, 'bazooka', shooter, worms);
      if (AI.friendlyFireVeto && coll.ally > AI.friendlyFireTolerance) continue;
      const score = damageScore(result.x, result.y, 'bazooka', shooter, worms);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { score, angle, power };
    }
  }

  if (!best) return null;

  const jitterAngle = (rng() * 2 - 1) * difficulty.angleError;
  const jitterPower = (rng() * 2 - 1) * difficulty.powerError;
  const shot = {
    angle: clampAngle(best.angle + jitterAngle),
    power: Math.min(1, Math.max(0.25, best.power + jitterPower)),
  };
  return isUsefulAiShot({
    terrain,
    shooter,
    worms,
    weapon: 'bazooka',
    angle: shot.angle,
    power: shot.power,
    wind,
  }) ? shot : null;
}

/**
 * Plan a whole AI turn: choose the weapon, the spot to fire from and the spot
 * to retreat to. Every weapon is evaluated with the real physics; damage to
 * enemies is weighed against damage to allies and the shooter.
 */
export function planAiTurn(input: AiTurnInput): AiTurnPlan | null {
  const { terrain, worm, worms, ammo, wind, timeLeft, difficulty, rng, revengeFocus = null, mines = [] } = input;
  const enemies = worms.filter((w) => w.teamId !== worm.teamId);
  if (enemies.length === 0) return null;

  // Do not spend the whole turn walking: leave time to aim and fire.
  const moveBudget = Math.min(5, Math.max(0, timeLeft - 2)) * WORM.walkSpeed;
  // The rope extends the AI's climb beyond a jump.
  const positions = firingPositions(terrain, worm, moveBudget, ROPE.range).filter((p) => !mines.some((m) => Math.hypot(m.x - p.x, m.y - p.y) < 90));

  let best: (Candidate & { weapon: WeaponId; fireX: number; fireY: number }) | null = null;

  for (const weapon of WEAPON_ORDER) {
    const def = WEAPONS[weapon];
    if (def.ammo !== null && ammo[weapon] <= 0) continue;
    for (const pos of positions) {
      let candidate: Candidate | null = null;
    if (def.kind === 'utility') {
      // Utility only makes sense in place; heal if wounded, shield if healthy-ish.
      const needHeal = (worm.hp ?? WORM.maxHp) < WORM.maxHp * 0.5 && (def.heal ?? 0) > 0;
      const needShield = (def.shield ?? 0) > 0;
      if (needHeal || needShield) {
        candidate = {
          score: needHeal ? 60 : 30,
          angle: (enemies[0]?.x ?? pos.x) < pos.x ? mirrorAngle(-0.5) : -0.5,
          power: 0.5,
          retreatX: pos.x,
        };
      }
    } else {
      candidate =
        def.kind === 'drop'
          ? planDrop(terrain, weapon, pos, worm, worms, enemies, revengeFocus)
          : planProjectile(terrain, weapon, pos, worm, worms, enemies, wind, revengeFocus);
    }
      if (!candidate) continue;
      // Prefer a short walk when two plans do the same damage.
      candidate.score -= (Math.abs(pos.x - worm.x) / WORM.walkSpeed) * 0.4;
      if (!best || candidate.score > best.score) {
        best = { ...candidate, weapon, fireX: pos.x, fireY: pos.y };
      }
    }
  }

  if (!best) return null;

  // Drops are placed, not aimed: error jitter would move a shot that has no direction.
  const isDrop = WEAPONS[best.weapon].kind === 'drop';
  const jitterAngle = isDrop ? 0 : (rng() * 2 - 1) * difficulty.angleError;
  const jitterPower = isDrop ? 0 : (rng() * 2 - 1) * difficulty.powerError;

  const plan = {
    weapon: best.weapon,
    fireX: best.fireX,
    fireY: best.fireY,
    angle: clampAngle(best.angle + jitterAngle),
    power: Math.min(1, Math.max(0.25, best.power + jitterPower)),
    retreatX: best.retreatX,
  };
  if (WEAPONS[plan.weapon].kind === 'utility') return plan;
  const firingWorm = { ...worm, x: plan.fireX, y: plan.fireY };
  const scoringWorms = worms.map((w) => w.id === worm.id ? firingWorm : w);
  return isUsefulAiShot({
    terrain,
    shooter: firingWorm,
    worms: scoringWorms,
    weapon: plan.weapon,
    angle: plan.angle,
    power: plan.power,
    wind,
    revengeFocus,
    retreatX: plan.retreatX,
  })
    ? plan
    : null;
}

export interface RopeClimbPlan {
  angle: number;
  anchorX: number;
  anchorY: number;
  length: number;
}

/**
 * Pick an aim angle whose ray hits terrain above `targetY`, so the CPU can
 * rope over a ledge that is higher than a jump.
 */
export function planRopeClimb(
  terrain: AiTerrain,
  worm: AiWorm,
  targetX: number,
  targetY: number,
  range = ROPE.range,
): RopeClimbPlan | null {
  const originY = worm.y - 14;
  const facingRight = targetX >= worm.x;
  const base = facingRight ? 0 : -Math.PI;
  const mirror = facingRight ? -1 : 1;
  let best: (RopeClimbPlan & { score: number }) | null = null;

  for (let offset = 0.25; offset <= 1.45; offset += 0.05) {
    const angle = clampAngle(base + mirror * offset);
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    for (let distance = 12; distance <= range; distance += 4) {
      const x = worm.x + dirX * distance;
      const y = originY + dirY * distance;
      if (!terrain.isSolid(x, y)) continue;
      // The anchor must sit above the landing surface and above the worm.
      if (y > targetY - 20 || y > worm.y - 30) break;
      const score = Math.abs(x - targetX) + Math.max(0, targetY - 20 - y) * 0.15;
      if (!best || score < best.score) {
        best = { angle, anchorX: x, anchorY: y, length: distance, score };
      }
      break;
    }
  }

  return best
    ? { angle: best.angle, anchorX: best.anchorX, anchorY: best.anchorY, length: best.length }
    : null;
}

export function firingPositions(
  terrain: AiTerrain,
  worm: AiWorm,
  budget: number,
  maxClimb = JUMP_REACH,
): Array<{ x: number; y: number }> {
  const xs = new Set<number>([worm.x]);
  for (let offset = 50; offset <= budget + 50; offset += 50) {
    xs.add(worm.x - offset);
    xs.add(worm.x + offset);
  }

  const positions: Array<{ x: number; y: number }> = [];
  // Start above the highest pixel the worm can climb; a column that is already
  // solid there is a cliff beyond reach.
  const scanTop = Math.max(0, worm.y - maxClimb - 12);
  for (const rawX of xs) {
    if (rawX < 20 || rawX > WORLD_W - 20) continue;
    const x = Math.round(rawX / 4) * 4;
    const top = terrain.groundY(x, scanTop, WATER_Y - scanTop);
    if (top === null || top > WATER_Y - 30) continue;
    // A shelf above the worm is not the ground it walks on; keep the surface
    // below its feet when the column at the top is an overhang.
    let ground = top;
    if (top < worm.y - 8) {
      const under = terrain.groundY(x, worm.y - 18, WATER_Y - (worm.y - 18));
      if (under !== null && under >= worm.y - 8 && under <= WATER_Y - 30) ground = under;
    }
    // Walkable ground only: no water, no cliff above reach, no damaging drop.
    if (worm.y - ground > maxClimb || ground - worm.y > WORM.fallSafePx) continue;
    positions.push({ x, y: ground });
  }
  return positions.sort((a, b) => Math.abs(a.x - worm.x) - Math.abs(b.x - worm.x));
}

function planProjectile(
  terrain: AiTerrain,
  weapon: WeaponId,
  pos: { x: number; y: number },
  worm: AiWorm,
  worms: AiWorm[],
  enemies: AiWorm[],
  wind: number,
  revengeFocus: { x: number; y: number } | null = null,
): Candidate | null {
  const def = WEAPONS[weapon];
  const target = enemies.reduce((nearest, enemy) => {
    const d = Math.hypot(enemy.x - pos.x, enemy.y - pos.y);
    return d < nearest.d ? { enemy, d } : nearest;
  }, { enemy: enemies[0], d: Infinity }).enemy;
  const facingLeft = target.x < pos.x;
  const base = facingLeft ? -Math.PI : 0;
  // Angles grow from -π (left) to -0.08 (right), so left-facing adds and right-facing subtracts.
  const mirror = facingLeft ? 1 : -1;
  const offsets = [0.22, 0.5, 0.75, 1.0, 1.22, 1.42];
  const retreatX = chooseRetreat(terrain, pos, enemies, null, 0, RETREAT_SECONDS) ?? pos.x;
  const bodies = simBodies(worms, worm);
  const firingWorm = { ...worm, x: pos.x, y: pos.y };
  const scoringWorms = worms.map((w) => w.id === worm.id ? firingWorm : w);
  let best: Candidate | null = null;

  for (const offset of offsets) {
    const angle = clampAngle(base + mirror * offset);
    const powers = weapon === 'shotgun' ? [1] : range(0.4, 1, 0.06);
    for (const power of powers) {
      const muzzleX = pos.x + Math.cos(angle) * 18;
      const muzzleY = pos.y - 14 + Math.sin(angle) * 18;
      const result = simulateShot(terrain, muzzleX, muzzleY, angle, power, weapon, wind, def.fuse, def.bounces, bodies);
      if (!result.valid) continue;
      const coll = collateral(result.x, result.y, weapon, firingWorm, scoringWorms);
      // Friendly-fire veto: skip shots that would hurt allies/self beyond tolerance.
      if (AI.friendlyFireVeto && coll.ally > AI.friendlyFireTolerance) continue;
      const score = damageScore(result.x, result.y, weapon, firingWorm, scoringWorms, revengeFocus);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = { score, angle, power, retreatX };
      }
    }
  }
  // Fallback: if every candidate was vetoed, take the least harmful shot.
  if (!best) {
    for (const offset of offsets) {
      const angle = clampAngle(base + mirror * offset);
      const powers = weapon === 'shotgun' ? [1] : range(0.4, 1, 0.06);
      for (const power of powers) {
        const muzzleX = pos.x + Math.cos(angle) * 18;
        const muzzleY = pos.y - 14 + Math.sin(angle) * 18;
        const result = simulateShot(terrain, muzzleX, muzzleY, angle, power, weapon, wind, def.fuse, def.bounces, bodies);
        if (!result.valid) continue;
        const score = damageScore(result.x, result.y, weapon, firingWorm, scoringWorms, revengeFocus);
        if (score <= 0) continue;
        if (!best || score > best.score) {
          best = { score, angle, power, retreatX };
        }
      }
    }
  }
  return best;
}

function planDrop(
  terrain: AiTerrain,
  weapon: WeaponId,
  pos: { x: number; y: number },
  worm: AiWorm,
  worms: AiWorm[],
  enemies: AiWorm[],
  revengeFocus: { x: number; y: number } | null = null,
): Candidate | null {
  const def = WEAPONS[weapon];
  const blast = { x: pos.x, y: pos.y - 8 };
  const safety = def.radius + WORM.radius + 6;
  const retreatX = chooseRetreat(terrain, pos, enemies, blast, safety, def.fuse ?? RETREAT_SECONDS);
  // Never plant a drop without a way out of its own blast.
  if (retreatX === null) return null;
  const firingWorm = { ...worm, x: pos.x, y: pos.y };
  const scoringWorms = dropEscapeWorms(terrain, firingWorm, worms, retreatX);
  if (!scoringWorms) return null;
  const coll = collateral(blast.x, blast.y, weapon, firingWorm, scoringWorms);
  if (AI.friendlyFireVeto && coll.ally > AI.friendlyFireTolerance) return null;
  const target = enemies.reduce((nearest, enemy) => {
    const d = Math.hypot(enemy.x - pos.x, enemy.y - pos.y);
    return d < nearest.d ? { enemy, d } : nearest;
  }, { enemy: enemies[0], d: Infinity }).enemy;
  const score = damageScore(blast.x, blast.y, weapon, firingWorm, scoringWorms, revengeFocus);
  if (score <= 0) return null;
  return {
    score,
    // Drops ignore the angle in flight, but the worm and its weapon should face the enemy.
    angle: target.x < pos.x ? mirrorAngle(-0.5) : -0.5,
    power: 0.5,
    retreatX,
  };
}

/** Score drop self-damage where the validated escape leaves the shooter. */
function dropEscapeWorms(
  terrain: AiTerrain,
  shooter: AiWorm,
  worms: AiWorm[],
  retreatX: number,
): AiWorm[] | null {
  const retreatY = terrain.groundY(retreatX, shooter.y - 80, 200);
  if (retreatY === null || retreatY > WATER_Y - 30 || Math.abs(retreatY - shooter.y) > 120) return null;
  return worms.map((w) => w.id === shooter.id ? { ...w, x: retreatX, y: retreatY } : w);
}

/** Ally/self damage a shot would deal (for friendly-fire veto). */
function collateral(x: number, y: number, weapon: WeaponId, shooter: AiWorm, worms: AiWorm[]): { ally: number; self: number } {
  const def = WEAPONS[weapon];
  const reach = def.radius + WORM.radius;
  let ally = 0;
  let self = 0;
  for (const w of worms) {
    const distance = Math.hypot(w.x - x, w.y - 13 - y);
    const amount =
      weapon === 'shotgun'
        ? distance < 14 + WORM.radius * 0.4
          ? def.damage
          : 0
        : distance <= reach
          ? def.damage * Math.max(0.22, 1 - distance / reach)
          : 0;
    if (amount <= 0) continue;
    if (w.id === shooter.id) self += amount;
    else if (w.teamId === shooter.teamId) ally += amount;
  }
  return { ally, self };
}

/** Blast distance to a target: mobs use their center, worms their chest (mirrors blast()). */
function blastDist(w: AiWorm, x: number, y: number): number {
  return w.teamId === -1 ? Math.hypot(w.x - x, w.y - y) : Math.hypot(w.x - x, w.y - 13 - y);
}

/** Blast reach for a target: mobs check against the bare radius (mirrors blast()). */
function blastReach(w: AiWorm, radius: number): number {
  return w.teamId === -1 ? radius : radius + WORM.radius;
}

/** Damage to enemies minus a penalty for friendly and self damage. */
function damageScore(
  x: number,
  y: number,
  weapon: WeaponId,
  shooter: AiWorm,
  worms: AiWorm[],
  revengeFocus: { x: number; y: number } | null = null,
): number {
  const def = WEAPONS[weapon];
  let enemy = 0;
  let ally = 0;
  let self = 0;

  const enemies = worms.filter((w) => w.teamId !== shooter.teamId);
  // Focus fire: prefer the lowest-HP enemy when HP is known.
  let focusTarget: AiWorm | null = null;
  if (enemies.some((w) => typeof w.hp === 'number')) {
    focusTarget = enemies.reduce<AiWorm | null>((acc, w) => {
      if (acc === null) return w;
      return (w.hp ?? Infinity) < (acc.hp ?? Infinity) ? w : acc;
    }, null);
  } else {
    // Fallback: nearest enemy to impact.
    let nearestDist = Infinity;
    for (const w of enemies) {
      const d = blastDist(w, x, y);
      if (d < nearestDist) { nearestDist = d; focusTarget = w; }
    }
  }
  let nearestEnemy: AiWorm | null = focusTarget;
  let nearestDist = focusTarget ? blastDist(focusTarget, x, y) : Infinity;

  const allies = worms.filter((w) => w.teamId === shooter.teamId);

  for (const w of worms) {
    // Shotgun pellets only ever hurt worms (no blast); mobs take blast damage only.
    if (weapon === 'shotgun' && w.teamId === -1) continue;
    const distance = blastDist(w, x, y);
    const reach = blastReach(w, def.radius);
    const amount =
      weapon === 'shotgun'
        ? distance < 14 + WORM.radius * 0.4
          ? def.damage
          : 0
        : distance <= reach
          ? def.damage * Math.max(0.22, 1 - distance / reach)
          : 0;
    if (amount <= 0) continue;
    if (w.teamId !== shooter.teamId) enemy += amount;
    else if (w.id === shooter.id) self += amount;
    else ally += amount;
  }
  if (enemy <= 0) return 0;

  let score = enemy - ally * 0.9 - self * 0.85;

  // Focus fire bonus: reward landing on the nearest enemy (concentrate damage).
  if (nearestEnemy && nearestDist <= blastReach(nearestEnemy, def.radius)) score += AI.focusFireBonus;

  // Threat bonus: reward hitting an enemy that can reach our worms.
  if (allies.length > 0) {
    for (const w of enemies) {
      const toAlly = Math.min(...allies.map((a) => Math.hypot(w.x - a.x, w.y - a.y)));
      if (toAlly <= AI.threatRadius && blastDist(w, x, y) <= blastReach(w, def.radius)) {
        score += AI.threatBonus;
        break;
      }
    }
  }

  // Revenge bonus: bias toward the position where an ally was hurt.
  if (revengeFocus) {
    const d = Math.hypot(x - revengeFocus.x, y - revengeFocus.y);
    const r = 260;
    if (d <= r) score += AI.revengeBonus * (1 - d / r);
  }

  return score;
}

/**
 * Best walkable spot within the window, away from the enemy and (when given)
 * outside a blast. Returns null when no spot satisfies the blast constraint.
 */
export function chooseRetreat(
  terrain: AiTerrain,
  from: { x: number; y: number },
  enemies: AiWorm[],
  blast: { x: number; y: number } | null,
  minBlastDistance: number,
  seconds: number,
): number | null {
  const reach = Math.max(0, seconds) * WORM.walkSpeed;
  let bestX: number | null = null;
  let bestScore = -Infinity;

  for (let offset = -reach; offset <= reach; offset += 24) {
    const x = Math.round(Math.min(WORLD_W - 20, Math.max(20, from.x + offset)) / 4) * 4;
    const ground = terrain.groundY(x, from.y - 80, 200);
    if (ground === null || ground > WATER_Y - 30 || Math.abs(ground - from.y) > 120) continue;

    const blastDistance = blast ? Math.hypot(x - blast.x, ground - 13 - blast.y) : Infinity;
    if (blastDistance < minBlastDistance) continue;
    if (!walkablePath(terrain, from, x)) continue;

    const enemyDistance = enemies.length
      ? Math.min(...enemies.map((e) => Math.hypot(x - e.x, ground - 13 - e.y)))
      : 0;
    const highGround = (WATER_Y - ground) * 0.06;
    const score = Math.min(enemyDistance, 420) + (blast ? Math.min(blastDistance, 320) * 0.5 : 0) + highGround;

    if (score > bestScore) {
      bestScore = score;
      bestX = x;
    }
  }

  return bestX;
}

/**
 * True when the worm can walk from `from` to `toX` without hitting a wall or
 * dropping into water. Checks the body height the engine walks at.
 */
function walkablePath(terrain: AiTerrain, from: { x: number; y: number }, toX: number): boolean {
  const dir = Math.sign(toX - from.x);
  let y = from.y;
  for (let x = from.x; dir !== 0 && (dir > 0 ? x < toX : x > toX); ) {
    x = dir > 0 ? Math.min(x + 4, toX) : Math.max(x - 4, toX);
    // shortcut: a ledge counts as blocked rather than measuring the fall, so
    // the AI may skip a safe drop-down retreat; revisit with a real walk sim.
    const ground = terrain.groundY(x, y - 18, 260);
    if (ground === null || ground > WATER_Y - 30) return false;
    if (terrain.isSolid(x, ground - 12)) return false;
    y = ground;
  }
  return true;
}

function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) values.push(Number(value.toFixed(2)));
  return values;
}

export function mirrorAngle(angle: number): number {
  return -Math.PI - angle;
}

export function clampAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return Math.min(AIM.max, Math.max(AIM.min, a));
}

/** Keep the fall math shared between worms and projectiles. */
export const PHYSICS = { gravity: GRAVITY, waterY: WATER_Y, windAccel: WIND_ACCEL, worm: WORM };
