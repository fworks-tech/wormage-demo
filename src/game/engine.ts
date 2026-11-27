import {
  AI,
  AIM,
  BOUNCE,
  CHARGE_SECONDS,
  DIFFICULTY,
  GRAVITY,
  JUMP_REACH,
  LOOT,
  MOB,
  PROJECTILE_GRAVITY,
  RETREAT_SECONDS,
  ROPE,
  TEAM_PALETTE,
  WATER_Y,
  WEAPONS,
  WIND_ACCEL,
  WIND_FACTOR,
  WORM,
  WORLD_W,
  worldClamp,
} from './config';
import { Terrain, mulberry32 } from './terrain';
import { clampAngle, isUsefulAiShot, mirrorAngle, planAiShot, planAiTurn, planRopeClimb } from './ai';
import type { AiTurnPlan } from './ai';
import { configKey } from './types';
import type {
  ActionLogEntry,
  DebugLogEntry,
  EndReason,
  GameAction,
  GameEvent,
  GameSnapshot,
  MatchConfig,
  Phase,
  Projectile,
  Team,
  WeaponId,
  Worm,
} from './types';

export { WEAPONS } from './config';

const WORM_NAMES = [
  ['Sarge', 'Biscuit', 'Mags'],
  ['Crank', 'Nyx', 'Dust'],
  ['Pip', 'Rook', 'Tansy'],
  ['Bramble', 'Quill', 'Hodge'],
];

/** Blast damage at a distance: linear falloff, floored at 22% inside the radius. */
export function blastFalloff(distance: number, radius: number): number {
  return Math.max(0.22, 1 - distance / radius);
}

interface LootItem {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: 'ammo' | 'mine' | 'secret';
  armed: boolean;
  fuse: number;
  ammoGrant: number;
}

interface Mob {
  id: number;
  x: number;
  y: number;
  vy: number;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  radius: number;
  alive: boolean;
  moveDir: -1 | 0 | 1;
  moveLeft: number;
}

export class GameEngine {
  readonly config: MatchConfig;
  readonly terrain: Terrain;
  readonly teams: Team[];
  phase: Phase = 'aim';
  turn = 1;
  /** Fixed steps taken so far. Inputs are replayed against this counter. */
  tick = 0;
  readonly log: ActionLogEntry[] = [];
  activeTeam = 0;
  activeWormId: string | null = null;
  wind = 0;
  timeLeft: number;
  power = 0;
  charging = false;
  weapon: WeaponId = 'bazooka';
  moveDir: -1 | 0 | 1 = 0;
  reelDir: -1 | 0 | 1 = 0;
  events: GameEvent[] = [];
  winnerTeam: number | null = null;
  endReason: EndReason | null = null;
  hasFired = false;
  kills: number[] = [];
  readonly sessionId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  readonly matchId = `M-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  debugLog: DebugLogEntry[] = [];
  private debugSeq = 0;
  private readonly debugLogLimit = 5000;
  debugSnapshots: Array<{ reason: string; snapshot: GameSnapshot }> = [];
  private readonly debugSnapshotLimit = 200;
  private aiBlockedLogged = false;
  elapsed = 0;
  aiThinking = false;
  retreatTimer = 0;

  private projectiles: Projectile[] = [];
  private settleTimer = 0;
  private aiTimer = 0;
  private aiPlan: AiTurnPlan | null = null;
  private aiStall = 0;
  private aiLastX = -1;
  private aiJumpDeadline: number | null = null;
  private aiRopeDeadline: number | null = null;
  private aiJumpCount = 0;
  private aiRopeCount = 0;
  /** No-plan fallback: walk target while closing distance for a later retry. */
  private aiFallbackX: number | null = null;
  private aiFallbackRetry = 0;
  private projectileId = 0;
  private revengeFocusByTeam: Record<number, { x: number; y: number } | null> = {};
  private revengeTurnsByTeam: Record<number, number> = {};
  private readonly rng: () => number;
  loot: LootItem[] = [];
  mobs: Mob[] = [];
  private mobId = 0;
  private lootId = 0;
  private readonly lastWormByTeam: Record<number, string> = {};

  constructor(config: MatchConfig) {
    this.config = config;
    this.terrain = new Terrain(config.seed, config.map);
    this.rng = mulberry32(config.seed ^ 0x9e3779b9);
    this.timeLeft = config.turnSeconds;

    const teamCount = Math.min(4, Math.max(2, config.teamCount ?? 2));
    const margin = 120;
    const usable = WORLD_W - margin * 2;
    const bandW = usable / teamCount;
    const deathmatchCpu =
      (config.mode ?? 'deathmatch') === 'deathmatch' &&
      teamCount === 2 &&
      !(config.hotseat ?? false);
    // Bands are ordered left-to-right by team index; worms inside a band march left-to-right.
    this.teams = Array.from({ length: teamCount }, (_, teamIndex) => {
      const palette = TEAM_PALETTE[teamIndex];
      const bandStart = margin + teamIndex * bandW;
      const worms: Worm[] = [];
      const spacing = Math.min(95, Math.max(40, (bandW - 40) / Math.max(1, config.wormsPerTeam - 1)));
      const bandCenter = bandStart + bandW / 2;
      const facing: 1 | -1 = bandCenter < WORLD_W / 2 ? 1 : -1;
      // Keep the standard CPU beyond the central mob encounter; other layouts retain their bands.
      const spawnStart = deathmatchCpu && teamIndex === 1
        ? WORLD_W - margin - (config.wormsPerTeam - 1) * spacing
        : bandStart + 40;
      for (let i = 0; i < config.wormsPerTeam; i += 1) {
        const x = Math.round(spawnStart + i * spacing);
        const y = this.terrain.groundY(x, 120, WATER_Y - 120) ?? 470;
        worms.push({
          id: `t${teamIndex}-w${i}`,
          name: WORM_NAMES[teamIndex % WORM_NAMES.length][i % WORM_NAMES[teamIndex % WORM_NAMES.length].length],
          teamId: teamIndex,
          x,
          y,
          vy: 0,
          vx: 0,
          hp: WORM.maxHp,
          maxHp: WORM.maxHp,
          alive: true,
          facing,
          aimAngle: facing === 1 ? -0.55 : mirrorAngle(-0.55),
          onGround: true,
          fallDistance: 0,
          rope: null,
          launched: false,
          rotation: 0,
          spin: 0,
        });
      }
      const isAi = teamIndex === 0 ? false : teamIndex === 1 ? !(config.hotseat ?? false) : true;
      const name = config.teamNames?.[teamIndex]?.trim() || palette.name;
      return {
        id: teamIndex,
        name,
        color: palette.color,
        accent: palette.accent,
        isAi,
        worms,
        ammo: {
          bazooka: WEAPONS.bazooka.ammo ?? Infinity,
          grenade: WEAPONS.grenade.ammo ?? 0,
          shotgun: WEAPONS.shotgun.ammo ?? 0,
          dynamite: WEAPONS.dynamite.ammo ?? 0,
          medkit: WEAPONS.medkit.ammo ?? 0,
          shield: WEAPONS.shield.ammo ?? 0,
        },
      };
    });
    this.kills = this.teams.map(() => 0);

    // Spawn after the teams so loot and mobs can stay clear of worm spawns.
    this.spawnLoot();
    this.spawnMobs();
    this.logDebug('loot.spawn', 'Loot spawned', { items: this.loot.map((l) => ({ id: l.id, x: Math.round(l.x), y: Math.round(l.y), kind: l.kind })) }, 'system');
    this.logDebug('mob.spawn', 'Mobs spawned', { mobs: this.mobs.map((m) => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y), hp: m.hp })) }, 'system');

    this.logDebug('match.start', 'Match started', {
      seed: config.seed,
      teamCount,
      wormsPerTeam: config.wormsPerTeam,
      map: config.map ?? 'island',
      mode: config.mode ?? 'deathmatch',
      turnSeconds: config.turnSeconds,
      wind: config.wind,
      difficulty: config.difficulty,
      waterLevel: WATER_Y,
    }, 'system');
    this.beginTurn(true);
    this.captureDebugSnapshot('match.start');
  }

  get configurationKey(): string {
    return configKey(this.config);
  }

  get activeWorm(): Worm | null {
    const team = this.teams[this.activeTeam];
    return team.worms.find((w) => w.id === this.activeWormId) ?? null;
  }

  get activeAmmo(): Record<WeaponId, number> {
    return this.teams[this.activeTeam].ammo;
  }

  get projectilesInFlight(): readonly Projectile[] {
    return this.projectiles;
  }

  /** True while the shooter may still walk away after firing. */
  get retreatActive(): boolean {
    return this.retreatTimer > 0 && (this.phase === 'projectile' || this.phase === 'settle');
  }

  /** True while the CPU stands still and visibly slews its reticle to the plan. */
  get aiAiming(): boolean {
    const worm = this.activeWorm;
    return (
      worm !== null &&
      this.teams[this.activeTeam].isAi &&
      this.phase === 'aim' &&
      !this.hasFired &&
      this.aiPlan !== null &&
      this.moveDir === 0 &&
      !worm.rope
    );
  }

  logDebug(
    category: string,
    message: string,
    data?: Record<string, unknown>,
    actorType: 'cpu' | 'mob' | 'system' = 'system',
    actorId?: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    this.debugSeq += 1;
    this.debugLog.push({
      seq: this.debugSeq,
      sessionId: this.sessionId,
      matchId: this.matchId,
      t: Math.round(this.elapsed * 1000) / 1000,
      tick: this.tick,
      turn: this.turn,
      actorType,
      actorId,
      category,
      level,
      message,
      data,
    });
    if (this.debugLog.length > this.debugLogLimit) {
      this.debugLog.splice(0, this.debugLog.length - this.debugLogLimit);
    }
  }

  clearDebugLog(): void {
    this.debugLog = [];
    this.debugSeq = 0;
  }

  captureDebugSnapshot(reason: string): void {
    this.debugSnapshots.push({ reason, snapshot: this.snapshot() });
    if (this.debugSnapshots.length > this.debugSnapshotLimit) {
      this.debugSnapshots.splice(0, this.debugSnapshots.length - this.debugSnapshotLimit);
    }
  }

  clearDebugSnapshots(): void {
    this.debugSnapshots = [];
  }

  private settleWorms(): void {
    for (const team of this.teams) {
      for (const worm of team.worms) {
        if (!worm.alive || worm.onGround) continue;
        const ground = this.terrain.groundY(worm.x, worm.y - 6, Math.max(0, WATER_Y - worm.y));
        if (ground !== null) worm.y = ground;
        worm.vx = 0;
        worm.vy = 0;
        worm.spin = 0;
        worm.rotation = 0;
        worm.launched = false;
        worm.onGround = true;
        worm.fallDistance = 0;
        worm.rope = null;
      }
    }
  }
  private beginTurn(first = false): void {
    // A turn never starts with a worm still mid-flight: land it where it stands.
    this.settleWorms();
    // Skip eliminated teams (no alive worms).
    if (!this.teams[this.activeTeam].worms.some((w) => w.alive)) {
      this.logDebug('turn.skip', 'Skipped eliminated team', { teamId: this.activeTeam }, 'system');
      if (this.teams.filter((t) => t.worms.some((w) => w.alive)).length <= 1) {
        const alive = this.teams.filter((t) => t.worms.some((w) => w.alive));
        this.finish(alive.length === 1 ? alive[0].id : null, 'wipeout');
        return;
      }
      this.activeTeam = this.nextAliveTeam(this.activeTeam);
      this.beginTurn(false);
      return;
    }
    const team = this.teams[this.activeTeam];
    const next = this.nextAliveWorm(team);
    if (!next) {
      // Team fully eliminated mid-cycle.
      this.logDebug('turn.skip', 'Skipped eliminated team', { teamId: this.activeTeam }, 'system');
      if (this.teams.filter((t) => t.worms.some((w) => w.alive)).length <= 1) {
        const alive = this.teams.filter((t) => t.worms.some((w) => w.alive));
        this.finish(alive.length === 1 ? alive[0].id : null, 'wipeout');
        return;
      }
      this.activeTeam = this.nextAliveTeam(this.activeTeam);
      this.beginTurn(false);
      return;
    }
    this.activeWormId = next.id;
    this.logDebug('turn.start', 'Turn started', {
      teamId: team.id,
      teamName: team.name,
      wormId: next.id,
      wormName: next.name,
      x: next.x,
      y: next.y,
      wind: this.wind,
      timeLeft: this.timeLeft,
      first,
      revengeFocus: this.revengeFocusByTeam[team.id] ?? null,
      revengeTurns: this.revengeTurnsByTeam[team.id] ?? 0,
    }, team.isAi ? 'cpu' : 'system', next.id);
    this.captureDebugSnapshot('turn.start');
    this.lastWormByTeam[team.id] = next.id;
    // Decay revenge state for the acting team.
    const turns = (this.revengeTurnsByTeam[team.id] ?? 0) - 1;
    this.revengeTurnsByTeam[team.id] = Math.max(0, turns);
    if (turns <= 0) this.revengeFocusByTeam[team.id] = null;
    this.timeLeft = this.config.turnSeconds;
    this.phase = 'aim';
    this.power = 0;
    this.charging = false;
    this.weapon = 'bazooka';
    this.moveDir = 0;
    this.reelDir = 0;
    this.hasFired = false;
    this.settleTimer = 0;
    this.retreatTimer = 0;
    this.aiTimer = 0.9;
    this.aiPlan = null;
    this.aiStall = 0;
    this.aiLastX = -1;
    this.aiJumpDeadline = null;
    this.aiRopeDeadline = null;
    this.aiJumpCount = 0;
    this.aiRopeCount = 0;
    this.aiFallbackX = null;
    this.aiFallbackRetry = 0;
    this.aiThinking = team.isAi;
    const maxWind = WIND_ACCEL[this.config.wind];
    this.wind = first ? 0 : (Math.round((this.rng() * 2 - 1) * maxWind) || 0);
    this.events.push({ type: 'turn', teamId: team.id, wormId: next.id });
  }

  private nextAliveWorm(team: Team): Worm | null {
    const currentIndex = team.worms.findIndex((w) => w.id === this.lastWormByTeam[team.id]);
    for (let i = 1; i <= team.worms.length; i += 1) {
      const candidate = team.worms[(currentIndex + i + team.worms.length) % team.worms.length];
      if (candidate.alive) return candidate;
    }
    return null;
  }

  private nextAliveTeam(from: number): number {
    const n = this.teams.length;
    for (let i = 1; i <= n; i += 1) {
      const idx = (from + i) % n;
      if (this.teams[idx].worms.some((w) => w.alive)) return idx;
    }
    return from;
  }

  setMove(dir: -1 | 0 | 1): void {
    this.moveDir = dir;
  }

  setReel(dir: -1 | 0 | 1): void {
    this.reelDir = dir;
  }

  /** Record a move only when the direction changes, so a held key does not flood the log. */
  recordMove(dir: -1 | 0 | 1): void {
    if (dir === this.moveDir) return;
    this.record({ type: 'move', dir });
  }

  /** Record a reel only when the direction changes, for the same reason. */
  recordReel(dir: -1 | 0 | 1): void {
    if (dir === this.reelDir) return;
    this.record({ type: 'reel', dir });
  }

  /**
   * Snapshot the current aim/power into the log. Call before every fire or
   * release so a replay reproduces the shot without local state (issue #280).
   */
  recordShotState(): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive) return;
    this.record({ type: 'aimAt', angle: worm.aimAngle });
    this.record({ type: 'setPower', power: this.power });
  }

  /** Player rope input. The AI attaches through the same private path. */
  useRope(): void {
    if (this.teams[this.activeTeam].isAi) return;
    this.toggleRope();
  }

  private toggleRope(): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive || this.phase === 'gameover' || this.charging) return;
    if (worm.rope) {
      this.releaseRope();
      return;
    }
    if (this.phase !== 'aim' && !this.retreatActive) return;
    const anchor = this.ropeAnchor(worm);
    if (!anchor) return;
    const dx = worm.x - anchor.x;
    const dy = worm.y - 14 - anchor.y;
    const length = Math.hypot(dx, dy);
    if (length < ROPE.minLength || length > ROPE.range) return;
    worm.rope = {
      anchorX: anchor.x,
      anchorY: anchor.y,
      length,
      angle: Math.atan2(dx, dy),
      angularVelocity: 0,
    };
    worm.vx = 0;
    worm.vy = 0;
    worm.onGround = false;
    worm.fallDistance = 0;
    this.reelDir = 0;
    this.events.push({ type: 'rope', x: anchor.x, y: anchor.y });
  }

  /** First solid point on the aim ray, within rope range. */
  private ropeAnchor(worm: Worm): { x: number; y: number } | null {
    const originX = worm.x;
    const originY = worm.y - 14;
    const dirX = Math.cos(worm.aimAngle);
    const dirY = Math.sin(worm.aimAngle);
    for (let distance = 8; distance <= ROPE.range; distance += 4) {
      const x = originX + dirX * distance;
      const y = originY + dirY * distance;
      if (this.terrain.isSolid(x, y)) return { x, y };
    }
    return null;
  }

  private releaseRope(): void {
    const worm = this.activeWorm;
    if (!worm?.rope) return;
    const rope = worm.rope;
    worm.rope = null;
    worm.onGround = false;
    worm.fallDistance = 0;
    worm.vx = rope.length * Math.cos(rope.angle) * rope.angularVelocity;
    worm.vy = -rope.length * Math.sin(rope.angle) * rope.angularVelocity;
    this.reelDir = 0;
  }

  private clearRopes(): void {
    for (const team of this.teams) for (const worm of team.worms) worm.rope = null;
  }

  aimBy(delta: number): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive || this.phase !== 'aim') return;
    worm.aimAngle = clampAngle(worm.aimAngle + delta);
    worm.facing = Math.cos(worm.aimAngle) >= 0 ? 1 : -1;
  }

  /** Absolute aim in radians, clamped to the same arc as pointer input. */
  setAim(angle: number): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive || this.phase !== 'aim') return;
    worm.aimAngle = clampAngle(angle);
    worm.facing = Math.cos(worm.aimAngle) >= 0 ? 1 : -1;
  }

  /** Charge level, clamped to the range pointer input can produce. */
  setPower(power: number): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive || this.phase !== 'aim') return;
    this.power = Math.min(1, Math.max(0, power));
  }

  /** Apply an input and keep it in the log for replay. */
  record(action: GameAction): void {
    this.log.push({ tick: this.tick, action });
    this.applyAction(action);
  }

  /** Same path as `record`, without logging. A replay drives the engine through here. */
  applyAction(action: GameAction): void {
    switch (action.type) {
      case 'move':
        this.setMove(action.dir);
        break;
      case 'aim':
        this.aimBy(action.delta);
        break;
      case 'aimAt':
        this.setAim(action.angle);
        break;
      case 'setPower':
        this.setPower(action.power);
        break;
      case 'jump':
        this.jump(action.dir);
        break;
      case 'rope':
        this.useRope();
        break;
      case 'reel':
        this.setReel(action.dir);
        break;
      case 'weapon':
        this.selectWeapon(action.id);
        break;
      case 'startCharge':
        this.startCharge();
        break;
      case 'releaseCharge':
        this.releaseCharge();
        break;
      case 'fire':
        this.fire();
        break;
      case 'endTurn':
        this.endTurn();
        break;
    }
  }

  setAimFromPoint(x: number, y: number): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive || this.phase !== 'aim') return;
    const angle = Math.atan2(y - (worm.y - 14), x - worm.x);
    worm.aimAngle = clampAngle(angle);
    worm.facing = Math.cos(worm.aimAngle) >= 0 ? 1 : -1;
  }

  startCharge(): void {
    const worm = this.activeWorm;
    if (!worm?.alive || this.phase !== 'aim' || this.teams[this.activeTeam].isAi || this.hasFired || worm.rope) return;
    this.charging = true;
    this.power = Math.max(this.power, 0);
  }

  releaseCharge(): void {
    if (!this.charging) return;
    this.charging = false;
    this.fire();
  }

  cancelCharge(): void {
    this.charging = false;
    this.power = 0;
  }

  selectWeapon(id: WeaponId): void {
    if (this.phase !== 'aim' || this.activeWorm?.rope) return;
    const ammo = this.teams[this.activeTeam].ammo[id];
    if (WEAPONS[id].ammo !== null && ammo <= 0) return;
    this.weapon = id;
  }

  /** Player jump input. The AI uses `aiJump`; this guard is authoritative against stale UI snapshots. */
  jump(dir: -1 | 0 | 1 = this.moveDir): void {
    if (this.teams[this.activeTeam].isAi) return;
    if (this.activeWorm?.rope) {
      this.releaseRope();
      return;
    }
    this.applyJump(dir);
  }

  private aiJump(dir: -1 | 0 | 1): void {
    this.applyJump(dir);
  }

  private applyJump(dir: -1 | 0 | 1): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive || this.phase === 'gameover' || !worm.onGround) return;
    worm.vx = dir * WORM.jumpPush;
    worm.vy = -WORM.jumpVelocity;
    const keepPlannedAim =
      this.teams[worm.teamId].isAi && worm.id === this.activeWormId && this.aiPlan !== null;
    if (dir !== 0 && worm.facing !== dir && !keepPlannedAim) {
      worm.facing = dir;
      worm.aimAngle = mirrorAngle(worm.aimAngle);
    }
    worm.onGround = false;
    worm.fallDistance = 0;
    this.events.push({ type: 'jump', x: worm.x, y: worm.y });
  }

  fire(): void {
    const worm = this.activeWorm;
    if (!worm || !worm.alive || this.phase !== 'aim' || this.hasFired || worm.launched) return;
    if (worm.rope) this.releaseRope();
    const team = this.teams[this.activeTeam];
    const weapon = WEAPONS[this.weapon];
    if (weapon.ammo !== null && team.ammo[this.weapon] <= 0) return;

    if (weapon.kind === 'utility') {
      if (weapon.ammo !== null) team.ammo[this.weapon] -= 1;
      this.hasFired = true;
      this.charging = false;
      if (weapon.heal) worm.hp = Math.min(worm.maxHp, worm.hp + weapon.heal);
      if (weapon.shield) worm.hp = Math.min(worm.maxHp + (weapon.shield ?? 0), worm.hp + (weapon.shield ?? 0));
      this.events.push({ type: 'fire', x: worm.x, y: worm.y - 14, angle: worm.aimAngle, weapon: this.weapon });
      this.finishTurn();
      return;
    }

    const power = Math.max(0.12, this.power);
    const angle = worm.aimAngle;
    const speed = weapon.speedMin + (weapon.speedMax - weapon.speedMin) * power;

    if (weapon.ammo !== null) team.ammo[this.weapon] -= 1;
    this.hasFired = true;
    this.charging = false;
    this.phase = 'projectile';
    this.retreatTimer = RETREAT_SECONDS;

    if (weapon.kind === 'drop') {
      this.projectiles.push({
        id: (this.projectileId += 1),
        weapon: this.weapon,
        teamId: team.id,
        x: worm.x,
        y: worm.y - 8,
        vx: 0,
        vy: 0,
        age: 0,
        fuse: weapon.fuse,
        trailTimer: 0,
      });
      this.events.push({ type: 'fire', x: worm.x, y: worm.y - 8, angle, weapon: this.weapon });
    } else {
      const muzzleX = worm.x + Math.cos(angle) * 18;
      const muzzleY = worm.y - 14 + Math.sin(angle) * 18;
      this.projectiles.push({
        id: (this.projectileId += 1),
        weapon: this.weapon,
        teamId: team.id,
        x: muzzleX,
        y: muzzleY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        age: 0,
        fuse: weapon.fuse,
        trailTimer: 0,
      });
      this.events.push({ type: 'fire', x: muzzleX, y: muzzleY, angle, weapon: this.weapon });
      if (this.weapon === 'shotgun') {
        this.events.push({ type: 'shotgun', x: muzzleX, y: muzzleY, angle });
        // Second shell with a slight spread (two-shot, like Worms).
        const spread = 0.08;
        const speed2 = speed;
        this.projectiles.push({
          id: (this.projectileId += 1),
          weapon: this.weapon,
          teamId: team.id,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(angle + spread) * speed2,
          vy: Math.sin(angle + spread) * speed2,
          age: 0,
          fuse: weapon.fuse,
          trailTimer: 0,
        });
      }
    }
  }

  endTurn(): void {
    if (this.phase !== 'aim' || this.charging) return;
    this.finishTurn();
  }

  surrender(): void {
    if (this.phase === 'gameover') return;
    const survivors = this.teams.filter((t) => t.id !== this.activeTeam && t.worms.some((w) => w.alive));
    this.finish(survivors.length === 1 ? survivors[0].id : null, 'surrender');
  }

  private spawnLoot(): void {
    const rng = this.rng;
    const ground = (x: number) => this.terrain.groundY(x, 120, WATER_Y - 120) ?? 470;
    // Keep loot clear of worm spawn bands so mines cannot arm on turn 1.
    const clearX = (minDist: number) => {
      for (let tries = 0; tries < 40; tries += 1) {
        const x = 200 + rng() * (WORLD_W - 400);
        if (this.teams.every((t) => t.worms.every((w) => Math.abs(w.x - x) >= minDist))) return x;
      }
      return 200 + rng() * (WORLD_W - 400);
    };
    for (let i = 0; i < 6; i += 1) {
      const x = clearX(70);
      this.loot.push({ id: ++this.lootId, x, y: ground(x) - 12, vx: 0, vy: 0, kind: 'ammo', armed: false, fuse: 0, ammoGrant: 1 });
    }
    for (let i = 0; i < 4; i += 1) {
      const x = clearX(70);
      this.loot.push({ id: ++this.lootId, x, y: ground(x) - 12, vx: 0, vy: 0, kind: 'mine', armed: false, fuse: 1.5, ammoGrant: 0 });
    }
    for (let i = 0; i < 3; i += 1) {
      const x = clearX(70);
      this.loot.push({ id: ++this.lootId, x, y: ground(x) - 12, vx: 0, vy: 0, kind: 'secret', armed: false, fuse: 0, ammoGrant: 2 });
    }
  }

  private updateLoot(dt: number): void {
    const teamOf = (w: { teamId: number }) => this.teams[w.teamId];
    for (const item of this.loot) {
      this.stepLoot(item, dt);
      if (item.kind === 'mine') {
        if (!item.armed) {
          for (const t of this.teams) for (const w of t.worms) {
            if (!w.alive) continue;
            const dx = w.x - item.x; const dy = w.y - item.y;
            if (Math.hypot(dx, dy) <= 80) item.armed = true;
          }
        }
        if (item.armed) {
          item.fuse -= dt;
          if (item.fuse <= 0) {
            this.detonateMine(item, new Set());
          }
        }
      }
    }
    // pickup
    for (const t of this.teams) for (const w of t.worms) {
      if (!w.alive) continue;
      for (const item of this.loot) {
        if (item.x < 0) continue;
        if (item.kind === 'mine') continue;
        const d = Math.hypot(w.x - item.x, w.y - item.y);
        if (d <= 28) {
          if (item.kind === 'ammo') {
            const ammo = teamOf(w).ammo;
            // Grant a finite weapon (grenade) so crates are not a no-op.
            ammo.grenade = ammo.grenade + item.ammoGrant;
          } else if (item.kind === 'secret') {
            w.hp = Math.min(w.maxHp, w.hp + 20);
          }
          item.x = -10000; // consumed
        }
      }
    }
    // remove consumed
    this.loot = this.loot.filter((l) => l.x >= 0);
  }

  /** Items obey gravity and settle on terrain, so a crater makes them drop. */
  private stepLoot(item: LootItem, dt: number): void {
    if (item.x < 0) return;
    item.vy += LOOT.gravity * dt;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(item.vx * dt), Math.abs(item.vy * dt)) / 5));
    for (let i = 0; i < steps; i += 1) {
      const nextX = worldClamp(item.x + (item.vx * dt) / steps, LOOT.radius, WORLD_W - LOOT.radius);
      if (nextX === LOOT.radius || nextX === WORLD_W - LOOT.radius || this.terrain.isSolid(nextX, item.y)) {
        item.vx = 0;
      } else {
        item.x = nextX;
      }
      const nextY = item.y + (item.vy * dt) / steps;
      if (this.terrain.isSolid(item.x, nextY + LOOT.radius)) {
        const ground = this.terrain.groundY(item.x, nextY - 12, 24);
        item.y = (ground ?? nextY + LOOT.radius) - LOOT.radius;
        const impact = Math.abs(item.vy);
        item.vy = impact > LOOT.bounceSpeed ? -item.vy * LOOT.restitution : 0;
        if (item.vy === 0) {
          item.vx *= LOOT.friction;
          if (Math.abs(item.vx) < 4) item.vx = 0;
        }
        break;
      }
      item.y = nextY;
      if (item.y > WATER_Y - LOOT.radius) {
        // Rest on the water surface instead of sinking.
        item.y = WATER_Y - LOOT.radius;
        item.vy = 0;
        item.vx *= LOOT.friction;
        if (Math.abs(item.vx) < 4) item.vx = 0;
        break;
      }
    }
  }

  /** Blasts throw nearby loot, same as worms. */
  private blastLoot(x: number, y: number, radius: number, scale = 1): void {
    for (const item of this.loot) {
      if (item.x < 0) continue;
      const dx = item.x - x;
      const dy = item.y - y;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const dirX = distance === 0 ? 0 : dx / distance;
      const dirY = distance === 0 ? -1 : dy / distance;
      const push = LOOT.blastSpeed * scale * (1 - distance / radius);
      item.vx += dirX * push;
      item.vy += dirY * push - 60;
    }
  }

  private spawnMobs(): void {
    const rng = this.rng;
    const ground = (x: number) => this.terrain.groundY(x, 120, WATER_Y - 120) ?? 470;
    const teamSize = this.config.wormsPerTeam ?? 3;
    const count = teamSize * 4;
    const center = WORLD_W / 2;
    for (let i = 0; i < count; i += 1) {
      let x = center;
      const isClear = (candidate: number) => {
        const clearOfWorms = this.teams.every((t) => t.worms.every((w) => Math.abs(w.x - candidate) >= 60));
        const clearOfMobs = this.mobs.every((m) => Math.abs(m.x - candidate) >= 48);
        const clearOfMines = this.loot.every((item) => item.kind !== 'mine' || Math.abs(item.x - candidate) >= 48);
        return clearOfWorms && clearOfMobs && clearOfMines;
      };
      for (let tries = 0; tries < 40; tries += 1) {
        const cand = center + (rng() - 0.5) * 1200;
        if (isClear(cand)) { x = cand; break; }
      }
      if (!isClear(x)) {
        // Band full: step outward from it so the mob stays as close to the
        // encounter as the 48 px spacing allows instead of stacking at center.
        for (let step = 48; step < WORLD_W; step += 48) {
          const left = center - 600 - step;
          const right = center + 600 + step;
          if (left >= 60 && isClear(left)) { x = left; break; }
          if (right <= WORLD_W - 60 && isClear(right)) { x = right; break; }
        }
      }
      x = Math.max(60, Math.min(WORLD_W - 60, x));
      this.mobs.push({
        id: ++this.mobId,
        x,
        y: ground(x) - MOB.radius,
        vy: 0,
        hp: MOB.maxHp,
        maxHp: MOB.maxHp,
        damage: MOB.damage,
        speed: MOB.speed,
        radius: MOB.radius,
        alive: true,
        moveDir: 0,
        moveLeft: 0,
      });
    }
  }

  private hostilePhase(): void {
    this.logDebug('mob.phase', 'Hostile phase started', {
      aliveMobs: this.mobs.filter((m) => m.alive).length,
      aliveWorms: this.teams.flatMap((t) => t.worms).filter((w) => w.alive).length,
    }, 'system');
    for (const mob of this.mobs) {
      if (!mob.alive) continue;
      let best: { w: Worm; d: number } | null = null;
      for (const t of this.teams) for (const w of t.worms) {
        if (!w.alive) continue;
        const d = Math.hypot(w.x - mob.x, w.y - mob.y);
        if (!best || d < best.d) best = { w, d };
      }
      if (!best) {
        mob.moveDir = 0;
        mob.moveLeft = 0;
        this.logDebug('mob.idle', 'Mob found no target', { mobId: mob.id, x: mob.x, y: mob.y }, 'mob', `mob-${mob.id}`);
        continue;
      }
      const dx = best.w.x - mob.x;
      const dy = best.w.y - mob.y;
      const dist = Math.hypot(dx, dy) || 1;
      const attacked = dist <= MOB.attackRange;
      mob.moveDir = attacked ? 0 : dx >= 0 ? 1 : -1;
      mob.moveLeft = attacked ? 0 : Math.min(mob.speed * MOB.orderSeconds, dist);
      if (attacked) {
        best.w.hp = Math.max(0, best.w.hp - mob.damage);
        if (best.w.hp <= 0) {
          best.w.alive = false;
          this.events.push({ type: 'death', x: best.w.x, y: best.w.y, color: this.teams[best.w.teamId].color });
        }
      }
      this.logDebug('mob.order', 'Mob movement ordered', {
        mobId: mob.id,
        from: { x: Math.round(mob.x), y: Math.round(mob.y) },
        targetId: best.w.id,
        targetTeam: best.w.teamId,
        distance: Math.round(dist),
        direction: mob.moveDir,
        budget: Math.round(mob.moveLeft),
        attacked,
        damage: attacked ? mob.damage : 0,
        killed: attacked && best.w.hp <= 0,
      }, 'mob', `mob-${mob.id}`);
      if (attacked && best.w.hp <= 0) {
        this.logDebug('mob.kill', 'Mob killed worm', { mobId: mob.id, wormId: best.w.id }, 'mob', `mob-${mob.id}`);
      }
    }
    this.captureDebugSnapshot('mob.phase');
    this.checkWipeout();
  }

  private finishTurn(): void {
    if (this.phase === 'gameover') return;
    const endingTeam = this.activeTeam;
    const endingWorm = this.activeWorm;
    this.logDebug('turn.end', 'Turn ended', {
      teamId: endingTeam,
      wormId: endingWorm?.id,
      wormName: endingWorm?.name,
      x: endingWorm?.x,
      y: endingWorm?.y,
      hasFired: this.hasFired,
      turn: this.turn,
    }, this.teams[endingTeam].isAi ? 'cpu' : 'system', endingWorm?.id);
    this.captureDebugSnapshot('turn.end');
    this.moveDir = 0;
    this.reelDir = 0;
    this.charging = false;
    this.aiThinking = false;
    this.retreatTimer = 0;
    this.projectiles = [];
    this.clearRopes();
    this.activeTeam = this.nextAliveTeam(this.activeTeam);
    this.turn += 1;
    // Mobs act every turn so they feel alive instead of once per full cycle.
    this.hostilePhase();
    this.checkWipeout();
    if ((this.phase as string) === 'gameover') {
      return;
    }
    if (this.config.mode === 'sudden-death' && this.config.turnSeconds > 0) {
      // damage all alive worms per turn after threshold (threshold stored in config? use 6 turns)
      if (this.turn >= 6) {
        for (const t of this.teams) for (const w of t.worms) {
          if (w.alive) { w.hp = Math.max(0, w.hp - 5); if (w.hp <= 0) { w.alive = false; this.events.push({ type: 'death', x: w.x, y: w.y, color: t.color }); } }
        }
        this.checkWipeout();
      }
      if (this.turn >= 6) this.logDebug('suddenDeath.damage', 'Sudden death damage applied', { turn: this.turn }, 'system');
    }
    if ((this.phase as string) === 'gameover') return;
    this.beginTurn();
  }

  private finish(winner: number | null, reason: EndReason): void {
    if (this.phase === 'gameover') return;
    this.logDebug('match.end', 'Match ended', { winnerTeam: winner, reason, elapsed: Math.round(this.elapsed) }, 'system');
    this.phase = 'gameover';
    this.winnerTeam = winner;
    this.endReason = reason;
    this.charging = false;
    this.moveDir = 0;
    this.reelDir = 0;
    this.projectiles = [];
    this.clearRopes();
    this.events.push({ type: 'gameover', winnerTeamId: winner });
    // Capture after the terminal state so the snapshot reports the winner and end reason.
    this.captureDebugSnapshot('match.end');
  }

  private hurt(worm: Worm, amount: number, sourceX: number, sourceY: number, sourceTeam: number | null, impulseScale = 1.0): void {
    if (!worm.alive || amount <= 0) return;
    worm.hp = Math.max(0, worm.hp - amount);
    this.events.push({ type: 'hurt', x: worm.x, y: worm.y - 26, amount: Math.round(amount) });
    this.logDebug('combat.hurt', 'Worm hurt', { wormId: worm.id, teamId: worm.teamId, amount: Math.round(amount), sourceTeam, x: worm.x, y: worm.y }, 'system');
    // A hit cancels any in-progress charge so it is not released while tumbling.
    if (worm.id === this.activeWormId) {
      this.charging = false;
      this.power = 0;
    }
    // Ragdoll impulse: throw the worm along the blast vector (replaces the old
    // <=14 px teleport). impulseScale tunes per-source feel (shotgun < mine < explosion).
    const dx = worm.x - sourceX;
    const dy = (worm.y - 13) - sourceY;
    const dist = Math.hypot(dx, dy) || 1;
    const bx = dx / dist;
    const by = dy / dist;
    const impulse = Math.min(WORM.knockbackMax, (amount / 100) * WORM.knockbackScale * impulseScale);
    worm.vx += bx * impulse;
    worm.vy += by * impulse;
    // Launch state: disables air-steering, enables bounce, drives spin.
    worm.rope = null;
    worm.onGround = false;
    worm.launched = true;
    worm.fallDistance = 0;
    worm.spin = bx * WORM.spinScale;
    if (worm.hp <= 0) {
      worm.alive = false;
      worm.rope = null;
      this.events.push({ type: 'death', x: worm.x, y: worm.y, color: this.teams[worm.teamId].color });
      this.logDebug('combat.death', 'Worm died', { wormId: worm.id, teamId: worm.teamId, sourceTeam, x: worm.x, y: worm.y }, 'system');
      if (sourceTeam !== null && sourceTeam !== worm.teamId) this.kills[sourceTeam] += 1;
      this.checkWipeout();
    }
    // Revenge: an ally was hurt by an enemy.
    if (sourceTeam !== null && sourceTeam !== worm.teamId) {
      this.revengeFocusByTeam[worm.teamId] = { x: worm.x, y: worm.y };
      this.revengeTurnsByTeam[worm.teamId] = AI.revengeDecayTurns;
    }
  }

  private checkWipeout(): void {
    if (this.config.mode === 'assassinate') {
      for (const team of this.teams) {
        const leader = team.worms[0];
        if (leader && !leader.alive) {
          const survivors = this.teams.filter((t) => t.id !== team.id && t.worms.some((w) => w.alive));
          this.finish(survivors.length === 1 ? survivors[0].id : null, 'wipeout');
          return;
        }
      }
    }
    const alive = this.teams.filter((t) => t.worms.some((w) => w.alive));
    if (alive.length <= 1) {
      this.finish(alive.length === 1 ? alive[0].id : null, 'wipeout');
    }
  }

  private explode(x: number, y: number, weapon: WeaponId, sourceTeam: number | null): void {
    const def = WEAPONS[weapon];
    this.logDebug('combat.explosion', 'Explosion', { x: Math.round(x), y: Math.round(y), weapon, sourceTeam, terrainRadius: def.terrainRadius }, 'system');
    this.blast(x, y, def.damage, def.radius, def.terrainRadius, sourceTeam, 'explosion');
    this.chainMines(x, y, def.radius, new Set());
  }

  /** Shared blast logic used by weapons and mines. */
  private blast(x: number, y: number, damage: number, radius: number, terrainRadius: number, sourceTeam: number | null, eventType: 'explosion' | 'mineExplosion'): void {
    this.terrain.carve(x, y, terrainRadius);
    this.blastLoot(x, y, radius);
    for (const mob of this.mobs) {
      if (!mob.alive) continue;
      const d = Math.hypot(mob.x - x, mob.y - y);
      if (d <= radius) {
        const amount = damage * blastFalloff(d, radius);
        mob.hp = Math.max(0, mob.hp - amount);
        this.logDebug('combat.mobHurt', 'Mob hurt by blast', {
          mobId: mob.id,
          amount: Math.round(amount),
          remainingHp: Math.round(mob.hp),
          distance: Math.round(d),
          eventType,
        }, 'system', `mob-${mob.id}`);
        if (mob.hp <= 0) {
          mob.alive = false;
          this.logDebug('combat.mobDeath', 'Mob killed by blast', {
            mobId: mob.id,
            eventType,
          }, 'system', `mob-${mob.id}`);
          this.loot.push({ id: ++this.lootId, x: mob.x, y: mob.y - 12, vx: 0, vy: 0, kind: 'ammo', armed: false, fuse: 0, ammoGrant: 1 });
        }
      }
    }
    this.events.push({ type: eventType, x, y, radius });
    for (const team of this.teams) {
      for (const worm of team.worms) {
        if (!worm.alive) continue;
        const dx = worm.x - x;
        const dy = worm.y - 13 - y;
        const distance = Math.hypot(dx, dy);
        if (distance > radius + WORM.radius) continue;
        this.hurt(worm, damage * blastFalloff(distance, radius + WORM.radius), x, y, sourceTeam);
      }
    }
  }

  /** Detonate any mine within radius of a blast (chain reaction). */
  private chainMines(x: number, y: number, radius: number, visited: Set<number>): void {
    for (const item of this.loot) {
      if (item.kind !== 'mine' || item.x < 0) continue;
      if (visited.has(item.id)) continue;
      if (Math.hypot(item.x - x, item.y - y) > radius) continue;
      this.detonateMine(item, visited);
    }
  }

  private detonateMine(item: LootItem, visited: Set<number>): void {
    if (item.x < 0 || item.kind !== 'mine') return;
    if (visited.has(item.id)) return;
    visited.add(item.id);
    const x = item.x; const y = item.y;
    // consume first to prevent re-entry
    item.kind = 'ammo';
    item.x = -10000;
    const sourceTeam = this.activeTeam;
    this.blast(x, y, 40, 60, 40, sourceTeam, 'mineExplosion');
    this.chainMines(x, y, 60, visited);
  }

  /** Pendulum around the anchor, with gravity pulling the worm toward straight down. */
  private stepRopedWorm(worm: Worm, dt: number): void {
    const rope = worm.rope;
    if (!rope) return;
    if (!this.terrain.isSolid(rope.anchorX, rope.anchorY)) {
      worm.rope = null;
      return;
    }

    const isActive = worm.id === this.activeWormId;
    const swing = isActive ? this.moveDir : 0;
    const reel = isActive ? this.reelDir : 0;
    const previous = { x: worm.x, y: worm.y, angle: rope.angle, length: rope.length };
    const accel = -(GRAVITY / rope.length) * Math.sin(rope.angle) + swing * ROPE.swingAccel;
    rope.angularVelocity = (rope.angularVelocity + accel * dt) * ROPE.damping;
    rope.angularVelocity = worldClamp(
      rope.angularVelocity,
      -ROPE.maxAngularSpeed,
      ROPE.maxAngularSpeed,
    );
    rope.angle += rope.angularVelocity * dt;
    rope.length = worldClamp(rope.length + reel * ROPE.reelSpeed * dt, ROPE.minLength, ROPE.range);

    const chestX = rope.anchorX + Math.sin(rope.angle) * rope.length;
    const chestY = rope.anchorY + Math.cos(rope.angle) * rope.length;
    const nextY = chestY + 14;

    if (nextY > WATER_Y) {
      worm.x = chestX;
      worm.y = nextY;
      this.drown(worm);
      return;
    }

    if (this.terrain.isSolid(chestX, chestY) || this.terrain.isSolid(chestX, nextY - 6)) {
      // The swing ran into terrain: hold the last valid pose. Reeling in still
      // lifts the worm clear instead of dropping the rope on the first frame.
      rope.angle = previous.angle;
      rope.length = previous.length;
      rope.angularVelocity = 0;
      worm.x = previous.x;
      worm.y = previous.y;
      worm.onGround = false;
      worm.fallDistance = 0;
      return;
    }

    worm.x = chestX;
    worm.y = nextY;
    worm.vx = rope.length * Math.cos(rope.angle) * rope.angularVelocity;
    worm.vy = -rope.length * Math.sin(rope.angle) * rope.angularVelocity;
    worm.onGround = false;
    worm.fallDistance = 0;
  }

  private stepMobs(dt: number): void {
    for (const mob of this.mobs) {
      if (!mob.alive) continue;
      const feet = mob.y + mob.radius;
      const ground = this.terrain.groundY(
        mob.x,
        Math.max(0, feet - MOB.groundProbe),
        Math.max(0, WATER_Y - feet + MOB.groundProbe),
      );
      if (ground !== null && feet >= ground - MOB.groundTolerance) {
        mob.y = ground - mob.radius;
        mob.vy = 0;
      } else {
        mob.vy += GRAVITY * dt;
        const distance = mob.vy * dt;
        const steps = Math.max(1, Math.ceil(Math.abs(distance) / MOB.collisionStep));
        for (let i = 0; i < steps; i += 1) {
          const stepDistance = distance / steps;
          const nextY = mob.y + stepDistance;
          const nextFeet = nextY + mob.radius;
          if (this.terrain.isSolid(mob.x, nextFeet)) {
            const landing = this.terrain.groundY(
              mob.x,
              Math.max(0, nextFeet - Math.abs(stepDistance) - MOB.groundProbe),
              MOB.landingRange,
            );
            mob.y = (landing ?? nextFeet) - mob.radius;
            mob.vy = 0;
            break;
          }
          mob.y = nextY;
          if (nextFeet >= WATER_Y) {
            mob.alive = false;
            this.logDebug('mob.death', 'Mob drowned', { mobId: mob.id }, 'mob', `mob-${mob.id}`);
            break;
          }
        }
      }
      if (mob.alive && mob.moveDir !== 0 && mob.moveLeft > 0) this.walkMob(mob, dt);
    }
  }

  private walkMob(mob: Mob, dt: number): void {
    const support = this.terrain.groundY(mob.x, Math.max(0, mob.y - MOB.groundProbe), MOB.supportRange);
    if (support === null || Math.abs(mob.y + mob.radius - support) > MOB.groundTolerance) return;
    const budget = Math.min(mob.moveLeft, mob.speed * dt);
    const steps = Math.max(1, Math.ceil(budget / MOB.collisionStep));
    let moved = 0;
    for (let i = 0; i < steps; i += 1) {
      const previousX = mob.x;
      const nx = worldClamp(previousX + mob.moveDir * budget / steps, 0, WORLD_W);
      if (nx === previousX) {
        mob.moveLeft = 0;
        break;
      }
      const currentGround = this.terrain.groundY(mob.x, Math.max(0, mob.y - MOB.groundProbe), MOB.supportRange);
      // Include the allowed upward step so groundY finds the ledge top, not a point inside its wall.
      const nextGround = this.terrain.groundY(
        nx,
        Math.max(0, mob.y - MOB.groundProbe - MOB.maxGroundStep),
        MOB.supportRange + MOB.maxGroundStep,
      );
      if (currentGround === null || nextGround === null || Math.abs(nextGround - currentGround) > MOB.maxGroundStep) {
        mob.moveLeft = 0;
        break;
      }
      mob.x = nx;
      mob.y = nextGround - mob.radius;
      moved += Math.abs(nx - previousX);
    }
    mob.moveLeft = Math.max(0, mob.moveLeft - moved);
    if (mob.moveLeft === 0) mob.moveDir = 0;
  }

  private stepWorm(worm: Worm, dt: number): void {
    if (!worm.alive) return;
    if (worm.rope) {
      this.stepRopedWorm(worm, dt);
      return;
    }
    const isActive = worm.id === this.activeWormId;
    const keepPlannedAim = isActive && this.teams[worm.teamId].isAi && this.aiPlan !== null;
    const canWalk =
      isActive &&
      worm.onGround &&
      (this.phase === 'aim' || this.retreatActive) &&
      this.moveDir !== 0;

    if (canWalk) {
      const dir = this.moveDir;
      worm.vx = 0;
      const nx = worldClamp(worm.x + dir * WORM.walkSpeed * dt, 12, WORLD_W - 12);
      const bodyBlocked = this.terrain.isSolid(nx, worm.y - 12);
      const ahead = this.terrain.groundY(nx, worm.y - 18, 42);
      const slope = ahead === null ? null : ahead - worm.y;
      if (!bodyBlocked && (slope === null || slope <= 14)) {
        worm.x = nx;
        if (worm.facing !== dir && !keepPlannedAim) {
          worm.facing = dir as 1 | -1;
          if (!this.charging) worm.aimAngle = mirrorAngle(worm.aimAngle);
        }
        if (ahead !== null) {
          worm.y = ahead;
          worm.vy = 0;
          worm.onGround = true;
          worm.fallDistance = 0;
        } else {
          worm.onGround = false;
        }
      }
    }

    // Holding a direction in the air steers the jump, so a vertical hop can
    // still clear a ledge sideways. Disabled while launched (ragdoll) so the
    // explosion impulse is not fought.
    if (
      isActive &&
      !worm.onGround &&
      !worm.launched &&
      (this.phase === 'aim' || this.retreatActive) &&
      this.moveDir !== 0
    ) {
      worm.vx = this.moveDir * WORM.jumpPush;
    }

    // Ragdoll spin integration while off the ground.
    if (!worm.onGround) {
      worm.rotation += worm.spin * dt;
      worm.spin *= 0.985;
    }

    if (!worm.onGround) {
      worm.vy += GRAVITY * dt;
      const dy = worm.vy * dt;
      const dx = worm.vx * dt;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dy), Math.abs(dx)) / 5));
      for (let i = 0; i < steps; i += 1) {
        if (worm.vx !== 0) {
          const nextX = worldClamp(worm.x + dx / steps, 12, WORLD_W - 12);
          if (nextX === 12 || nextX === WORLD_W - 12 || this.terrain.isSolid(nextX, worm.y - 12)) {
            if (worm.launched && Math.abs(worm.vx) > WORM.landingStopSpeed) {
              worm.vx = -worm.vx * WORM.wallRestitution;
            } else {
              worm.vx = 0;
            }
          } else {
            worm.x = nextX;
          }
        }
        const nextY = worm.y + dy / steps;
        const hit = this.terrain.isSolid(worm.x, nextY);
        if (hit) {
          const landing = this.terrain.groundY(worm.x, nextY - Math.abs(dy / steps) - 6, 18);
          worm.y = landing ?? Math.floor(nextY / 4) * 4;
          const impactSpeed = Math.hypot(worm.vx, worm.vy);
          if (worm.launched && impactSpeed > WORM.landingStopSpeed) {
            // Tumble: reflect and keep flying.
            worm.vy = -worm.vy * WORM.restitution;
            worm.vx *= 0.55;
            worm.onGround = false;
            worm.fallDistance = 0;
            // keep launched true
          } else {
            worm.vy = 0;
            worm.vx = 0;
            worm.onGround = true;
            worm.launched = false;
            worm.spin = 0;
            worm.rotation = 0;
            this.applyFallDamage(worm);
          }
          break;
        }
        const stepDelta = dy / steps;
        worm.y = nextY;
        // Unlimited flips must not carry the worm out of the top of the world.
        if (worm.y < 0) {
          worm.y = 0;
          worm.vy = 0;
        }
        if (stepDelta > 0) worm.fallDistance += stepDelta;
        if (worm.y > WATER_Y) {
          this.drown(worm);
          return;
        }
      }
    } else {
      const ground = this.terrain.groundY(worm.x, worm.y - 6, 24);
      if (ground === null) {
        worm.onGround = false;
        worm.vy = 0;
        worm.vx = 0;
        worm.fallDistance = 0;
      } else {
        worm.y = ground;
      }
    }
    // Walking and rope swings can reach the water without the falling branch
    // seeing it; the water is the one place a worm dies on contact.
    if (worm.y >= WATER_Y) this.drown(worm);
  }

  private drown(worm: Worm): void {
    if (!worm.alive) return;
    worm.y = WATER_Y;
    worm.rope = null;
    worm.hp = 0;
    worm.alive = false;
    this.events.push({ type: 'splash', x: worm.x, y: WATER_Y });
    this.events.push({ type: 'death', x: worm.x, y: worm.y, color: this.teams[worm.teamId].color });
    this.checkWipeout();
  }

  private applyFallDamage(worm: Worm): void {
    const drop = worm.fallDistance;
    worm.fallDistance = 0;
    if (drop > WORM.fallSafePx) {
      const amount = (drop - WORM.fallSafePx) * WORM.fallDamagePerPx;
      if (amount < 1) return;
      worm.hp = Math.max(0, worm.hp - amount);
      this.events.push({ type: 'hurt', x: worm.x, y: worm.y - 26, amount: Math.round(amount) });
      if (worm.hp <= 0 && worm.alive) {
        worm.alive = false;
        worm.rope = null;
        this.events.push({ type: 'death', x: worm.x, y: worm.y, color: this.teams[worm.teamId].color });
        this.checkWipeout();
      }
    }
  }

  private chunksFor(speed: number): number {
    return Math.max(1, Math.ceil((speed * (1 / 60)) / 5));
  }

  private stepProjectiles(dt: number): void {
    const survivors: Projectile[] = [];
    for (const p of this.projectiles) {
      const def = WEAPONS[p.weapon];
      const drops = def.kind === 'drop';
      p.age += dt;
      p.trailTimer += dt;

      if (p.fuse !== null && p.age >= p.fuse) {
        this.explode(p.x, p.y, p.weapon, p.teamId);
        continue;
      }

      p.vy += PROJECTILE_GRAVITY * def.gravityScale * dt;
      p.vx += this.wind * def.windScale * WIND_FACTOR * dt;

      const speed = Math.hypot(p.vx, p.vy);
      const steps = this.chunksFor(speed);
      const sdt = dt / steps;
      let consumed = false;

      for (let i = 0; i < steps; i += 1) {
        const nx = p.x + p.vx * sdt;
        const ny = p.y + p.vy * sdt;

        const victim = drops
          ? undefined
          : this.teams
              .flatMap((team) => team.worms)
              .find(
                (w) =>
                  w.alive &&
                  !(w.id === this.activeWormId && p.age < 0.14) &&
                  Math.hypot(w.x - nx, w.y - 13 - ny) < 14 + WORM.radius * 0.4,
              );
        if (victim) {
          if (p.weapon === 'shotgun') {
            this.hurt(victim, def.damage, p.x, p.y, p.teamId, 0.35);
            this.events.push({ type: 'impact', x: nx, y: ny });
            consumed = true;
            break;
          }
          this.explode(nx, ny, p.weapon, p.teamId);
          consumed = true;
          break;
        }

        if (this.terrain.isSolid(nx, ny)) {
          if (drops) {
            // A thrown charge rests where it lands; only the fuse sets it off.
            p.vx = 0;
            p.vy = 0;
            break;
          }
          if (def.bounces) {
            const hitX = this.terrain.isSolid(nx, p.y);
            const hitY = this.terrain.isSolid(p.x, ny);
            if (hitX) p.vx = -p.vx * BOUNCE.x;
            if (hitY) p.vy = -p.vy * BOUNCE.y;
            if (!hitX && !hitY) {
              p.vx = -p.vx * BOUNCE.x;
              p.vy = -p.vy * BOUNCE.y;
            }
            p.x += p.vx * sdt;
            p.y += p.vy * sdt;
            if (p.age > 0.1) this.events.push({ type: 'bounce', x: p.x, y: p.y });
          } else {
            this.explode(nx, ny, p.weapon, p.teamId);
            consumed = true;
            break;
          }
        }

        p.x = nx;
        p.y = ny;

        if (p.x < -60 || p.x > WORLD_W + 60 || p.y > WATER_Y) {
          this.events.push({ type: 'splash', x: Math.max(0, Math.min(WORLD_W, p.x)), y: WATER_Y });
          consumed = true;
          break;
        }
        if (p.y > 760) {
          consumed = true;
          break;
        }
        const life = def.life;
        if (life !== null && p.age >= life) {
          consumed = true;
          break;
        }
      }

      if (!consumed) survivors.push(p);
    }
    // finish() clears the list when an explosion ends the match mid-step.
    this.projectiles = this.phase === 'gameover' ? [] : survivors;
  }

  private nearestEnemy(worm: Worm): Worm | null {
    const targets = this.teams
      .filter((t) => t.id !== worm.teamId)
      .flatMap((t) => t.worms)
      .filter((w) => w.alive);
    return (
      targets.sort(
        (a, b) => Math.hypot(a.x - worm.x, a.y - worm.y) - Math.hypot(b.x - worm.x, b.y - worm.y),
      )[0] ?? null
    );
  }

  private aliveAiWorms() {
    return this.teams.flatMap((team) =>
      team.worms.filter((w) => w.alive).map((w) => ({ id: w.id, teamId: w.teamId, x: w.x, y: w.y, hp: w.hp })),
    );
  }

  /** Run the planner from the worm's current spot. */
  private buildAiPlan(worm: Worm): AiTurnPlan | null {
    return planAiTurn({
      terrain: this.terrain,
      worm: { id: worm.id, teamId: worm.teamId, x: worm.x, y: worm.y, hp: worm.hp },
      worms: this.aliveAiWorms(),
      ammo: { ...this.teams[this.activeTeam].ammo },
      wind: this.wind,
      timeLeft: this.timeLeft,
      difficulty: DIFFICULTY[this.config.difficulty],
      rng: this.rng,
      revengeFocus: this.revengeFocusByTeam[this.activeTeam] ?? null,
      mines: this.loot.filter(l=>l.kind==='mine' && l.x>=0).map(l=>({x:l.x,y:l.y})),
    });
  }

  private aiShotIsUseful(worm: Worm, weapon: WeaponId, retreatX: number | null = null): boolean {
    return isUsefulAiShot({
      terrain: this.terrain,
      shooter: { id: worm.id, teamId: worm.teamId, x: worm.x, y: worm.y, hp: worm.hp },
      worms: this.aliveAiWorms(),
      weapon,
      angle: worm.aimAngle,
      power: Math.max(0.12, this.power),
      wind: this.wind,
      revengeFocus: this.revengeFocusByTeam[this.activeTeam] ?? null,
      retreatX,
    });
  }

  /** Log the fresh plan with its target, so retries and first tries look the same. */
  private logAiPlan(worm: Worm): void {
    const plan = this.aiPlan;
    if (!plan) return;
    const target = this.nearestEnemy(worm);
    this.logDebug('ai.plan', 'AI planned turn', {
      wormId: worm.id,
      targetId: target?.id,
      targetTeam: target?.teamId,
      fireX: plan.fireX,
      fireY: plan.fireY,
      angle: plan.angle,
      power: plan.power,
      weapon: plan.weapon,
      retreatX: plan.retreatX,
      wind: this.wind,
      mood: this.revengeFocusByTeam[this.activeTeam] ? 'revenge' : 'normal',
    }, 'cpu', worm.id);
  }

  private aimAt(angle: number, power: number): void {
    const worm = this.activeWorm;
    if (!worm) return;
    worm.aimAngle = clampAngle(angle);
    worm.facing = Math.cos(worm.aimAngle) >= 0 ? 1 : -1;
    this.power = power;
  }

  /** Slew the CPU reticle toward its selected shot instead of teleporting it at fire time. */
  private steerAiAim(angle: number, power: number, dt: number): void {
    const worm = this.activeWorm;
    if (!worm) return;
    const delta = clampAngle(angle) - worm.aimAngle;
    const step = Math.min(Math.abs(delta), AI.aimRadiansPerSecond * dt);
    this.aimAt(worm.aimAngle + Math.sign(delta) * step, power);
  }

  /**
   * The AI walks to its firing spot, fires the planned weapon, then keeps
   * walking to its retreat spot while the post-fire window is open.
   */
  private updateAi(dt: number): void {
    const worm = this.activeWorm;
    if (!worm) return;

    if (worm.rope) {
      const plan = this.aiPlan;
      const targetX = plan?.fireX ?? worm.x;
      const targetGround = plan?.fireY ?? worm.y;
      this.moveDir = Math.abs(targetX - worm.x) <= 6 ? 0 : targetX > worm.x ? 1 : -1;
      this.reelDir = -1;
      if (
        worm.y <= targetGround - 4 ||
        (this.aiRopeDeadline !== null && this.timeLeft <= this.aiRopeDeadline)
      ) {
        this.moveDir = 0;
        this.reelDir = 0;
        this.releaseRope();
        this.aiStall = 0;
        this.aiLastX = worm.x;
      }
      return;
    }

    if (this.retreatActive) {
      const dx = this.aiPlan ? this.aiPlan.retreatX - worm.x : 0;
      this.moveDir = Math.abs(dx) <= 6 ? 0 : dx > 0 ? 1 : -1;
      return;
    }

    if (this.phase !== 'aim' || this.hasFired) return;

    if (!this.aiPlan) {
      // No-plan fallback (#298): the planner found no scoring shot, but time
      // remains. Walk toward the nearest enemy and retry from the new spot
      // instead of passing the turn ~0.9s in. Only pass when truly stuck.
      // shortcut: straight-line walk, no mines/jumps; revisit with pathfinding.
      if (this.aiFallbackX !== null) {
        const dxFallback = this.aiFallbackX - worm.x;
        const dir = Math.abs(dxFallback) <= 6 ? 0 : dxFallback > 0 ? 1 : -1;
        // Anti-feed: never step onto a mine or off a cliff while blind-rushing.
        const probeX = worm.x + dir * 16;
        const mineAhead =
          dir !== 0 &&
          this.loot.some((l) => l.kind === 'mine' && Math.hypot(l.x - probeX, l.y - worm.y) < 60);
        const groundAhead = dir !== 0 ? this.terrain.groundY(probeX, worm.y - 18, 42) : 0;
        if (dir === 0 || mineAhead || groundAhead === null) {
          this.moveDir = 0;
          this.aiStall += dt;
        } else {
          this.moveDir = dir;
          if (Math.abs(worm.x - this.aiLastX) < 0.5) this.aiStall += dt;
          else {
            this.aiStall = 0;
            this.aiLastX = worm.x;
            this.aiBlockedLogged = false;
          }
        }
        this.aiFallbackRetry -= dt;
        if (this.aiFallbackRetry <= 0) {
          this.aiPlan = this.buildAiPlan(worm);
          this.aiLastX = worm.x;
          // Failed retries must preserve blocked time or a cliff can stall until the turn timer expires.
          if (this.aiPlan) {
            this.aiStall = 0;
            this.aiBlockedLogged = false;
            this.aiFallbackX = null;
            this.logAiPlan(worm);
          } else {
            this.aiFallbackRetry = 1;
            const enemy = this.nearestEnemy(worm);
            if (enemy) this.aiFallbackX = enemy.x;
          }
        }
        if (!this.aiPlan) {
          if (this.aiStall >= 1.5 || this.timeLeft <= 0.5) {
            this.moveDir = 0;
            this.aiThinking = false;
            this.aiFallbackX = null;
            this.finishTurn();
          }
          return;
        }
      } else {
        this.aiTimer -= dt;
        if (this.aiTimer > 0) return;

        this.aiPlan = this.buildAiPlan(worm);
        this.aiLastX = worm.x;
        this.aiStall = 0;
        this.aiJumpCount = 0;
        this.aiRopeCount = 0;
        this.aiBlockedLogged = false;

        if (!this.aiPlan) {
          this.logDebug('ai.noPlan', 'AI found no plan', { wormId: worm.id, teamId: worm.teamId }, 'cpu', worm.id, 'warn');
          const enemy = this.nearestEnemy(worm);
          if (!enemy || this.timeLeft <= 1) {
            this.aiThinking = false;
            this.finishTurn();
            return;
          }
          this.aiFallbackX = enemy.x;
          this.aiFallbackRetry = 1;
          this.logDebug('ai.fallbackWalk', 'AI advancing toward enemy without a plan', { wormId: worm.id, targetId: enemy.id, fromX: worm.x, toX: enemy.x }, 'cpu', worm.id);
          return;
        }
        this.logAiPlan(worm);
      }
    }

    const plan = this.aiPlan;
    // Keep the selected weapon visible while the CPU moves into firing position.
    this.weapon = plan.weapon;
    const distance = plan.fireX - worm.x;
    const planGround = this.terrain.groundY(plan.fireX, Math.max(0, worm.y - ROPE.range - 12), WATER_Y);
    const planInReach = planGround !== null && worm.y - planGround <= JUMP_REACH;
    const planTarget = planGround ?? plan.fireY;

    // A high spot is worth an early rope cast from a distance; walking into the
    // wall first only leaves the worm without a shallow anchor angle.
    if (!planInReach && worm.onGround && Math.abs(distance) <= ROPE.range * 0.95 && this.aiRopeCount < 2) {
      if (this.aiRopeDeadline === null) {
        this.aiRopeDeadline = this.timeLeft - AI.ropeWindowSeconds;
      }
      if (this.timeLeft > this.aiRopeDeadline) {
        const ropePlan = planRopeClimb(
          this.terrain,
          { id: worm.id, teamId: worm.teamId, x: worm.x, y: worm.y },
          plan.fireX,
          planTarget,
        );
        if (ropePlan) {
          this.aimAt(ropePlan.angle, this.power);
          this.toggleRope();
          if (worm.rope) {
            this.aiRopeCount += 1;
            this.logDebug('ai.rope', 'AI used rope to climb', { wormId: worm.id, ropeCount: this.aiRopeCount, fireX: plan.fireX, fromX: worm.x }, 'cpu', worm.id);
            this.aiStall = 0;
            this.aiLastX = worm.x;
            return;
          }
        }
      }
    }

    if (Math.abs(distance) > 6) {
      this.moveDir = distance > 0 ? 1 : -1;
      if (Math.abs(worm.x - this.aiLastX) < 0.5) this.aiStall += dt;
      else {
        this.aiStall = 0;
        this.aiLastX = worm.x;
        this.aiBlockedLogged = false;
      }
      // Blocked or out of turn time: take the best bazooka shot from here.
      if (this.aiStall < 1.5 && this.timeLeft > 0.5) return;

      if (!this.aiBlockedLogged) {
        this.aiBlockedLogged = true;
        this.logDebug('ai.blocked', 'AI movement blocked', {
          wormId: worm.id,
          x: worm.x,
          fireX: plan.fireX,
          stall: Math.round(this.aiStall * 100) / 100,
          planInReach,
          ropeCount: this.aiRopeCount,
          jumpCount: this.aiJumpCount,
        }, 'cpu', worm.id, 'warn');
      }

      // A blocked AI walk climbs with the rope when the ledge is too high,
      // otherwise jumps for a bounded window, then shoots from here.
      if (this.aiStall >= 1.5 && worm.onGround) {
        if (!planInReach && this.aiRopeCount < 2) {
          if (this.aiRopeDeadline === null) {
            this.aiRopeDeadline = this.timeLeft - AI.ropeWindowSeconds;
          }
          if (this.timeLeft > this.aiRopeDeadline) {
            const ropePlan = planRopeClimb(
              this.terrain,
              { id: worm.id, teamId: worm.teamId, x: worm.x, y: worm.y },
              plan.fireX,
              planTarget,
            );
            if (ropePlan) {
              this.aimAt(ropePlan.angle, this.power);
              this.toggleRope();
              if (worm.rope) {
                this.logDebug('ai.rope', 'AI used rope after block', { wormId: worm.id, ropeCount: this.aiRopeCount, fromX: worm.x, fireX: plan.fireX }, 'cpu', worm.id);
                this.aiStall = 0;
                this.aiLastX = worm.x;
                return;
              }
            }
          }
        } else if (this.aiJumpCount < 2 && (this.aiJumpDeadline === null || this.timeLeft > this.aiJumpDeadline)) {
          if (this.aiJumpDeadline === null) {
            this.aiJumpDeadline = this.timeLeft - AI.jumpWindowSeconds;
          }
          this.aiJump(this.moveDir);
          this.aiJumpCount += 1;
          this.logDebug('ai.jump', 'AI jumped', { wormId: worm.id, jumpCount: this.aiJumpCount, fromX: worm.x, dir: this.moveDir }, 'cpu', worm.id);
          this.aiStall = 0;
          this.aiLastX = worm.x;
          return;
        }
      }

      this.moveDir = 0;
      const target = this.nearestEnemy(worm);
      if (target) {
        this.logDebug('ai.fallback', 'AI falling back to shot from current position', { wormId: worm.id, targetId: target.id, targetTeam: target.teamId, fromX: worm.x }, 'cpu', worm.id, 'warn');
        const shot = planAiShot(
          this.terrain,
          { id: worm.id, teamId: worm.teamId, x: worm.x, y: worm.y, hp: worm.hp },
          this.aliveAiWorms(),
          this.wind,
          DIFFICULTY[this.config.difficulty],
          this.rng,
        );
        if (!shot) {
          this.logDebug('ai.noFallbackShot', 'AI found no damaging fallback shot', { wormId: worm.id, targetId: target.id, x: worm.x, y: worm.y }, 'cpu', worm.id, 'warn');
          this.aiPlan = null;
          this.aiThinking = false;
          this.finishTurn();
          return;
        }
        this.logDebug('ai.fallbackShot', 'AI computed fallback shot', { wormId: worm.id, targetId: target.id, angle: shot.angle, power: shot.power }, 'cpu', worm.id);
        // Retarget once, then give the visible reticle time to reach this fallback shot.
        this.aiPlan = {
          ...plan,
          weapon: 'bazooka',
          fireX: worm.x,
          fireY: worm.y,
          angle: clampAngle(shot.angle),
          power: shot.power,
        };
        this.weapon = 'bazooka';
        this.moveDir = 0;
        return;
      }
      this.aiThinking = false;
      this.finishTurn();
      return;
    }

    this.moveDir = 0;
    // update() slews the reticle each frame; never fire along a different angle.
    if (Math.abs(clampAngle(plan.angle) - worm.aimAngle) > 1e-6) return;
    if (!this.aiShotIsUseful(worm, plan.weapon, plan.retreatX)) {
      this.logDebug('ai.planInvalid', 'AI plan no longer damages an enemy from the firing pose', { wormId: worm.id, weapon: plan.weapon, angle: worm.aimAngle, power: Math.max(0.12, this.power), x: worm.x, y: worm.y }, 'cpu', worm.id, 'warn');
      this.aiPlan = null;
      this.aiThinking = false;
      this.finishTurn();
      return;
    }
    this.weapon = plan.weapon;
    this.aiThinking = false;
    this.logDebug('ai.fire', 'AI fired', { wormId: worm.id, weapon: plan.weapon, angle: worm.aimAngle, power: Math.max(0.12, this.power), x: worm.x, y: worm.y }, 'cpu', worm.id);
    this.fire();
  }

  update(dt: number): void {
    if (this.phase === 'gameover') return;
    this.tick += 1;
    this.elapsed += dt;

    if (this.charging) {
      this.power = Math.min(1, this.power + dt / CHARGE_SECONDS);
    }

    if (this.retreatActive) {
      this.retreatTimer = Math.max(0, this.retreatTimer - dt);
      if (this.retreatTimer === 0) this.moveDir = 0;
    }

    if (this.teams[this.activeTeam].isAi) this.updateAi(dt);

    for (const t of this.teams) for (const w of t.worms) this.stepWorm(w, dt);
    if (this.phase === 'aim' && this.activeWorm && !this.activeWorm.alive) this.finishTurn();
    if ((this.phase as string) !== 'gameover') this.stepMobs(dt);
    this.updateLoot(dt);

    // Only aim once the CPU stops: the animation is the tell that it is about to fire.
    if (this.aiAiming && this.aiPlan) this.steerAiAim(this.aiPlan.angle, this.aiPlan.power, dt);

    if (this.phase === 'projectile') {
      this.stepProjectiles(dt);
      // stepProjectiles can finish the match; do not overwrite gameover with settle.
      if (this.projectiles.length === 0 && this.phase === 'projectile') {
        this.phase = 'settle';
        this.settleTimer = 0.85;
      }
    } else if (this.phase === 'settle') {
      this.settleTimer -= dt;
      if (this.settleTimer <= 0 && this.retreatTimer <= 0) this.finishTurn();
    } else if (this.phase === 'aim') {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      if (this.timeLeft <= 0) this.finishTurn();
    }
  }

  snapshot(): GameSnapshot {
    const active = this.activeWorm;
    const teams = this.teams.map((team) => {
      const hp = team.worms.reduce((sum, w) => sum + (w.alive ? w.hp : 0), 0);
      return {
        id: team.id,
        name: team.name,
        accent: team.accent,
        isAi: team.isAi,
        hp: Math.round(hp),
        maxHp: team.worms.length * WORM.maxHp,
        ammo: { ...team.ammo },
        worms: team.worms.map((w) => ({
          id: w.id,
          name: w.name,
          hp: Math.round(w.hp),
          maxHp: w.maxHp,
          alive: w.alive,
          active: w.id === this.activeWormId,
          x: w.x,
          y: w.y,
        })),
      };
    });
    return {
      phase: this.phase,
      turn: this.turn,
      timeLeft: this.timeLeft,
      turnSeconds: this.config.turnSeconds,
      wind: this.wind,
      windLabel: '',
      activeTeam: this.activeTeam,
      activeWormId: this.activeWormId,
      activeWormName: active?.name ?? '',
      aimAngle: active?.aimAngle ?? 0,
      power: this.power,
      charging: this.charging,
      weapon: this.weapon,
      teams,
      winnerTeam: this.winnerTeam,
      endReason: this.endReason,
      aiThinking: this.aiThinking,
      retreatLeft: this.retreatActive ? this.retreatTimer : 0,
      activeOnGround: active?.onGround ?? true,
      ropeAttached: Boolean(active?.rope),
      loot: this.loot.filter(l=>l.x>=0).map(l=>({x:l.x,y:l.y,kind:l.kind,armed:l.armed,fuse:l.fuse})),
      mobs: this.mobs.filter(m=>m.alive).map(m=>({x:m.x,y:m.y,hp:m.hp})),
      waterLevel: WATER_Y,
      revengeByTeam: { ...this.revengeFocusByTeam },
      fuseLeft: this.projectiles.reduce<number | null>((soonest, p) => {
        if (p.fuse === null) return soonest;
        const left = Math.max(0, p.fuse - p.age);
        return soonest === null ? left : Math.min(soonest, left);
      }, null),
    };
  }

  scoreFor(teamId: number): number {
    const team = this.teams[teamId];
    const survivors = team.worms.reduce((sum, w) => sum + (w.alive ? w.hp : 0), 0);
    const bonus = this.winnerTeam === teamId ? 150 : 0;
    const timeBonus = this.winnerTeam === teamId ? Math.max(0, Math.round(420 - this.elapsed)) : 0;
    return Math.round(this.kills[teamId] * 100 + survivors + bonus + timeBonus);
  }
}
