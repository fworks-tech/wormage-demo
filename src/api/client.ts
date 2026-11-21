import axios, { AxiosError } from 'axios';
import type { AxiosAdapter, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import {
  listLeaderboard,
  listMatches,
  latencyMs,
  registerMatch,
  registerDebugLog,
  createOnlineMatch,
  joinOnlineMatch,
  getOnlineMatch,
  submitOnlineAction,
  forfeitOnlineMatch,
  shouldFail,
  isEmpty,
} from './mockServer';
import type { NewMatchInput } from './types';

type Mode = 'network' | 'local' | 'live';
let mode: Mode = 'local';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function respond<T>(config: InternalAxiosRequestConfig, status: number, data: T): AxiosResponse<T> {
  return { data, status, statusText: status === 200 || status === 201 ? 'OK' : 'Error', headers: {}, config };
}

/** In-process REST surface used when a service worker is unavailable (single-file demo). */
const localAdapter: AxiosAdapter = async (config) => {
  const method = (config.method ?? 'get').toUpperCase();
  const rawUrl = config.url ?? '';
  const url = new URL(rawUrl, window.location.origin);
  const params = new URLSearchParams(url.search);
  Object.entries(config.params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) params.set(key, String(value));
  });

  await delay(latencyMs());

  if (shouldFail()) {
    throw new AxiosError('Mock upstream is unavailable', 'ERR_BAD_RESPONSE', config, null, respond(config, 503, { message: 'Upstream unavailable' }));
  }

  if (method === 'GET' && url.pathname === '/api/leaderboard') {
    if (isEmpty()) {
      return respond(config, 200, { items: [], page: 1, pageSize: 8, total: 0, totalPages: 1 });
    }
    const page = Number(params.get('page') ?? 1);
    const pageSize = Number(params.get('pageSize') ?? 8);
    const configKey = params.get('configKey') ?? undefined;
    return respond(config, 200, listLeaderboard(page, pageSize, configKey));
  }

  if (method === 'GET' && url.pathname === '/api/matches') {
    if (isEmpty()) {
      return respond(config, 200, { items: [], page: 1, pageSize: 8, total: 0, totalPages: 1 });
    }
    const playerId = params.get('playerId') ?? '';
    const page = Number(params.get('page') ?? 1);
    const pageSize = Number(params.get('pageSize') ?? 8);
    return respond(config, 200, listMatches(playerId, page, pageSize));
  }

  if (method === 'POST' && url.pathname === '/api/matches') {
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as NewMatchInput;
    const { record, created } = registerMatch(body);
    return respond(config, created ? 201 : 200, record);
  }

  if (method === 'POST' && url.pathname === '/api/debug-logs') {
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as unknown;
    const { stored } = registerDebugLog(body);
    return respond(config, 201, { stored, schemaVersion: 1 });
  }

  const onlineGet = url.pathname.match(/^\/api\/matches\/online\/([^/]+)$/);
  if (method === 'GET' && onlineGet) {
    const code = decodeURIComponent(onlineGet[1]);
    const match = getOnlineMatch(code);
    if (!match) {
      throw new AxiosError('not found', 'ERR_BAD_REQUEST', config, null, respond(config, 404, { message: 'match not found' }));
    }
    return respond(config, 200, { code: match.code, match });
  }

  const onlineCreate = url.pathname === '/api/matches/online';
  if (method === 'POST' && onlineCreate) {
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as {
      playerId: string; playerName: string; teamName?: string; settings?: Record<string, unknown>;
    };
    const { code, link, match } = createOnlineMatch({
      playerId: body.playerId,
      playerName: body.playerName,
      teamName: body.teamName,
      settings: body.settings as never,
    });
    return respond(config, 201, { code, link, match });
  }

  const onlineJoinMatch = url.pathname.match(/^\/api\/matches\/online\/([^/]+)\/join$/);
  if (method === 'POST' && onlineJoinMatch) {
    const code = decodeURIComponent(onlineJoinMatch[1]);
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as {
      playerId: string; playerName: string; teamName?: string;
    };
    const result = joinOnlineMatch(code, {
      playerId: body.playerId,
      playerName: body.playerName,
      teamName: body.teamName,
    });
    if ('error' in result) {
      const status = result.error === 'not_found' ? 404 : 409;
      throw new AxiosError(result.error, 'ERR_BAD_REQUEST', config, null, respond(config, status, { message: result.error }));
    }
    return respond(config, 200, { code: result.code, match: result.match });
  }

  const onlineAction = url.pathname.match(/^\/api\/matches\/online\/([^/]+)\/action$/);
  if (method === 'POST' && onlineAction) {
    const code = decodeURIComponent(onlineAction[1]);
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as {
      playerId: string; action: { type: string; [k: string]: unknown }; clientActionId?: string;
    };
    const result = submitOnlineAction(code, { playerId: body.playerId, action: body.action, clientActionId: body.clientActionId });
    if ('error' in result) {
      throw new AxiosError(result.error, 'ERR_BAD_REQUEST', config, null, respond(config, result.status, { message: result.error }));
    }
    return respond(config, 200, { code: result.code, match: result.match });
  }

  const onlineForfeit = url.pathname.match(/^\/api\/matches\/online\/([^/]+)\/forfeit$/);
  if (method === 'POST' && onlineForfeit) {
    const code = decodeURIComponent(onlineForfeit[1]);
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as { playerId: string };
    const result = forfeitOnlineMatch(code, body.playerId);
    if ('error' in result) {
      throw new AxiosError(result.error, 'ERR_BAD_REQUEST', config, null, respond(config, result.status, { message: result.error }));
    }
    return respond(config, 200, { code: result.code, match: result.match });
  }

  throw new AxiosError(`No mock route for ${method} ${url.pathname}`, 'ERR_NOT_FOUND', config, null, respond(config, 404, { message: 'Not found' }));
};

const wired = axios.create({ timeout: 12_000 });
const local = axios.create({ timeout: 12_000, adapter: localAdapter });
const liveBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const live = axios.create({ timeout: 12_000, baseURL: liveBase });

function client() {
  if (mode === 'live') return live;
  return mode === 'network' ? wired : local;
}

export const api = {
  get: <T>(url: string, config?: AxiosRequestConfig) => client().get<T>(url, config),
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => client().post<T>(url, data, config),
};

/**
 * Prefer real network mocks (MSW) everywhere except the single-file build,
 * where service workers are not available in the sandboxed preview.
 */
export async function initApiLayer(): Promise<Mode> {
  if (import.meta.env.VITE_API_MODE === 'live' || import.meta.env.VITE_LIVE_API === 'true') {
    if (!liveBase) {
      mode = 'local';
      return mode;
    }
    mode = 'live';
    return mode;
  }
  if (import.meta.env.MODE === 'single' || import.meta.env.VITE_LOCAL_API === 'true') {
    mode = 'local';
    return mode;
  }
  try {
    const { worker } = await import('../mocks/browser');
    await worker.start({
      onUnhandledRequest: 'bypass',
      serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
      quiet: true,
    });
    mode = 'network';
  } catch {
    mode = 'local';
  }
  return mode;
}

export function apiMode(): Mode {
  return mode;
}
