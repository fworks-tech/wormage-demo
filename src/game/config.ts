import { configKey } from './types';
import type { Difficulty, GameSettings, WeaponId, WindSetting } from './types';
import { WEAPONS as CONTENT_WEAPONS, WEAPON_ORDER as CONTENT_WEAPON_ORDER } from '../content/weapons';

export const BASE_W = 1280;
export const BASE_H = 720;
const scaleParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mapSize') : null;
export const WORLD_SCALE = scaleParam === '1' ? 1 : 3;
export const WORLD_W = BASE_W * WORLD_SCALE;
export const WORLD_H = BASE_H * WORLD_SCALE;
export const WATER_Y = 668;

export const GRAVITY = 780;
export const PROJECTILE_GRAVITY = 520;
export const WIND_FACTOR = 0.9;
export const BOUNCE = { x: 0.45, y: 0.42 } as const;
export const WIND_ACCEL: Record<WindSetting, number> = {
  off: 0,
  light: 46,
  strong: 105,
};

/** AI movement heuristics. */
export const AI = {
  /** How long a blocked AI walk may keep jumping before it shoots from where it stands. */
  jumpWindowSeconds: 2,
  /** How long the AI may try to climb a ledge with the rope before it gives up. */
  ropeWindowSeconds: 4,
  /** Maximum CPU reticle rotation speed, in radians per second. */
  aimRadiansPerSecond: 8.5,
  /** Whether to veto candidate shots that would hurt allies/self beyond tolerance. */
  friendlyFireVeto: true,
  /** Veto candidate shots that deal more than this much damage to allies/self. */
  friendlyFireTolerance: 8,
  /** Extra score for landing a hit on the lowest-HP enemy (focus fire). */
  focusFireBonus: 0,
  /** Extra score for hitting an enemy that can reach our worms. */
  threatBonus: 22,
  /** Distance (px) within which an enemy counts as a threat to our worms. */
  threatRadius: 320,
  /** Flat aggression bonus while revenge is active. */
  revengeBonus: 0,
  /** Turns before revenge state clears. */
  revengeDecayTurns: 2,
} as const;

export const WORM = {
  radius: 11,
  walkSpeed: 74,
  jumpVelocity: 300,
  /** Horizontal carry of a front/back jump, in px/s. */
  jumpPush: 180,
  maxHp: 100,
  fallSafePx: 150,
  fallDamagePerPx: 0.16,
  /** Ragdoll tuning: impulse = (damage/100) * knockbackScale * impulseScale. */
  knockbackScale: 260,
  knockbackMax: 320,
  restitution: 0.35,
  wallRestitution: 0.4,
  spinScale: 6,
  landingStopSpeed: 60,
} as const;

/** Peak height of a jump, derived so planning and physics cannot drift. */
export const JUMP_REACH = (WORM.jumpVelocity * WORM.jumpVelocity) / (2 * GRAVITY);

/** Loot physics: items fall, settle on terrain and get thrown by blasts. */
export const LOOT = {
  /** Half-height used to rest the item on the ground. */
  radius: 5,
  gravity: 720,
  restitution: 0.3,
  /** Speed above which a landing bounces instead of stopping. */
  bounceSpeed: 90,
  /** Ground friction per step while resting. */
  friction: 0.7,
  /** Push at the centre of a blast, scaled down with distance. */
  blastSpeed: 260,
} as const;

/** Anchored rope. `angle` is measured from straight down; `range` is also the max length. */
export const ROPE = {
  range: 220,
  minLength: 24,
  reelSpeed: 130,
  /** Angular acceleration from holding left/right, in rad/s². */
  swingAccel: 3.5,
  /** Per-step damping, so a swing eventually settles. */
  damping: 0.999,
  maxAngularSpeed: 4,
} as const;

export const AIM = {
  min: -3.04,
  max: -0.1,
  rate: 1.35,
  radius: 130,
} as const;

/** Simulation step. Gameplay math advances only in these steps (ADR 0005). */
export const FIXED_DT = 1 / 60;

export const CHARGE_SECONDS = 1.1;

/** Movement window after firing, before the turn passes. */
export const RETREAT_SECONDS = 3;

/** Free-flight span the dotted aim preview samples for weapons with no fuse or life. */
export const PREVIEW_SECONDS = 3;

export const WEAPONS = CONTENT_WEAPONS;
export const WEAPON_ORDER = CONTENT_WEAPON_ORDER as WeaponId[];

export const TEAM_PALETTE = [
  { name: 'Ironclad', color: 0xf05d8f, accent: '#f05d8f' },
  { name: 'Rustbelt', color: 0x4ad6d0, accent: '#4ad6d0' },
  { name: 'Verdant', color: 0x9ee37d, accent: '#9ee37d' },
  { name: 'Amber', color: 0xf4c95d, accent: '#f4c95d' },
] as const;

/** Pool used by the dice generator for random default team names. */
export const TEAM_NAME_POOL = [
  'Ironclad', 'Rustbelt', 'Verdant', 'Amber', 'Cinder', 'Frost', 'Vanguard', 'Nomad',
  'Ashen', 'Gilded', 'Storm', 'Hollow', 'Ember', 'Tundra', 'Cobalt', 'Sable',
] as const;

export function randomTeamName(rng: () => number = Math.random): string {
  const idx = Math.min(TEAM_NAME_POOL.length - 1, Math.floor(rng() * TEAM_NAME_POOL.length));
  return TEAM_NAME_POOL[idx];
}


export const DIFFICULTY: Record<
  Difficulty,
  { label: string; angleError: number; powerError: number; blurb: string }
> = {
  rookie: { label: 'Rookie', angleError: 0.075, powerError: 0.09, blurb: 'Loose aim, forgiving.' },
  veteran: { label: 'Veteran', angleError: 0.035, powerError: 0.045, blurb: 'Reads the wind.' },
  elite: { label: 'Elite', angleError: 0.012, powerError: 0.015, blurb: 'Almost no mercy.' },
};

export const TURN_SECONDS = { min: 20, max: 90, step: 5 } as const;

export const DEFAULT_SETTINGS: GameSettings = {
  turnSeconds: 45,
  wind: 'light',
  difficulty: 'veteran',
  sound: true,
  map: 'island',
  mode: 'deathmatch',
  loadout: 'default',
  wormsPerTeam: 3,
  hotseat: false,
};

export function sanitizeSettings(input: Partial<GameSettings> | null | undefined): GameSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
  const turns = Number(merged.turnSeconds);
  return {
    turnSeconds: Number.isFinite(turns)
      ? Math.min(TURN_SECONDS.max, Math.max(TURN_SECONDS.min, Math.round(turns / TURN_SECONDS.step) * TURN_SECONDS.step))
      : DEFAULT_SETTINGS.turnSeconds,
    wind: merged.wind === 'off' || merged.wind === 'light' || merged.wind === 'strong' ? merged.wind : 'light',
    difficulty:
      merged.difficulty === 'rookie' || merged.difficulty === 'veteran' || merged.difficulty === 'elite'
        ? merged.difficulty
        : 'veteran',
    sound: Boolean(merged.sound),
    map: (['island','mesa','canyon','desert','arctic'] as const).includes(merged.map as any) ? merged.map : 'island',
    mode: (['deathmatch','assassinate','sudden-death','fort'] as const).includes(merged.mode as any) ? merged.mode : 'deathmatch',
    loadout: (['default','heavy','scout'] as const).includes(merged.loadout as any) ? merged.loadout : 'default',
    wormsPerTeam: typeof merged.wormsPerTeam === 'number' ? Math.min(8, Math.max(1, Math.round(merged.wormsPerTeam))) : 3,
    hotseat: Boolean(merged.hotseat),
    teamCount:
      typeof merged.teamCount === 'number'
        ? Math.min(4, Math.max(2, Math.round(merged.teamCount)))
        : 2,
    teamNames: Array.isArray(merged.teamNames)
      ? merged.teamNames
          .slice(0, 4)
          .map((n) => (typeof n === 'string' && n.trim() ? n.trim() : ''))
      : undefined,
  };
}

export function worldClamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type WindTier = 'calm' | 'breeze' | 'gust' | 'gale';

/** Visual and spoken wind strength; the gauge and label read from the same tiers. */
export function windTier(wind: number): WindTier {
  const speed = Math.abs(wind);
  if (speed < 6) return 'calm';
  if (speed < 35) return 'breeze';
  if (speed < 75) return 'gust';
  return 'gale';
}

export function windLabel(wind: number): string {
  const tier = windTier(wind);
  return tier === 'calm' ? tier : `${tier} ${wind > 0 ? '→' : '←'}`;
}

/** Human-readable ruleset label, mirrored in the menu and the archive tables. */
export function configLabel(settings: Pick<GameSettings, 'turnSeconds' | 'wind' | 'difficulty'>): string {
  return `${settings.turnSeconds}s · ${settings.wind} wind · ${DIFFICULTY[settings.difficulty].label}`;
}

export function configKeyFrom(settings: Pick<GameSettings, 'turnSeconds' | 'wind' | 'difficulty' | 'map' | 'mode' | 'loadout'>): string {
  return configKey(settings);
}
