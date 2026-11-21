import { beforeEach, expect, test } from 'vitest';
import {
  createOnlineMatch,
  joinOnlineMatch,
  getOnlineMatch,
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
