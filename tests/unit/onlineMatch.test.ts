import { beforeEach, expect, test, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { GameEngine } from '../../src/game/engine';
import { api, apiMode } from '../../src/api/client';
import { onlineMatchRefetchInterval } from '../../src/api/queries';
import {
  createOnlineMatch,
  joinOnlineMatch,
  getOnlineMatch,
  submitOnlineAction,
  forfeitOnlineMatch,
  getActionLog,
  replayOnlineMatch,
  resetOnlineMatches,
} from '../../src/api/mockServer';

beforeEach(() => resetOnlineMatches());

test('create returns a 6-char code and stores the creator as first player', () => {
  const res = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', teamName: 'Ironclad' });
  expect(res.code).toMatch(/^[A-Z2-9]{6}$/);
  expect(res.link).toBe(`/online/${res.code}`);
  expect(res.match.players).toHaveLength(1);
  expect(res.match.players[0].playerId).toBe('p1');
  expect(res.match.status).toBe('waiting');
  expect(res.match.actionLogVersion).toBe(2);
  expect(getOnlineMatch(res.code)?.code).toBe(res.code);
});

test('online polling stops for every terminal match, including draws', () => {
  const { match } = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  expect(onlineMatchRefetchInterval(undefined)).toBe(false);
  expect(onlineMatchRefetchInterval({ ...match, status: 'waiting' })).toBe(2000);
  expect(onlineMatchRefetchInterval({ ...match, status: 'ready' })).toBe(1000);
  expect(onlineMatchRefetchInterval({ ...match, status: 'ready', winnerTeam: 1 })).toBe(false);
  expect(onlineMatchRefetchInterval({ ...match, status: 'finished', winnerTeam: null })).toBe(false);
});

test('join adds a second player and flips status to ready', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  const joined = joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  expect('error' in joined).toBe(false);
  if ('error' in joined) return;
  expect(joined.match.players).toHaveLength(2);
  expect(joined.match.status).toBe('ready');
});

test('duplicate join is idempotent', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const dup = joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  if ('error' in dup) throw new Error('unexpected error');
  expect(dup.match.players).toHaveLength(2);
});

test('joining a full match returns full', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const third = joinOnlineMatch(created.code, { playerId: 'p3', playerName: 'Carol' });
  expect(third).toEqual({ error: 'full' });
});

test('joining an unknown code returns not_found', () => {
  const res = joinOnlineMatch('ZZZZZZ', { playerId: 'p1', playerName: 'Alice' });
  expect(res).toEqual({ error: 'not_found' });
});

test('code lookup is case-insensitive', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  const joined = joinOnlineMatch(created.code.toLowerCase(), { playerId: 'p2', playerName: 'Bob' });
  expect('error' in joined).toBe(false);
});

// --- submitOnlineAction ---

test('submitAction advances turn on endTurn', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1' });
  expect('error' in res).toBe(false);
  if ('error' in res) return;
  expect(res.match.activeTeam).toBe(1);
  expect(res.match.turn).toBe(2);
});

test('firing a utility ends the turn without a projectile phase', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'weapon', id: 'medkit' }, clientActionId: 'weapon-medkit' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1' });
  if ('error' in res) throw new Error(res.error);
  expect(res.match.activeTeam).toBe(1);
  expect(res.match.turn).toBe(2);
  expect(res.match.phase).toBe('aim');
  expect(res.match.hasFired).toBe(false);
});

test('submitAction rejects not-your-turn with 409', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, { playerId: 'p2', action: { type: 'endTurn' }, clientActionId: 'endTurn-p2' });
  expect(res).toMatchObject({ error: 'not your turn', status: 409 });
});

test('submitAction rejects unknown action type with 400', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'teleport' }, clientActionId: 'teleport-1' });
  expect(res).toMatchObject({ error: 'unknown action type', status: 400 });
});

for (const [name, action] of [
  ['a non-numeric aim delta', { type: 'aim', delta: 'x' }],
  ['an aim angle above the pointer arc', { type: 'aimAt', angle: 0 }],
  ['an aim angle below the pointer arc', { type: 'aimAt', angle: -3.1 }],
  ['a non-numeric aim angle', { type: 'aimAt', angle: 'x' }],
  ['an aim angle with extra keys', { type: 'aimAt', angle: -1.2, delta: 0 }],
  ['a power above full charge', { type: 'setPower', power: 1.5 }],
  ['a negative power', { type: 'setPower', power: -0.5 }],
  ['a non-numeric power', { type: 'setPower', power: 'x' }],
  ['a missing movement direction', { type: 'move' }],
  ['an invalid reel direction', { type: 'reel', dir: 2 }],
  ['an invalid jump direction', { type: 'jump', dir: 0.5 }],
  ['unknown action fields', { type: 'endTurn', extra: true }],
] as const) {
  test(`submitAction rejects ${name} without writing`, () => {
    const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
    joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
    const res = submitOnlineAction(created.code, { playerId: 'p1', action, clientActionId: 'invalid-action' });
    expect(res).toMatchObject({ status: 400 });
    expect(getActionLog(created.code)).toHaveLength(0);
    expect(getOnlineMatch(created.code)?.revision).toBe(0);
    expect(getOnlineMatch(created.code)?.snapshot).toBeUndefined();
  });
}

test('submitAction accepts valid directional fields and an omitted jump direction', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  for (const [clientActionId, action] of [
    ['move-1', { type: 'move', dir: 0 }],
    ['jump-1', { type: 'jump' }],
    ['aim-1', { type: 'aim', delta: 0 }],
    ['aimAt-1', { type: 'aimAt', angle: -1.2 }],
    ['setPower-1', { type: 'setPower', power: 0.8 }],
  ] as const) {
    const res = submitOnlineAction(created.code, { playerId: 'p1', action, clientActionId });
    expect('error' in res).toBe(false);
  }
  expect(getActionLog(created.code)).toHaveLength(5);
});

test('submitAction rejects an oversized action without writing', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, {
    playerId: 'p1',
    action: { type: 'aim', delta: 0, padding: 'x'.repeat(1024) },
    clientActionId: 'oversized-action',
  });
  expect(res).toMatchObject({ status: 413 });
  expect(getActionLog(created.code)).toHaveLength(0);
  expect(getOnlineMatch(created.code)?.revision).toBe(0);
});

test('submitAction rejects illegal phase (fire during projectile)', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-2' });
  expect(res).toMatchObject({ error: 'illegal action for current phase', status: 409 });
});

test('submitAction is idempotent on clientActionId', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'abc' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'abc' });
  expect('error' in res).toBe(false);
  if ('error' in res) return;
  expect(res.match.turn).toBe(2); // not advanced again
  expect(res.duplicate).toBe(true);
});

test('submitAction requires clientActionId', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  // @ts-expect-error runtime validation must reject older clients.
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' } });
  expect(res).toMatchObject({ error: 'clientActionId is required', status: 400 });
  const invalid = submitOnlineAction(created.code, {
    playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 42,
  } as unknown as Parameters<typeof submitOnlineAction>[1]);
  expect(invalid).toMatchObject({ error: 'clientActionId is required', status: 400 });
  expect(getActionLog(created.code)).toHaveLength(0);
});

test('submitAction rejects clientActionId reuse with a different payload', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'reused' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'weapon', id: 'grenade' }, clientActionId: 'reused' });
  expect(res).toMatchObject({ error: 'clientActionId already used', status: 409 });
  expect(getActionLog(created.code)).toHaveLength(1);
});

test('submitAction returns a duplicate after the match has finished', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const body = { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'finished-retry' };
  submitOnlineAction(created.code, body);
  forfeitOnlineMatch(created.code, 'p1');
  const retry = submitOnlineAction(created.code, body);
  expect('error' in retry).toBe(false);
  if (!('error' in retry)) expect(retry.duplicate).toBe(true);
});

test('submitAction rejects non-participant with 403', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, { playerId: 'p3', action: { type: 'endTurn' }, clientActionId: 'endTurn-p3' });
  expect(res).toMatchObject({ error: 'not a participant', status: 403 });
});

test('submitAction rejects when match not ready', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1' });
  expect(res).toMatchObject({ error: 'match not ready', status: 409 });
});

// --- forfeitOnlineMatch ---

test('forfeit ends match with opponent as winner', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = forfeitOnlineMatch(created.code, 'p1');
  expect('error' in res).toBe(false);
  if ('error' in res) return;
  expect(res.match.winnerTeam).toBe(1);
  expect(res.match.endReason).toBe('surrender');
  expect(res.match.status).toBe('finished');
});

test('forfeit is idempotent', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  forfeitOnlineMatch(created.code, 'p1');
  const res = forfeitOnlineMatch(created.code, 'p2');
  expect('error' in res).toBe(false);
  if ('error' in res) return;
  expect(res.match.winnerTeam).toBe(1);
});

test('forfeit rejects non-participant with 403', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = forfeitOnlineMatch(created.code, 'p3');
  expect(res).toMatchObject({ error: 'not a participant', status: 403 });
});

test('forfeit returns 404 for unknown code', () => {
  const res = forfeitOnlineMatch('ZZZZZZ', 'p1');
  expect(res).toMatchObject({ error: 'match not found', status: 404 });
});

// --- turn expiry ---

test('a post-shot sync cannot cancel a projectile still in flight', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { seed: 777 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1', tick: 0 });

  const early = submitOnlineAction(created.code, {
    playerId: 'p1',
    action: { type: 'endTurn' },
    tick: 0,
    clientActionId: '0-endTurn-sync',
  });
  expect(early).toMatchObject({ error: 'shot still in flight', status: 409 });
  expect(getActionLog(created.code)).toHaveLength(1);
});

test('a post-shot sync hands over after the shot resolves without entering the log', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { seed: 777 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1', tick: 0 });

  const probe = new GameEngine({ turnSeconds: 45, wind: 'light', difficulty: 'veteran', seed: 777, wormsPerTeam: 3, hotseat: true });
  probe.applyAction({ type: 'fire' });
  while (probe.turn === 1 && probe.tick < 600) probe.update(1 / 60);
  const clientActionId = `${probe.turn}-endTurn-sync`;
  const synced = submitOnlineAction(created.code, {
    playerId: 'p1',
    action: { type: 'endTurn' },
    tick: probe.tick,
    clientActionId,
  });
  if ('error' in synced) throw new Error(synced.error);
  expect(synced.match.activeTeam).toBe(1);
  expect(synced.match.phase).toBe('aim');
  expect(synced.match.hasFired).toBe(false);
  expect(getActionLog(created.code)).toHaveLength(1);

  const duplicate = submitOnlineAction(created.code, {
    playerId: 'p1',
    action: { type: 'endTurn' },
    tick: probe.tick,
    clientActionId,
  });
  expect('error' in duplicate).toBe(false);
  if (!('error' in duplicate)) expect(duplicate.match.activeTeam).toBe(1);
});

test('getOnlineMatch advances turn when expired', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 0 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  // turnSeconds=0 means immediately expired
  const m = getOnlineMatch(created.code);
  expect(m).not.toBeNull();
  expect(m!.turn).toBe(2);
  expect(m!.activeTeam).toBe(1);
  expect(m!.phase).toBe('aim');
  expect(m!.snapshot).toBeNull();
  expect(m!.snapshotTick).toBeNull();
});

test('a fired turn hands over without waiting for the timer', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 0, seed: 777 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const fired = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1' });
  if ('error' in fired) throw new Error(fired.error);
  expect(fired.match.phase).toBe('projectile');

  const expired = getOnlineMatch(created.code);
  expect(expired?.turn).toBe(2);
  expect(expired?.activeTeam).toBe(1);
  expect(expired?.phase).toBe('aim');
  expect(expired?.hasFired).toBe(false);
});

test('submitAction rejects an unknown weapon without changing the match', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });

  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'weapon', id: 'nuke' }, clientActionId: 'weapon-nuke' });
  expect(res).toMatchObject({ error: 'unknown weapon', status: 400 });
  const inherited = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'weapon', id: 'toString' }, clientActionId: 'weapon-inherited' });
  expect(inherited).toMatchObject({ error: 'unknown weapon', status: 400 });
  expect(getOnlineMatch(created.code)?.weapon).toBeUndefined();
  expect(getActionLog(created.code)).toHaveLength(0);
});

test('submitAction rejects a release with no charge', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });

  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'releaseCharge' }, clientActionId: 'release-1', tick: 0 });
  expect(res).toMatchObject({ error: 'release had no effect', status: 409 });
  expect(getActionLog(created.code)).toHaveLength(0);
});

test('a sync cannot succeed when no shot reached the server', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });

  const res = submitOnlineAction(created.code, {
    playerId: 'p1',
    action: { type: 'endTurn' },
    clientActionId: '1-endTurn-sync',
    tick: 10,
  });
  expect(res).toMatchObject({ error: 'shot not found', status: 409 });
});

test('an action stamped after the turn expires cannot fire on the opponent worm', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 45, seed: 777 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });

  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-stale', tick: 2701 });
  expect(res).toMatchObject({ error: 'stale action tick', status: 409 });
  expect(getOnlineMatch(created.code)?.activeTeam).toBe(0);
  expect(getActionLog(created.code)).toHaveLength(0);
});

test('getOnlineMatch does not advance when not expired', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 9999 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const m = getOnlineMatch(created.code);
  expect(m).not.toBeNull();
  expect(m!.turn).toBe(1);
  expect(m!.activeTeam).toBe(0);
});


test('getActionLog returns entries in replay order', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'weapon', id: 'grenade' }, clientActionId: 'a1', tick: 5 });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'a2', tick: 6 });
  const log = getActionLog(created.code);
  expect(log).toHaveLength(2);
  expect(log[0].seq).toBe(1);
  expect(log[1].seq).toBe(2);
  expect((log[0].action as { type: string }).type).toBe('weapon');
});

test('replayOnlineMatch returns a snapshot', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'e1' });
  const r = replayOnlineMatch(created.code);
  expect(r).not.toBeNull();
  expect(r!.snapshot).toBeTruthy();
  expect(r!.snapshot.teams.map((team) => team.isAi)).toEqual([false, false]);
  expect(typeof r!.tick).toBe('number');
});

test('local adapter returns legacy 410 on every online route', async () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  (created.match as { actionLogVersion?: number }).actionLogVersion = undefined;
  const base = `/api/matches/online/${created.code}`;
  const legacy = { response: { status: 410, data: { message: 'legacy online match is no longer supported' } } };
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  try {
    expect(apiMode()).toBe('local');
    await expect(api.get(base)).rejects.toMatchObject(legacy);
    await expect(api.get(`${base}/replay`)).rejects.toMatchObject(legacy);
    await expect(api.post(`${base}/join`, { playerId: 'p2', playerName: 'Bob' })).rejects.toMatchObject(legacy);
    await expect(api.post(`${base}/action`, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'legacy-action' })).rejects.toMatchObject(legacy);
    await expect(api.post(`${base}/forfeit`, { playerId: 'p1' })).rejects.toMatchObject(legacy);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('MSW handlers return legacy 410 on every online route', async () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  (created.match as { actionLogVersion?: number }).actionLogVersion = undefined;
  const base = `http://localhost/api/matches/online/${created.code}`;
  vi.stubGlobal('location', new URL('http://localhost'));
  const { handlers } = await import('../../src/mocks/handlers');
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });
  try {
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['GET', '/replay', undefined],
      ['POST', '/join', { playerId: 'p2', playerName: 'Bob' }],
      ['POST', '/action', { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'legacy-action' }],
      ['POST', '/forfeit', { playerId: 'p1' }],
    ] as const) {
      const response = await fetch(`${base}${suffix}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ message: 'legacy online match is no longer supported' });
    }
  } finally {
    server.close();
    vi.unstubAllGlobals();
  }
});
