export type WeaponId = 'bazooka' | 'grenade' | 'shotgun' | 'dynamite' | 'medkit' | 'shield';
export type MapId = 'island' | 'mesa' | 'canyon' | 'desert' | 'arctic';
export type ModeId = 'deathmatch' | 'assassinate' | 'sudden-death' | 'fort';
export type LoadoutId = 'default' | 'heavy' | 'scout';
export type Difficulty = 'rookie' | 'veteran' | 'elite';
export type WindSetting = 'off' | 'light' | 'strong';
export type EndReason = 'time' | 'wipeout' | 'surrender';

/**
 * A serializable player input. AI decisions come from the engine's seeded RNG.
 * shortcut: pointer aim (`setAimFromPoint`) has no action yet; add an `aimAt`
 * action before recording real matches.
 */
export type GameAction =
  | { type: 'move'; dir: -1 | 0 | 1 }
  | { type: 'aim'; delta: number }
  | { type: 'jump'; dir?: -1 | 0 | 1 }
  | { type: 'rope' }
  | { type: 'reel'; dir: -1 | 0 | 1 }
  | { type: 'weapon'; id: WeaponId }
  | { type: 'startCharge' }
  | { type: 'releaseCharge' }
  | { type: 'fire' }
  | { type: 'endTurn' };

/** One recorded input, stamped with the tick it was applied before. */
export interface ActionLogEntry {
  tick: number;
  action: GameAction;
}

export interface GameSettings {
  turnSeconds: number;
  wind: WindSetting;
  difficulty: Difficulty;
  sound: boolean;
  map?: MapId;
  mode?: ModeId;
  loadout?: LoadoutId;
  wormsPerTeam?: number;
  hotseat?: boolean;
  teamCount?: number;
  teamNames?: string[];
}

export interface MatchConfig {
  turnSeconds: number;
  wind: WindSetting;
  difficulty: Difficulty;
  seed: number;
  wormsPerTeam: number;
  map?: MapId;
  mode?: ModeId;
  loadout?: LoadoutId;
  hotseat?: boolean;
  teamCount?: number;
  teamNames?: string[];
}

/** Stable identifier for a ruleset. Used to compare like-for-like on the board. */
export function configKey(config: Pick<MatchConfig, 'turnSeconds' | 'wind' | 'difficulty' | 'map' | 'mode' | 'loadout'>): string {
  return `${config.turnSeconds}s-${config.wind}-${config.difficulty}-${config.map ?? 'island'}-${config.mode ?? 'deathmatch'}-${config.loadout ?? 'default'}`;
}

export interface WeaponDef {
  id: WeaponId;
  /** `drop` weapons are placed at the worm's feet and have no aim reticle. */
  kind: 'projectile' | 'drop' | 'hitscan' | 'utility';
  name: string;
  ammo: number | null;
  damage: number;
  radius: number;
  terrainRadius: number;
  speedMin: number;
  speedMax: number;
  gravityScale: number;
  windScale: number;
  fuse: number | null;
  bounces: boolean;
  life: number | null;
  color: number;
  blurb: string;
  heal?: number;
  shield?: number;
}

/** A hanging rope. `angle` is measured from straight down; the pivot is the chest. */
export interface RopeState {
  anchorX: number;
  anchorY: number;
  length: number;
  angle: number;
  angularVelocity: number;
}

export interface Worm {
  id: string;
  name: string;
  teamId: number;
  x: number;
  y: number;
  vy: number;
  /** Horizontal flight velocity; walking uses `moveDir` instead. */
  vx: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  facing: 1 | -1;
  aimAngle: number;
  onGround: boolean;
  fallDistance: number;
  rope: RopeState | null;
  /** True while the worm is flying from an impulse (explosion/mine/shotgun). */
  launched: boolean;
  /** Visual rotation in radians (ragdoll spin). */
  rotation: number;
  /** Angular velocity in rad/s. */
  spin: number;
}

export interface Team {
  id: number;
  name: string;
  color: number;
  accent: string;
  isAi: boolean;
  worms: Worm[];
  ammo: Record<WeaponId, number>;
}

export interface Projectile {
  id: number;
  weapon: WeaponId;
  teamId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  fuse: number | null;
  trailTimer: number;
}

export type Phase = 'aim' | 'projectile' | 'settle' | 'gameover';

export type GameEvent =
  | { type: 'fire'; x: number; y: number; angle: number; weapon: WeaponId }
  | { type: 'explosion'; x: number; y: number; radius: number }
  | { type: 'mineExplosion'; x: number; y: number; radius: number }
  | { type: 'hurt'; x: number; y: number; amount: number }
  | { type: 'death'; x: number; y: number; color: number }
  | { type: 'splash'; x: number; y: number }
  | { type: 'bounce'; x: number; y: number }
  | { type: 'jump'; x: number; y: number }
  | { type: 'rope'; x: number; y: number }
  | { type: 'turn'; teamId: number; wormId: string }
  | { type: 'gameover'; winnerTeamId: number | null }
  | { type: 'shotgun'; x: number; y: number; angle: number }
  | { type: 'impact'; x: number; y: number };

export interface WormSnapshot {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  active: boolean;
  x: number;
  y: number;
}

export interface TeamSnapshot {
  id: number;
  name: string;
  accent: string;
  isAi: boolean;
  hp: number;
  maxHp: number;
  worms: WormSnapshot[];
  ammo: Record<WeaponId, number>;
}

export type DebugLogLevel = 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  seq: number;
  sessionId: string;
  matchId: string;
  t: number;
  tick: number;
  turn: number;
  actorType: 'cpu' | 'mob' | 'system';
  actorId?: string;
  category: string;
  level: DebugLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface GameSnapshot {
  phase: Phase;
  turn: number;
  timeLeft: number;
  turnSeconds: number;
  wind: number;
  windLabel: string;
  activeTeam: number;
  activeWormId: string | null;
  activeWormName: string;
  aimAngle: number;
  power: number;
  charging: boolean;
  weapon: WeaponId;
  teams: TeamSnapshot[];
  winnerTeam: number | null;
  /** Why the match ended; null while it is still running. */
  endReason: EndReason | null;
  aiThinking: boolean;
  /** Seconds left in the post-fire movement window. */
  retreatLeft: number;
  /** Whether the active worm is standing on terrain (jumping is only legal from the ground). */
  activeOnGround: boolean;
  /** Whether the active worm is hanging from a rope. */
  ropeAttached: boolean;
  /** Shortest lit fuse among projectiles in flight, or null. */
  fuseLeft: number | null;
  loot: { x: number; y: number; kind: 'ammo' | 'mine' | 'secret'; armed: boolean; fuse: number }[];
  mobs: { x: number; y: number; hp: number }[];
  /** Water level used for drowning checks. */
  waterLevel: number;
  /** Active revenge focus per team, when any. */
  revengeByTeam: Record<number, { x: number; y: number } | null>;
}
