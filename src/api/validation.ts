// Pure online-match validation shared by the Lambda handler and the TS mock.
// Single source of truth (issue #209): the Lambda consumes the esbuild bundle
// (infra/lambda/validation.cjs, same pattern as engine.cjs) so this file stays
// free of AWS and build coupling; the weapons table is injected.

export const AIM_ONLY = [
  'move',
  'aim',
  'aimAt',
  'setPower',
  'jump',
  'rope',
  'reel',
  'weapon',
  'startCharge',
  'releaseCharge',
];

export const MAX_ACTION_BYTES = 512;
export const ACTION_CAP = 500;

export type OnlineActionLike = { type: string; [k: string]: unknown };

export function isDirection(value: unknown): value is -1 | 0 | 1 {
  return value === -1 || value === 0 || value === 1;
}

export function isStr(value: unknown, max = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isNum(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function validateAction(action: OnlineActionLike, weapons: Record<string, unknown>): string | null {
  const only = (keys: string[]) => Object.keys(action).every((key) => keys.includes(key));
  const type = action.type;
  if (type === 'move' || type === 'reel') {
    return only(['type', 'dir']) && isDirection(action.dir) ? null : 'invalid action';
  }
  if (type === 'aim') {
    return only(['type', 'delta']) && typeof action.delta === 'number' && Number.isFinite(action.delta)
      ? null
      : 'invalid action';
  }
  // Absolute aim/power must stay inside the arc and charge range pointer
  // input can produce (src/game/config.ts AIM, engine.setAim/setPower clamp).
  // Spoofed values outside these bounds are rejected instead of clamped so a
  // hostile client cannot hide behind the clamp (issue #280).
  if (type === 'aimAt') {
    return only(['type', 'angle']) &&
      typeof action.angle === 'number' &&
      Number.isFinite(action.angle) &&
      action.angle >= -3.04 &&
      action.angle <= -0.1
      ? null
      : 'invalid action';
  }
  if (type === 'setPower') {
    return only(['type', 'power']) &&
      typeof action.power === 'number' &&
      Number.isFinite(action.power) &&
      action.power >= 0 &&
      action.power <= 1
      ? null
      : 'invalid action';
  }
  if (type === 'jump') {
    return only(['type', 'dir']) && (action.dir === undefined || isDirection(action.dir)) ? null : 'invalid action';
  }
  if (type === 'weapon') {
    if (!only(['type', 'id'])) return 'invalid action';
    return typeof action.id === 'string' && Object.prototype.hasOwnProperty.call(weapons, action.id)
      ? null
      : 'unknown weapon';
  }
  if (['rope', 'startCharge', 'releaseCharge', 'fire', 'endTurn'].includes(type)) {
    return only(['type']) ? null : 'invalid action';
  }
  return 'unknown action type';
}

export interface MatchBodyLike {
  clientMatchId?: unknown;
  playerId?: unknown;
  playerName?: unknown;
  teamName?: unknown;
  score?: unknown;
  durationSeconds?: unknown;
  kills?: unknown;
  turnSeconds?: unknown;
  wind?: unknown;
  difficulty?: unknown;
  map?: unknown;
  mode?: unknown;
  loadout?: unknown;
  endReason?: unknown;
}

export function validateBody(body: MatchBodyLike | null | undefined): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid body';
  if (!isStr(body.clientMatchId)) return 'clientMatchId is required';
  if (!isStr(body.playerId)) return 'playerId is required';
  if (!isStr(body.playerName)) return 'playerName is required';
  if (!isStr(body.teamName)) return 'teamName is required';
  if (body.score !== undefined && !isNum(body.score, 0, 1e9)) return 'score out of range';
  if (body.durationSeconds !== undefined && !isNum(body.durationSeconds, 0, 1e6)) {
    return 'durationSeconds out of range';
  }
  if (body.kills !== undefined && !isNum(body.kills, 0, 10000)) return 'kills out of range';
  if (body.turnSeconds !== undefined && !isNum(body.turnSeconds, 1, 600)) return 'turnSeconds out of range';
  if (body.wind !== undefined && !['off', 'light', 'strong'].includes(body.wind as string)) return 'invalid wind';
  if (body.difficulty !== undefined && !['rookie', 'veteran', 'elite'].includes(body.difficulty as string)) {
    return 'invalid difficulty';
  }
  if (body.map !== undefined && !['island', 'mesa', 'canyon', 'desert', 'arctic'].includes(body.map as string)) {
    return 'invalid map';
  }
  if (body.mode !== undefined && !['deathmatch', 'assassinate', 'sudden-death', 'fort'].includes(body.mode as string)) {
    return 'invalid mode';
  }
  if (body.loadout !== undefined && !['default', 'heavy', 'scout'].includes(body.loadout as string)) {
    return 'invalid loadout';
  }
  if (body.endReason !== undefined && !['time', 'wipeout', 'surrender'].includes(body.endReason as string)) {
    return 'invalid endReason';
  }
  return null;
}

// Phase gate for online actions. Returns { status, message } when the action
// is illegal in the current phase, or null when it may proceed to replay.
export function checkActionPhase(input: { phase: string; type: string; hasFired: boolean }): {
  status: number;
  message: string;
} | null {
  const current = input.phase || 'aim';
  if (current === 'gameover') return { status: 409, message: 'match finished' };
  if (input.type === 'fire' || input.type === 'startCharge') {
    if (current !== 'aim' || input.hasFired) return { status: 409, message: 'illegal action for current phase' };
    return null;
  }
  if (input.type === 'endTurn') {
    const endingShot = input.hasFired && (current === 'projectile' || current === 'settle');
    if (current !== 'aim' && !endingShot) return { status: 409, message: 'illegal action for current phase' };
    return null;
  }
  if (AIM_ONLY.includes(input.type)) {
    if (current !== 'aim') return { status: 409, message: 'illegal action for current phase' };
    return null;
  }
  return { status: 400, message: 'unknown action type' };
}

export interface ExpiryMatchLike {
  turnStartedAt?: string | null;
  turnSeconds?: number | null;
}

export function isTurnExpired(match: ExpiryMatchLike, nowMs: number): boolean {
  if (!match || !match.turnStartedAt) return false;
  const ts = match.turnSeconds != null ? match.turnSeconds : 45;
  return nowMs - new Date(match.turnStartedAt).getTime() >= ts * 1000;
}

export interface AdvanceMatchLike {
  activeTeam: number;
  turn: number;
  players: Array<{ playerId?: string } | null>;
}

// Pure next-turn computation; the caller persists it (DynamoDB conditional
// update on the Lambda, in-memory mutation on the mock).
export function expiredTurnUpdate(match: AdvanceMatchLike, nowIso: string): {
  activeTeam: number;
  turn: number;
  turnStartedAt: string;
  phase: string;
  hasFired: boolean;
  weapon: string;
  snapshot: null;
  snapshotTick: null;
} {
  const players = Array.isArray(match.players) ? match.players : [];
  const n = players.length;
  let nextTeam = match.activeTeam;
  for (let i = 1; i <= n; i += 1) {
    const idx = (match.activeTeam + i) % n;
    if (players[idx] && players[idx].playerId) {
      nextTeam = idx;
      break;
    }
  }
  return {
    activeTeam: nextTeam,
    turn: (match.turn || 1) + 1,
    turnStartedAt: nowIso,
    phase: 'aim',
    hasFired: false,
    weapon: 'bazooka',
    snapshot: null,
    snapshotTick: null,
  };
}
