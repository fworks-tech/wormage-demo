import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setupServer } from 'msw/node';
import {
  authSessionNeedsRefresh,
  createMockSession,
  loadAuthSession,
  mockAuth,
  saveAuthSession,
  verifyMockToken,
} from '../../src/api/auth';
import { api, ensureAnonymousSession } from '../../src/api/client';
import { loadPlayer } from '../../src/state/storage';

const values = new Map<string, string>();

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => {
  values.clear();
  vi.unstubAllGlobals();
});

test('mock session tokens round-trip and refresh the same player', async () => {
  const now = Date.UTC(2026, 10, 26);
  const session = await createMockSession(undefined, now);
  const refreshed = await createMockSession(session.playerId, now + 60_000);

  expect(session.playerId).toMatch(/^player-/);
  expect(await verifyMockToken(session.token, now)).toBe(session.playerId);
  expect(await verifyMockToken(refreshed.token, now + 60_000)).toBe(session.playerId);
});

test('mock auth rejects tampered, expired and mismatched identities', async () => {
  const now = Date.UTC(2026, 10, 26);
  const session = await createMockSession(undefined, now);
  const headers = { authorization: `Bearer ${session.token}` };

  expect(await verifyMockToken(`${session.token}x`, now)).toBeNull();
  expect(await verifyMockToken(session.token, now + 181 * 24 * 60 * 60 * 1000)).toBeNull();
  expect(await mockAuth(headers, undefined, 'enforce')).toEqual({ playerId: session.playerId });
  expect(await mockAuth(headers, 'player-other', 'enforce')).toEqual({ status: 403 });
  expect(await mockAuth({}, undefined, 'enforce')).toEqual({ status: 401 });
  expect(await mockAuth({}, 'legacy-player', 'observe')).toEqual({ playerId: 'legacy-player' });
});

test('local transport issues a session and rejects spoofed match identity', async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  const session = await ensureAnonymousSession();
  await expect(api.post('/api/matches', {
    clientMatchId: 'auth-local-spoof',
    playerId: 'player-spoofed',
    playerName: 'P',
    teamName: 'T',
    score: 1,
    endReason: 'wipeout',
  })).rejects.toMatchObject({ response: { status: 403 } });

  const response = await api.post<{ playerId: string }>('/api/matches', {
    clientMatchId: 'auth-local-1',
    playerName: 'P',
    teamName: 'T',
    score: 1,
    endReason: 'wipeout',
  });
  expect(response.status).toBe(201);
  expect(response.data.playerId).toBe(session.playerId);
});

test('forced session refresh preserves the anonymous player identity', async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  const first = await ensureAnonymousSession();
  const refreshed = await ensureAnonymousSession(true);

  expect(refreshed.playerId).toBe(first.playerId);
  expect(Date.parse(refreshed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(first.expiresAt));
  expect(loadAuthSession()?.playerId).toBe(first.playerId);
  expect(loadPlayer().id).toBe(first.playerId);
});

test('MSW transport issues a session and rejects identity spoofing', async () => {
  vi.stubGlobal('location', new URL('http://localhost'));
  const { handlers } = await import('../../src/mocks/handlers');
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });
  try {
    const sessionResponse = await fetch('http://localhost/api/auth/session', { method: 'POST' });
    const session = await sessionResponse.json() as { token: string; playerId: string };
    expect(sessionResponse.status).toBe(201);

    const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
    const spoofed = await fetch('http://localhost/api/matches', {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientMatchId: 'auth-msw-spoof', playerId: 'player-other', playerName: 'P', teamName: 'T' }),
    });
    expect(spoofed.status).toBe(403);

    const derived = await fetch('http://localhost/api/matches', {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientMatchId: 'auth-msw-1', playerName: 'P', teamName: 'T' }),
    });
    expect(derived.status).toBe(201);
    expect((await derived.json() as { playerId: string }).playerId).toBe(session.playerId);
  } finally {
    server.close();
  }
});

test('auth session persistence validates shape and refresh window', async () => {
  const now = Date.UTC(2026, 10, 26);
  const session = await createMockSession(undefined, now);
  saveAuthSession(session);

  expect(loadAuthSession()).toEqual(session);
  expect(authSessionNeedsRefresh(session, now + 179 * 24 * 60 * 60 * 1000)).toBe(true);
  expect(authSessionNeedsRefresh(session, now + 60_000)).toBe(false);

  values.set('wormage.auth.v1', '{bad json');
  expect(loadAuthSession()).toBeNull();
});
