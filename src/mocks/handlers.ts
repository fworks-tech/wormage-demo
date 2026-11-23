import { delay, http, HttpResponse } from 'msw';
import {
  isEmpty,
  latencyMs,
  listLeaderboard,
  listMatches,
  registerDebugLog,
  registerMatch,
  createOnlineMatch,
  joinOnlineMatch,
  getOnlineMatch,
  submitOnlineAction,
  forfeitOnlineMatch,
  replayOnlineMatch,
  shouldFail,
} from '../api/mockServer';
import type { NewMatchInput } from '../api/types';

export const handlers = [
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
    if (isEmpty()) return HttpResponse.json({ items: [], page: 1, pageSize: 8, total: 0, totalPages: 1 });
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId') ?? '';
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 8);
    return HttpResponse.json(listMatches(playerId, page, pageSize));
  }),

  http.post('/api/matches', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const body = (await request.json()) as NewMatchInput;
    if (!body?.clientMatchId) {
      return HttpResponse.json({ message: 'clientMatchId is required' }, { status: 422 });
    }
    const { record, created } = registerMatch(body);
    return HttpResponse.json(record, { status: created ? 201 : 200 });
  }),

  http.post('/api/debug-logs', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const body = await request.json();
    const result = registerDebugLog(body);
    return HttpResponse.json(result, { status: 201 });
  }),

  http.get('/api/matches/online/:code', async ({ params }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const code = String(params.code);
    const match = getOnlineMatch(code);
    if (!match) return HttpResponse.json({ message: 'match not found' }, { status: 404 });
    return HttpResponse.json({ code: match.code, match }, { status: 200 });
  }),

  http.get('/api/matches/online/:code/replay', async ({ params }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const replay = replayOnlineMatch(String(params.code));
    if (!replay) return HttpResponse.json({ message: 'match not found' }, { status: 404 });
    return HttpResponse.json(replay, { status: 200 });
  }),

  http.post('/api/matches/online', async ({ request }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const body = (await request.json()) as { playerId: string; playerName: string; teamName?: string; settings?: Record<string, unknown> };
    const { code, link, match } = createOnlineMatch({
      playerId: body.playerId,
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
    const body = (await request.json()) as { playerId: string; action: { type: string; [k: string]: unknown }; clientActionId?: string; tick?: number; engineTick?: number };
    const result = submitOnlineAction(code, { playerId: body.playerId, action: body.action, clientActionId: body.clientActionId, tick: body.tick, engineTick: body.engineTick });
    if ('error' in result) {
      return HttpResponse.json({ message: result.error }, { status: result.status });
    }
    return HttpResponse.json({ code: result.code, match: result.match }, { status: 200 });
  }),

  http.post('/api/matches/online/:code/forfeit', async ({ request, params }) => {
    await delay(latencyMs());
    if (shouldFail()) return HttpResponse.json({ message: 'Upstream unavailable' }, { status: 503 });
    const code = String(params.code);
    const body = (await request.json()) as { playerId: string };
    const result = forfeitOnlineMatch(code, body.playerId);
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
    const result = joinOnlineMatch(code, {
      playerId: body.playerId,
      playerName: body.playerName,
      teamName: body.teamName,
    });
    if ('error' in result) {
      const status = result.error === 'not_found' ? 404 : 409;
      return HttpResponse.json({ message: result.error }, { status });
    }
    return HttpResponse.json({ code: result.code, match: result.match }, { status: 200 });
  }),
];
