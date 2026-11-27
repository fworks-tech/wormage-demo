import { delay, http, HttpResponse } from 'msw';
import {
  isEmpty,
  latencyMs,
  listLeaderboard,
  listMatches,
  listMatchesCursor,
  registerDebugLog,
  registerBugReport,
  registerMatch,
  createOnlineMatch,
  joinOnlineMatch,
  getOnlineMatch,
  isLegacyOnlineMatch,
  submitOnlineAction,
  forfeitOnlineMatch,
  replayOnlineMatch,
  shouldFail,
} from '../api/mockServer';
import type { NewMatchInput } from '../api/types';
import { createMockSessionFromHeaders, mockAuth } from '../api/auth';

function authFailure(status: number, message = status === 401 ? 'authentication required' : 'playerId does not match authenticated session') {
  return HttpResponse.json({ message }, { status });
}

export const handlers = [
  http.post('/api/auth/session', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const session = await createMockSessionFromHeaders(request.headers);
    if (!session) return authFailure(401);
    return HttpResponse.json(session, { status: request.headers.has('authorization') ? 200 : 201 });
  }),

  http.get('/api/leaderboard', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    if (isEmpty()) return HttpResponse.json({ items: [], page: 1, pageSize: 8, total: 0, totalPages: 1 });
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 8);
    const configKey = url.searchParams.get('configKey') ?? undefined;
    return HttpResponse.json(listLeaderboard(page, pageSize, configKey));
  }),

  http.get('/api/matches', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const auth = await mockAuth(request.headers);
    if (auth.status) return authFailure(auth.status);
    if (isEmpty()) return HttpResponse.json({ items: [], page: 1, pageSize: 8, total: 0, totalPages: 1 });
    const url = new URL(request.url);
    const playerId = auth.playerId ?? url.searchParams.get('playerId') ?? '';
    const cursor = url.searchParams.get('cursor') ?? undefined;
    if (cursor != null || url.searchParams.get('limit') != null) {
      try {
        return HttpResponse.json(listMatchesCursor(playerId, Number(url.searchParams.get('limit') ?? url.searchParams.get('pageSize') ?? 8), cursor));
      } catch {
        return HttpResponse.json({ message: 'invalid cursor' }, { status: 400 });
      }
    }
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 8);
    return HttpResponse.json(listMatches(playerId, page, pageSize));
  }),

  http.post('/api/matches', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const body = (await request.json()) as NewMatchInput | null;
    const auth = await mockAuth(request.headers, body?.playerId);
    if (auth.status) return authFailure(auth.status);
    if (body && typeof body === 'object') body.playerId = auth.playerId ?? body.playerId;
    const result = registerMatch(body as NewMatchInput);
    if ('error' in result) {
      return HttpResponse.json({ message: result.error }, { status: result.status });
    }
    return HttpResponse.json(result.record, { status: result.created ? 201 : 200 });
  }),

  http.post('/api/debug-logs', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const auth = await mockAuth(request.headers);
    if (auth.status) return authFailure(auth.status);
    const body = await request.json();
    const result = registerDebugLog(body);
    return HttpResponse.json(result, { status: 201 });
  }),

  http.post('/api/bug-reports', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const auth = await mockAuth(request.headers);
    if (auth.status) return authFailure(auth.status);
    const body = await request.json() as { online?: { playerId?: string } };
    if (body?.online && auth.playerId) body.online.playerId = auth.playerId;
    return HttpResponse.json(registerBugReport(body), { status: 201 });
  }),

  http.get('/api/matches/online/:code', async ({ params, request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const auth = await mockAuth(request.headers);
    if (auth.status) return authFailure(auth.status);
    const code = String(params.code);
    if (isLegacyOnlineMatch(code)) return HttpResponse.json({ message: 'legacy online match is no longer supported' }, { status: 410 });
    const match = getOnlineMatch(code);
    if (!match) return HttpResponse.json({ message: 'match not found' }, { status: 404 });
    if (auth.playerId && !match.players.some((player) => player.playerId === auth.playerId)) return authFailure(403, 'not a participant');
    return HttpResponse.json({ code: match.code, match }, { status: 200 });
  }),

  http.get('/api/matches/online/:code/replay', async ({ params, request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const auth = await mockAuth(request.headers);
    if (auth.status) return authFailure(auth.status);
    const code = String(params.code);
    if (isLegacyOnlineMatch(code)) return HttpResponse.json({ message: 'legacy online match is no longer supported' }, { status: 410 });
    const match = getOnlineMatch(code);
    if (!match) return HttpResponse.json({ message: 'match not found' }, { status: 404 });
    if (auth.playerId && !match.players.some((player) => player.playerId === auth.playerId)) return authFailure(403, 'not a participant');
    const replay = replayOnlineMatch(code);
    if (!replay) return HttpResponse.json({ message: 'match not found' }, { status: 404 });
    return HttpResponse.json(replay, { status: 200 });
  }),

  http.post('/api/matches/online', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const body = (await request.json()) as { playerId: string; playerName: string; teamName?: string; settings?: Record<string, unknown> };
    const auth = await mockAuth(request.headers, body.playerId);
    if (auth.status) return authFailure(auth.status);
    const { code, link, match } = createOnlineMatch({
      playerId: auth.playerId ?? body.playerId,
      playerName: body.playerName,
      teamName: body.teamName,
      settings: body.settings as never,
    });
    return HttpResponse.json({ code, link, match }, { status: 201 });
  }),

  http.post('/api/matches/online/:code/action', async ({ request, params }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const code = String(params.code);
    const body = (await request.json()) as { playerId: string; action: { type: string; [k: string]: unknown }; clientActionId: string; tick?: number; engineTick?: number };
    const auth = await mockAuth(request.headers, body.playerId);
    if (auth.status) return authFailure(auth.status);
    const result = submitOnlineAction(code, {
      playerId: auth.playerId ?? body.playerId,
      action: body.action,
      clientActionId: body.clientActionId,
      tick: body.tick,
      engineTick: body.engineTick,
    });
    if ('error' in result) {
      return HttpResponse.json({ message: result.error }, { status: result.status });
    }
    return HttpResponse.json({ code: result.code, match: result.match, duplicate: result.duplicate }, { status: 200 });
  }),

  http.post('/api/matches/online/:code/forfeit', async ({ request, params }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const code = String(params.code);
    const body = (await request.json()) as { playerId: string };
    const auth = await mockAuth(request.headers, body.playerId);
    if (auth.status) return authFailure(auth.status);
    const result = forfeitOnlineMatch(code, auth.playerId ?? body.playerId);
    if ('error' in result) {
      return HttpResponse.json({ message: result.error }, { status: result.status });
    }
    return HttpResponse.json({ code: result.code, match: result.match }, { status: 200 });
  }),

  http.post('/api/matches/online/:code/join', async ({ request, params }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const code = String(params.code);
    const body = (await request.json()) as { playerId: string; playerName: string; teamName?: string };
    const auth = await mockAuth(request.headers, body.playerId);
    if (auth.status) return authFailure(auth.status);
    const result = joinOnlineMatch(code, {
      playerId: auth.playerId ?? body.playerId,
      playerName: body.playerName,
      teamName: body.teamName,
    });
    if ('error' in result) {
      const status = 'status' in result ? result.status : result.error === 'not_found' ? 404 : 409;
      return HttpResponse.json({ message: result.error }, { status });
    }
    return HttpResponse.json({ code: result.code, match: result.match }, { status: 200 });
  }),
];
