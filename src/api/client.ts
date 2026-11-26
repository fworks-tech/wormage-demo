import axios, { AxiosError } from 'axios';
import type { AxiosAdapter, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import {
  listLeaderboard,
  listMatches,
  latencyMs,
  registerMatch,
  registerDebugLog,
  registerBugReport,
  createOnlineMatch,
  joinOnlineMatch,
  getOnlineMatch,
  isLegacyOnlineMatch,
  submitOnlineAction,
  forfeitOnlineMatch,
  replayOnlineMatch,
  shouldFail,
  isEmpty,
} from './mockServer';
import type { NewMatchInput } from './types';
import {
  authSessionNeedsRefresh,
  clearAuthSession,
  createMockSessionFromHeaders,
  loadAuthSession,
  mockAuth,
  saveAuthSession,
  type AuthSession,
} from './auth';
import { clearOnlineSession, loadOnlineSession, loadPlayer, savePlayer } from '../state/storage';

type Mode = 'network' | 'local' | 'live';
let mode: Mode = 'local';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function respond<T>(config: InternalAxiosRequestConfig, status: number, data: T): AxiosResponse<T> {
  return { data, status, statusText: status === 200 || status === 201 ? 'OK' : 'Error', headers: {}, config };
}

function requestData<T>(config: InternalAxiosRequestConfig): T {
  return (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as T;
}

function rejectStatus(config: InternalAxiosRequestConfig, status: number, message: string): never {
  throw new AxiosError(message, 'ERR_BAD_REQUEST', config, null, respond(config, status, { message }));
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

  if (method === 'POST' && url.pathname === '/api/auth/session') {
    const session = await createMockSessionFromHeaders(config.headers);
    if (!session) return rejectStatus(config, 401, 'invalid or expired token');
    const refresh = Boolean(config.headers.get('Authorization'));
    return respond(config, refresh ? 200 : 201, session);
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
    const auth = await mockAuth(config.headers);
    if (auth.status) return rejectStatus(config, auth.status, auth.status === 401 ? 'authentication required' : 'forbidden');
    if (isEmpty()) {
      return respond(config, 200, { items: [], page: 1, pageSize: 8, total: 0, totalPages: 1 });
    }
    const playerId = auth.playerId ?? params.get('playerId') ?? '';
    const page = Number(params.get('page') ?? 1);
    const pageSize = Number(params.get('pageSize') ?? 8);
    return respond(config, 200, listMatches(playerId, page, pageSize));
  }

  if (method === 'POST' && url.pathname === '/api/matches') {
    const body = requestData<NewMatchInput>(config);
    const auth = await mockAuth(config.headers, body.playerId);
    if (auth.status) return rejectStatus(config, auth.status, auth.status === 401 ? 'authentication required' : 'playerId does not match authenticated session');
    body.playerId = auth.playerId ?? body.playerId;
    const { record, created } = registerMatch(body);
    return respond(config, created ? 201 : 200, record);
  }

  if (method === 'POST' && url.pathname === '/api/debug-logs') {
    const auth = await mockAuth(config.headers);
    if (auth.status) return rejectStatus(config, auth.status, 'authentication required');
    const body = requestData<unknown>(config);
    const { stored } = registerDebugLog(body);
    return respond(config, 201, { stored, schemaVersion: 1 });
  }

  if (method === 'POST' && url.pathname === '/api/bug-reports') {
    const auth = await mockAuth(config.headers);
    if (auth.status) return rejectStatus(config, auth.status, 'authentication required');
    const body = requestData<{ online?: { playerId?: string } }>(config);
    if (body?.online && auth.playerId) body.online.playerId = auth.playerId;
    return respond(config, 201, registerBugReport(body));
  }

  const onlineGet = url.pathname.match(/^\/api\/matches\/online\/([^/]+)$/);
  if (method === 'GET' && onlineGet) {
    const auth = await mockAuth(config.headers);
    if (auth.status) return rejectStatus(config, auth.status, 'authentication required');
    const code = decodeURIComponent(onlineGet[1]);
    if (isLegacyOnlineMatch(code)) {
      throw new AxiosError('legacy online match is no longer supported', 'ERR_BAD_REQUEST', config, null, respond(config, 410, { message: 'legacy online match is no longer supported' }));
    }
    const match = getOnlineMatch(code);
    if (!match) {
      throw new AxiosError('not found', 'ERR_BAD_REQUEST', config, null, respond(config, 404, { message: 'match not found' }));
    }
    if (auth.playerId && !match.players.some((player) => player.playerId === auth.playerId)) return rejectStatus(config, 403, 'not a participant');
    return respond(config, 200, { code: match.code, match });
  }

  const onlineReplay = url.pathname.match(/^\/api\/matches\/online\/([^/]+)\/replay$/);
  if (method === 'GET' && onlineReplay) {
    const auth = await mockAuth(config.headers);
    if (auth.status) return rejectStatus(config, auth.status, 'authentication required');
    const code = decodeURIComponent(onlineReplay[1]);
    if (isLegacyOnlineMatch(code)) {
      throw new AxiosError('legacy online match is no longer supported', 'ERR_BAD_REQUEST', config, null, respond(config, 410, { message: 'legacy online match is no longer supported' }));
    }
    const match = getOnlineMatch(code);
    if (!match) {
      throw new AxiosError('not found', 'ERR_BAD_REQUEST', config, null, respond(config, 404, { message: 'match not found' }));
    }
    if (auth.playerId && !match.players.some((player) => player.playerId === auth.playerId)) return rejectStatus(config, 403, 'not a participant');
    const replay = replayOnlineMatch(code);
    if (!replay) {
      throw new AxiosError('not found', 'ERR_BAD_REQUEST', config, null, respond(config, 404, { message: 'match not found' }));
    }
    return respond(config, 200, replay);
  }

  const onlineCreate = url.pathname === '/api/matches/online';
  if (method === 'POST' && onlineCreate) {
    const body = requestData<{ playerId: string; playerName: string; teamName?: string; settings?: Record<string, unknown> }>(config);
    const auth = await mockAuth(config.headers, body.playerId);
    if (auth.status) return rejectStatus(config, auth.status, auth.status === 401 ? 'authentication required' : 'playerId does not match authenticated session');
    const { code, link, match } = createOnlineMatch({
      playerId: auth.playerId ?? body.playerId,
      playerName: body.playerName,
      teamName: body.teamName,
      settings: body.settings as never,
    });
    return respond(config, 201, { code, link, match });
  }

  const onlineJoinMatch = url.pathname.match(/^\/api\/matches\/online\/([^/]+)\/join$/);
  if (method === 'POST' && onlineJoinMatch) {
    const code = decodeURIComponent(onlineJoinMatch[1]);
    const body = requestData<{ playerId: string; playerName: string; teamName?: string }>(config);
    const auth = await mockAuth(config.headers, body.playerId);
    if (auth.status) return rejectStatus(config, auth.status, auth.status === 401 ? 'authentication required' : 'playerId does not match authenticated session');
    const result = joinOnlineMatch(code, {
      playerId: auth.playerId ?? body.playerId,
      playerName: body.playerName,
      teamName: body.teamName,
    });
    if ('error' in result) {
      const status = 'status' in result ? result.status : result.error === 'not_found' ? 404 : 409;
      throw new AxiosError(result.error, 'ERR_BAD_REQUEST', config, null, respond(config, status, { message: result.error }));
    }
    return respond(config, 200, { code: result.code, match: result.match });
  }

  const onlineAction = url.pathname.match(/^\/api\/matches\/online\/([^/]+)\/action$/);
  if (method === 'POST' && onlineAction) {
    const code = decodeURIComponent(onlineAction[1]);
    const body = requestData<{ playerId: string; action: { type: string; [k: string]: unknown }; clientActionId: string; tick?: number; engineTick?: number }>(config);
    const auth = await mockAuth(config.headers, body.playerId);
    if (auth.status) return rejectStatus(config, auth.status, auth.status === 401 ? 'authentication required' : 'playerId does not match authenticated session');
    const result = submitOnlineAction(code, {
      playerId: auth.playerId ?? body.playerId,
      action: body.action,
      clientActionId: body.clientActionId,
      tick: body.tick,
      engineTick: body.engineTick,
    });
    if ('error' in result) {
      throw new AxiosError(result.error, 'ERR_BAD_REQUEST', config, null, respond(config, result.status, { message: result.error }));
    }
    return respond(config, 200, { code: result.code, match: result.match, duplicate: result.duplicate });
  }

  const onlineForfeit = url.pathname.match(/^\/api\/matches\/online\/([^/]+)\/forfeit$/);
  if (method === 'POST' && onlineForfeit) {
    const code = decodeURIComponent(onlineForfeit[1]);
    const body = requestData<{ playerId: string }>(config);
    const auth = await mockAuth(config.headers, body.playerId);
    if (auth.status) return rejectStatus(config, auth.status, auth.status === 401 ? 'authentication required' : 'playerId does not match authenticated session');
    const result = forfeitOnlineMatch(code, auth.playerId ?? body.playerId);
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

type AuthRequestConfig = InternalAxiosRequestConfig & {
  _wormageAuthRetry?: boolean;
  _wormageSkipAuth?: boolean;
};

let pendingSession: Promise<AuthSession> | null = null;
let memorySession: AuthSession | null = null;

function currentAuthSession(): AuthSession | null {
  return memorySession ?? loadAuthSession();
}

function persistSession(session: AuthSession): void {
  memorySession = saveAuthSession(session) ? null : session;
}

function clearAnonymousSession(): void {
  memorySession = null;
  clearAuthSession();
}

function syncAuthenticatedPlayer(session: AuthSession): void {
  const player = loadPlayer();
  if (player.id !== session.playerId) {
    savePlayer({ ...player, id: session.playerId });
    const onlineSession = loadOnlineSession();
    if (onlineSession && onlineSession.playerId !== session.playerId) clearOnlineSession();
  }
}

async function issueAnonymousSession(stored: AuthSession | null): Promise<AuthSession> {
  const request = (skipAuth = false) => api.post<AuthSession>('/api/auth/session', undefined, {
    ...(stored && !skipAuth ? { headers: { Authorization: `Bearer ${stored.token}` } } : {}),
    ...(skipAuth ? { _wormageSkipAuth: true } : {}),
  } as AxiosRequestConfig);
  try {
    const { data } = await request();
    persistSession(data);
    syncAuthenticatedPlayer(data);
    return data;
  } catch (error) {
    if (!stored || !axios.isAxiosError(error) || error.response?.status !== 401) throw error;
    clearAnonymousSession();
    const { data } = await request(true);
    persistSession(data);
    syncAuthenticatedPlayer(data);
    return data;
  }
}

export async function ensureAnonymousSession(force = false): Promise<AuthSession> {
  if (pendingSession) return pendingSession;
  const stored = currentAuthSession();
  if (!force && stored && !authSessionNeedsRefresh(stored)) {
    syncAuthenticatedPlayer(stored);
    return stored;
  }
  pendingSession = issueAnonymousSession(stored).finally(() => {
    pendingSession = null;
  });
  return pendingSession;
}

for (const instance of [wired, local, live]) {
  instance.interceptors.request.use((config) => {
    const authConfig = config as AuthRequestConfig;
    if (!authConfig._wormageSkipAuth && !config.headers.get('Authorization')) {
      const token = currentAuthSession()?.token;
      if (token) config.headers.set('Authorization', `Bearer ${token}`);
    }
    return config;
  });
  instance.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as AuthRequestConfig | undefined;
    if (!config || error.response?.status !== 401 || config._wormageAuthRetry || config.url === '/api/auth/session') throw error;
    const session = await ensureAnonymousSession(true);
    config.headers.set('Authorization', `Bearer ${session.token}`);
    config._wormageAuthRetry = true;
    return instance.request(config);
  });
}

/**
 * Prefer real network mocks (MSW) in development. Production and the
 * single-file build use the in-process adapter so a service worker can own
 * the root scope without competing with MSW.
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
  // Production uses the local adapter so the PWA can own the root service-worker scope.
  if (import.meta.env.MODE === 'single' || import.meta.env.PROD || import.meta.env.VITE_LOCAL_API === 'true') {
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
