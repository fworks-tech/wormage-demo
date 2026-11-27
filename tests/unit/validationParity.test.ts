import { createRequire } from 'node:module';
import { beforeEach, describe, expect, test } from 'vitest';
import { WEAPONS } from '../../src/game/engine';
import {
  createOnlineMatch,
  getOnlineMatch,
  joinOnlineMatch,
  registerMatch,
  resetOnlineMatches,
  submitOnlineAction,
} from '../../src/api/mockServer';

const requireCjs = createRequire(import.meta.url);
const shared = requireCjs('../../infra/lambda/validation.js') as {
  AIM_ONLY: string[];
  MAX_ACTION_BYTES: number;
  ACTION_CAP: number;
  validateAction: (action: unknown, weapons: unknown) => string | null;
  validateBody: (body: unknown) => string | null;
  checkActionPhase: (input: { phase: string; type: string; hasFired: boolean }) => { status: number; message: string } | null;
  isTurnExpired: (match: { turnStartedAt?: string | null; turnSeconds?: number | null }, nowMs: number) => boolean;
  expiredTurnUpdate: (
    match: { activeTeam: number; turn: number; players: Array<{ playerId?: string } | null> },
    nowIso: string,
  ) => { activeTeam: number; turn: number; turnStartedAt: string; phase: string; hasFired: boolean; weapon: string; snapshot: null; snapshotTick: null };
};

function onlinePair() {
  resetOnlineMatches();
  const created = createOnlineMatch({
    playerId: 'p1',
    playerName: 'Alice',
    settings: { seed: 11, wormsPerTeam: 2, turnSeconds: 45 },
  });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  return created.code;
}

describe('shared online validation (Lambda + mock single source)', () => {
  beforeEach(() => resetOnlineMatches());

  test('validateAction accepts well-formed actions', () => {
    const valid = [
      { type: 'move', dir: 1 },
      { type: 'reel', dir: -1 },
      { type: 'aim', delta: 0.5 },
      { type: 'aimAt', angle: -1.5 },
      { type: 'setPower', power: 1 },
      { type: 'jump' },
      { type: 'jump', dir: 0 },
      { type: 'weapon', id: 'bazooka' },
      { type: 'rope' },
      { type: 'fire' },
      { type: 'endTurn' },
    ];
    for (const action of valid) {
      expect(shared.validateAction(action, WEAPONS)).toBe(null);
    }
  });

  test('validateAction rejects malformed actions with Lambda messages', () => {
    const cases: Array<[unknown, string]> = [
      [{ type: 'move', dir: 5 }, 'invalid action'],
      [{ type: 'move' }, 'invalid action'],
      [{ type: 'move', dir: 1, extra: 1 }, 'invalid action'],
      [{ type: 'aim', delta: NaN }, 'invalid action'],
      [{ type: 'aimAt', angle: 0 }, 'invalid action'],
      [{ type: 'aimAt', angle: -3.05 }, 'invalid action'],
      [{ type: 'setPower', power: 2 }, 'invalid action'],
      [{ type: 'jump', dir: 2 }, 'invalid action'],
      [{ type: 'weapon', id: 'nuke' }, 'unknown weapon'],
      [{ type: 'weapon' }, 'invalid action'],
      [{ type: 'fire', x: 1 }, 'invalid action'],
      [{ type: 'dance' }, 'unknown action type'],
    ];
    for (const [action, message] of cases) {
      expect(shared.validateAction(action, WEAPONS)).toBe(message);
    }
  });

  test('checkActionPhase gates actions by phase', () => {
    expect(shared.checkActionPhase({ phase: 'aim', type: 'move', hasFired: false })).toBe(null);
    expect(shared.checkActionPhase({ phase: 'aim', type: 'fire', hasFired: false })).toBe(null);
    expect(shared.checkActionPhase({ phase: 'aim', type: 'endTurn', hasFired: false })).toBe(null);
    expect(shared.checkActionPhase({ phase: 'aim', type: 'fire', hasFired: true })).toEqual({
      status: 409,
      message: 'illegal action for current phase',
    });
    expect(shared.checkActionPhase({ phase: 'projectile', type: 'move', hasFired: true })).toEqual({
      status: 409,
      message: 'illegal action for current phase',
    });
    expect(shared.checkActionPhase({ phase: 'projectile', type: 'endTurn', hasFired: true })).toBe(null);
    expect(shared.checkActionPhase({ phase: 'settle', type: 'endTurn', hasFired: true })).toBe(null);
    expect(shared.checkActionPhase({ phase: 'settle', type: 'endTurn', hasFired: false })).toEqual({
      status: 409,
      message: 'illegal action for current phase',
    });
    expect(shared.checkActionPhase({ phase: 'gameover', type: 'move', hasFired: false })).toEqual({
      status: 409,
      message: 'match finished',
    });
    expect(shared.checkActionPhase({ phase: 'aim', type: 'dance', hasFired: false })).toEqual({
      status: 400,
      message: 'unknown action type',
    });
  });

  test('validateBody mirrors the Lambda postMatch contract', () => {
    const valid = { clientMatchId: 'c', playerId: 'p', playerName: 'P', teamName: 'T' };
    expect(shared.validateBody(valid)).toBe(null);
    expect(shared.validateBody(null)).toBe('invalid body');
    expect(shared.validateBody([])).toBe('invalid body');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...valid, clientMatchId: '' }, 'clientMatchId is required'],
      [{ ...valid, playerId: '' }, 'playerId is required'],
      [{ ...valid, playerName: '' }, 'playerName is required'],
      [{ ...valid, teamName: '' }, 'teamName is required'],
      [{ ...valid, score: 1e10 }, 'score out of range'],
      [{ ...valid, durationSeconds: -1 }, 'durationSeconds out of range'],
      [{ ...valid, kills: 10001 }, 'kills out of range'],
      [{ ...valid, turnSeconds: 0 }, 'turnSeconds out of range'],
      [{ ...valid, wind: 'hurricane' }, 'invalid wind'],
      [{ ...valid, difficulty: 'god' }, 'invalid difficulty'],
      [{ ...valid, map: 'moon' }, 'invalid map'],
      [{ ...valid, mode: 'race' }, 'invalid mode'],
      [{ ...valid, loadout: 'nuke' }, 'invalid loadout'],
      [{ ...valid, endReason: 'boredom' }, 'invalid endReason'],
    ];
    for (const [body, message] of cases) {
      expect(shared.validateBody(body)).toBe(message);
    }
  });

  test('turn-expiry helpers detect and compute the advance', () => {
    const now = Date.now();
    expect(shared.isTurnExpired({ turnStartedAt: new Date(now - 60_000).toISOString(), turnSeconds: 45 }, now)).toBe(true);
    expect(shared.isTurnExpired({ turnStartedAt: new Date(now).toISOString(), turnSeconds: 45 }, now)).toBe(false);
    expect(shared.isTurnExpired({ turnStartedAt: null, turnSeconds: 45 }, now)).toBe(false);
    expect(shared.isTurnExpired({ turnStartedAt: new Date(now - 60_000).toISOString(), turnSeconds: null }, now)).toBe(true);
    const update = shared.expiredTurnUpdate(
      { activeTeam: 0, turn: 1, players: [{ playerId: 'p1' }, { playerId: 'p2' }] },
      new Date(now).toISOString(),
    );
    expect(update).toMatchObject({ activeTeam: 1, turn: 2, phase: 'aim', hasFired: false, weapon: 'bazooka', snapshot: null, snapshotTick: null });
  });

  test('mock rejects invalid actions with the shared messages', () => {
    const code = onlinePair();
    const bad = submitOnlineAction(code, { playerId: 'p1', action: { type: 'move', dir: 9 }, clientActionId: 'bad-1' });
    expect(bad).toEqual({ error: 'invalid action', status: 400 });
    const weapon = submitOnlineAction(code, { playerId: 'p1', action: { type: 'weapon', id: 'nuke' }, clientActionId: 'bad-2' });
    expect(weapon).toEqual({ error: 'unknown weapon', status: 400 });
  });

  test('mock gates a fired turn with the shared phase message', () => {
    const code = onlinePair();
    const fired = submitOnlineAction(code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1' });
    expect('error' in fired).toBe(false);
    const gated = submitOnlineAction(code, { playerId: 'p1', action: { type: 'move', dir: 1 }, clientActionId: 'gated-1' });
    expect(gated).toEqual({ error: 'illegal action for current phase', status: 409 });
  });

  test('mock advances an expired turn like the Lambda', () => {
    const code = onlinePair();
    const match = getOnlineMatch(code);
    expect(match).not.toBe(null);
    match!.turnStartedAt = new Date(Date.now() - 120_000).toISOString();
    const advanced = getOnlineMatch(code);
    expect(advanced!.turn).toBe(2);
    expect(advanced!.phase).toBe('aim');
    expect(advanced!.hasFired).toBe(false);
  });

  test('mock registerMatch rejects partial bodies with the shared messages', () => {
    const bad = registerMatch({ clientMatchId: 'partial-1' } as never);
    expect(bad).toEqual({ error: shared.validateBody({ clientMatchId: 'partial-1' }), status: 400 });
    expect(shared.validateBody({ clientMatchId: 'partial-1' })).toBe('playerId is required');
  });
});
