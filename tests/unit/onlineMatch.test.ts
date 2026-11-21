import { beforeEach, expect, test } from 'vitest';
import {
  createOnlineMatch,
  joinOnlineMatch,
  getOnlineMatch,
  submitOnlineAction,
  forfeitOnlineMatch,
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
  expect(getOnlineMatch(res.code)?.code).toBe(res.code);
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
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' } });
  expect('error' in res).toBe(false);
  if ('error' in res) return;
  expect(res.match.activeTeam).toBe(1);
  expect(res.match.turn).toBe(2);
});

test('submitAction rejects not-your-turn with 409', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, { playerId: 'p2', action: { type: 'endTurn' } });
  expect(res).toMatchObject({ error: 'not your turn', status: 409 });
});

test('submitAction rejects unknown action type with 400', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'teleport' } });
  expect(res).toMatchObject({ error: 'unknown action type', status: 400 });
});

test('submitAction rejects illegal phase (fire during projectile)', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' } });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'fire' } });
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
});

test('submitAction rejects non-participant with 403', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const res = submitOnlineAction(created.code, { playerId: 'p3', action: { type: 'endTurn' } });
  expect(res).toMatchObject({ error: 'not a participant', status: 403 });
});

test('submitAction rejects when match not ready', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice' });
  const res = submitOnlineAction(created.code, { playerId: 'p1', action: { type: 'endTurn' } });
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

test('getOnlineMatch advances turn when expired', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 0 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  // turnSeconds=0 means immediately expired
  const m = getOnlineMatch(created.code);
  expect(m).not.toBeNull();
  expect(m!.turn).toBe(2);
  expect(m!.activeTeam).toBe(1);
});

test('getOnlineMatch does not advance when not expired', () => {
  const created = createOnlineMatch({ playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 9999 } });
  joinOnlineMatch(created.code, { playerId: 'p2', playerName: 'Bob' });
  const m = getOnlineMatch(created.code);
  expect(m).not.toBeNull();
  expect(m!.turn).toBe(1);
  expect(m!.activeTeam).toBe(0);
});

