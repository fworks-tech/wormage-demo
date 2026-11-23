import { GameEngine } from '../game/engine';
import type { MatchConfig } from '../game/types';
import type { OnlineActionLogEntry } from '../api/types';
import { configKey } from '../game/types';
import type { Difficulty, WindSetting } from '../game/types';
import type {
  LeaderboardRow,
  MatchRecord,
  MockScenario,
  NewMatchInput,
  OnlineMatch,
  OnlinePlayer,
  Paginated,
} from './types';

const DB_KEY = 'wormage.mockdb.v1';
const SCENARIO_KEY = 'wormage.netScenario.v1';
const DEBUG_LOG_KEY = 'wormage.debuglogs.v1';
const ONLINE_KEY = 'wormage.onlinematches.v1';

interface Db {
  matches: MatchRecord[];
  seededAt: string;
}

function safeRead<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // opaque-origin iframes cannot persist; in-memory state still works
    return false;
  }
}

const memoryDb: { current: Db | null } = { current: null };

const FIXTURE_PLAYERS = [
  'VerminViper',
  'DirtDauber',
  'Boomhauer',
  'Wormhole',
  'GrenadeGus',
  'TNTina',
  'Sapper',
  'Mudlark',
  'Fuse',
  'Nibbler',
  'Shrapnel',
  'Hollow',
];

const CONFIGS: Array<{ turnSeconds: number; wind: WindSetting; difficulty: Difficulty }> = [
  { turnSeconds: 45, wind: 'light', difficulty: 'veteran' },
  { turnSeconds: 45, wind: 'light', difficulty: 'rookie' },
  { turnSeconds: 60, wind: 'strong', difficulty: 'veteran' },
  { turnSeconds: 30, wind: 'off', difficulty: 'elite' },
  { turnSeconds: 45, wind: 'strong', difficulty: 'elite' },
  { turnSeconds: 60, wind: 'light', difficulty: 'veteran' },
];

export function keyOf(
  turnSeconds: number,
  wind: WindSetting,
  difficulty: Difficulty,
  map?: string,
  mode?: string,
  loadout?: string,
): string {
  return configKey({
    turnSeconds,
    wind,
    difficulty,
    map: (map ?? 'island') as never,
    mode: (mode ?? 'deathmatch') as never,
    loadout: (loadout ?? 'default') as never,
  });
}

function makeFixtures(): MatchRecord[] {
  const now = Date.now();
  const rows: MatchRecord[] = [];
  FIXTURE_PLAYERS.forEach((name, index) => {
    for (let round = 0; round < CONFIGS.length; round += 1) {
      const cfg = CONFIGS[round];
      const score = 420 + ((index * 137 + round * 251) % 1180);
      const created = new Date(now - (index * 3 + round) * 36e5 - 864e5).toISOString();
      const configKey = keyOf(cfg.turnSeconds, cfg.wind, cfg.difficulty);
      rows.push({
        id: `fixture-${index}-${round}`,
        clientMatchId: `fixture-${index}-${round}`,
        matchId: `M-${(index + 1) * 100 + round}`,
        playerId: `bot-${index}`,
        playerName: name,
        teamName: index % 2 === 0 ? 'Ironclad' : 'Rustbelt',
        score,
        durationSeconds: 140 + ((index * 41 + round * 67) % 420),
        endReason: round === 0 ? 'time' : 'wipeout',
        configKey,
        turnSeconds: cfg.turnSeconds,
        wind: cfg.wind,
        difficulty: cfg.difficulty,
        kills: 1 + ((index + round) % 3),
        createdAt: created,
      });
    }
  });
  return rows;
}

function getDb(): Db {
  if (memoryDb.current) return memoryDb.current;
  const loaded = safeRead<Db>(DB_KEY);
  if (loaded && Array.isArray(loaded.matches)) {
    memoryDb.current = loaded;
    return loaded;
  }
  const fresh: Db = { matches: makeFixtures(), seededAt: new Date().toISOString() };
  memoryDb.current = fresh;
  safeWrite(DB_KEY, fresh);
  return fresh;
}

function persist(db: Db): void {
  memoryDb.current = db;
  safeWrite(DB_KEY, db);
}

export function getScenario(): MockScenario {
  const value = safeRead<MockScenario>(SCENARIO_KEY);
  return value === 'slow' || value === 'empty' || value === 'error' ? value : 'normal';
}

export function setScenario(scenario: MockScenario): void {
  safeWrite(SCENARIO_KEY, scenario);
}

export function resetMockData(): void {
  memoryDb.current = null;
  safeWrite(DB_KEY, null);
  try {
    localStorage.removeItem(DB_KEY);
  } catch {
    // ignore
  }
  getDb();
}

export function latencyMs(): number {
  const scenario = getScenario();
  if (scenario === 'slow') return 1500;
  if (scenario === 'normal') return 120;
  return 260;
}

export function shouldFail(): boolean {
  return getScenario() === 'error';
}

export function isEmpty(): boolean {
  return getScenario() === 'empty';
}

export function listLeaderboard(page: number, pageSize: number, configKey?: string): Paginated<LeaderboardRow> {
  const db = getDb();
  const relevant = db.matches.filter((m) => (configKey ? m.configKey === configKey : true));
  const best = new Map<string, MatchRecord>();
  for (const match of relevant) {
    const current = best.get(match.playerId);
    if (!current || match.score > current.score) best.set(match.playerId, match);
  }
  const sorted = [...best.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.durationSeconds !== b.durationSeconds) return a.durationSeconds - b.durationSeconds;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const rows: LeaderboardRow[] = sorted.map((m, index) => ({
    rank: index + 1,
    playerId: m.playerId,
    playerName: m.playerName,
    teamName: m.teamName,
    score: m.score,
    kills: m.kills,
    durationSeconds: m.durationSeconds,
    configKey: m.configKey,
    createdAt: m.createdAt,
  }));
  return paginate(rows, page, pageSize);
}

export function listMatches(playerId: string, page: number, pageSize: number): Paginated<MatchRecord> {
  const db = getDb();
  const rows = db.matches
    .filter((m) => m.playerId === playerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return paginate(rows, page, pageSize);
}

export function registerMatch(input: NewMatchInput): { record: MatchRecord; created: boolean } {
  const db = getDb();
  const existing = db.matches.find((m) => m.clientMatchId === input.clientMatchId);
  if (existing) return { record: existing, created: false };

  const record: MatchRecord = {
    id: `match-${Math.random().toString(36).slice(2, 10)}`,
    matchId: `M-${Date.now().toString(36).toUpperCase()}`,
    clientMatchId: input.clientMatchId,
    playerId: input.playerId,
    playerName: input.playerName,
    teamName: input.teamName,
    score: Math.round(input.score),
    durationSeconds: Math.round(input.durationSeconds),
    endReason: input.endReason,
    configKey: keyOf(input.turnSeconds, input.wind, input.difficulty, input.map, input.mode, input.loadout),
    turnSeconds: input.turnSeconds,
    wind: input.wind,
    difficulty: input.difficulty,
    kills: input.kills,
    createdAt: new Date().toISOString(),
  };
  const next: Db = { ...db, matches: [...db.matches, record] };
  persist(next);
  return { record, created: true };
}

function paginate<T>(rows: T[], page: number, pageSize: number): Paginated<T> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeSize = Math.max(1, Math.min(50, Math.floor(pageSize) || 8));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const start = (safePage - 1) * safeSize;
  return {
    items: rows.slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total,
    totalPages,
  };
}

export const MOCK_TOTAL_FIXTURES = FIXTURE_PLAYERS.length;


interface OnlineDb {
  matches: Record<string, OnlineMatch>;
  actionLogs?: Record<string, { actions: OnlineActionLogEntry[] }>;
}

const onlineMemory: { current: OnlineDb | null } = { current: null };

function getOnlineDb(): OnlineDb {
  if (onlineMemory.current) return onlineMemory.current;
  const loaded = safeRead<OnlineDb>(ONLINE_KEY);
  if (loaded && loaded.matches && typeof loaded.matches === 'object') {
    onlineMemory.current = loaded;
    return loaded;
  }
  const fresh: OnlineDb = { matches: {} };
  onlineMemory.current = fresh;
  return fresh;
}

function persistOnline(db: OnlineDb): void {
  onlineMemory.current = db;
  safeWrite(ONLINE_KEY, db);
}

const ONLINE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genOnlineCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += ONLINE_CODE_ALPHABET[Math.floor(Math.random() * ONLINE_CODE_ALPHABET.length)];
  return code;
}

export function createOnlineMatch(input: {
  playerId: string;
  playerName: string;
  teamName?: string;
  settings?: OnlineMatch['settings'];
}): { code: string; link: string; match: OnlineMatch } {
  const db = getOnlineDb();
  let code = genOnlineCode();
  while (db.matches[code]) code = genOnlineCode();
  const now = new Date().toISOString();
  const settings = { ...(input.settings ?? {}) };
  if (typeof settings.seed !== 'number' || !Number.isFinite(settings.seed)) {
    settings.seed = Math.floor(Math.random() * 1_000_000_000);
  }
  const match: OnlineMatch = {
    code,
    status: 'waiting',
    createdAt: now,
    maxPlayers: 2,
    settings,
    players: [{ playerId: input.playerId, playerName: input.playerName, teamName: input.teamName ?? 'Team 1' }],
    activeTeam: 0,
    turn: 1,
    turnStartedAt: now,
    turnSeconds: input.settings?.turnSeconds ?? 45,
    winnerTeam: null,
    endReason: null,
  };
  db.matches[code] = match;
  persistOnline(db);
  return { code, link: `/online/${code}`, match };
}

export function joinOnlineMatch(code: string, input: { playerId: string; playerName: string; teamName?: string }): { code: string; match: OnlineMatch } | { error: 'not_found' | 'full' } {
  const db = getOnlineDb();
  const match = db.matches[code.toUpperCase()];
  if (!match) return { error: 'not_found' };
  if (match.players.some((p) => p.playerId === input.playerId)) {
    return { code: match.code, match };
  }
  if (match.players.length >= match.maxPlayers) {
    return { error: 'full' };
  }
  match.players.push({ playerId: input.playerId, playerName: input.playerName, teamName: input.teamName ?? `Team ${match.players.length + 1}` });
  if (match.players.length >= match.maxPlayers) {
    match.status = 'ready';
    match.activeTeam = 0;
    match.turn = 1;
    match.turnStartedAt = new Date().toISOString();
    match.turnSeconds = match.turnSeconds ?? 45;
  }
  persistOnline(db);
  return { code: match.code, match };
}


export function submitOnlineAction(code: string, input: { playerId: string; action: { type: string; [k: string]: unknown }; clientActionId?: string; tick?: number; engineTick?: number }): { code: string; match: OnlineMatch } | { error: string; status: number } {
  const db = getOnlineDb();
  const match = db.matches[code.toUpperCase()];
  if (!match) return { error: 'match not found', status: 404 };
  if (match.status !== 'ready') return { error: 'match not ready', status: 409 };
  if (match.winnerTeam != null) return { error: 'match finished', status: 409 };
  if (!match.players.some((p) => p.playerId === input.playerId)) return { error: 'not a participant', status: 403 };

  // Idempotency (before turn/phase validation)
  if (!db.actionLogs) db.actionLogs = {};
  const log = db.actionLogs[code.toUpperCase()] || { actions: [] };
  if (input.clientActionId && log.actions.some((a) => (a as { clientActionId?: string }).clientActionId === input.clientActionId)) {
    return { code: match.code, match };
  }


  if (match.players[match.activeTeam]?.playerId !== input.playerId) return { error: 'not your turn', status: 409 };

  const phase = match.phase || 'aim';
  const type = input.action.type;
  if (phase === 'gameover') return { error: 'match finished', status: 409 };
  const aimOnly = ['move', 'aim', 'jump', 'rope', 'reel', 'weapon', 'startCharge', 'releaseCharge'];
  if (type === 'fire' || type === 'startCharge') {
    if (phase !== 'aim' || match.hasFired) return { error: 'illegal action for current phase', status: 409 };
  } else if (type === 'endTurn') {
    if (phase !== 'aim') return { error: 'illegal action for current phase', status: 409 };
  } else if (aimOnly.includes(type)) {
    if (phase !== 'aim') return { error: 'illegal action for current phase', status: 409 };
  } else {
    return { error: 'unknown action type', status: 400 };
  }

  if (log.actions.length >= 500) return { error: 'action log full', status: 409 };

  const now = new Date().toISOString();
  if (type === 'endTurn') {
    const n = match.players.length;
    let nextTeam = match.activeTeam;
    for (let i = 1; i <= n; i++) {
      const idx = (match.activeTeam + i) % n;
      if (match.players[idx]) { nextTeam = idx; break; }
    }
    match.activeTeam = nextTeam;
    match.turn = (match.turn || 1) + 1;
    match.turnStartedAt = now;
    match.phase = 'aim';
    match.hasFired = false;
  } else if (type === 'fire') {
    match.phase = 'projectile';
    match.hasFired = true;
  }
  if (type === 'weapon' && typeof input.action.id === 'string') {
    match.weapon = input.action.id;
  }

  const seq = ((log.actions as any[]).reduce((m: number, a: any) => Math.max(m, a?.seq ?? 0), 0) + 1);
  const rawTick = typeof input.tick === 'number' ? input.tick : (typeof input.engineTick === 'number' ? input.engineTick : undefined);
  const engineTick = typeof rawTick === 'number' ? Math.max(0, Math.min(1_000_000, Math.floor(rawTick))) : undefined;
  (log.actions as any[]).push({ seq, tick: engineTick ?? (match.turn || 1), turn: match.turn || 1, engineTick, action: input.action, playerId: input.playerId, clientActionId: input.clientActionId || null, at: now });
  db.actionLogs[code.toUpperCase()] = log;
  persistOnline(db);

  return { code: match.code, match };
}

export function forfeitOnlineMatch(code: string, playerId: string): { code: string; match: OnlineMatch } | { error: string; status: number } {
  const db = getOnlineDb();
  const match = db.matches[code.toUpperCase()];
  if (!match) return { error: 'match not found', status: 404 };
  if (!match.players.some((p) => p.playerId === playerId)) return { error: 'not a participant', status: 403 };

  if (match.winnerTeam != null) {
    return { code: match.code, match };
  }

  const opponentIdx = match.players.findIndex((p) => p.playerId !== playerId);
  match.winnerTeam = opponentIdx >= 0 ? opponentIdx : null;
  match.endReason = 'surrender';
  match.status = 'finished';
  persistOnline(db);
  return { code: match.code, match };
}

export function getOnlineMatch(code: string): OnlineMatch | null {
  const db = getOnlineDb();
  const match = db.matches[code.toUpperCase()];
  if (!match) return null;
  // Attach action log for replay.
  const log = (db.actionLogs || {})[code.toUpperCase()];
  if (log && Array.isArray(log.actions)) {
    (match as OnlineMatch & { actions?: unknown[] }).actions = log.actions;
  }
  // Server-side turn expiry advance.
  if (match.status === 'ready' && match.winnerTeam == null && match.turnStartedAt) {
    const elapsed = Date.now() - new Date(match.turnStartedAt).getTime();
    const ts = match.turnSeconds != null ? match.turnSeconds : 45;
    const limit = ts * 1000;
    if (elapsed >= limit) {
      const now = new Date().toISOString();
      const n = match.players.length;
      let nextTeam = match.activeTeam;
      for (let i = 1; i <= n; i++) {
        const idx = (match.activeTeam + i) % n;
        if (match.players[idx]) { nextTeam = idx; break; }
      }
      match.activeTeam = nextTeam;
      match.turn = (match.turn || 1) + 1;
      match.turnStartedAt = now;
      persistOnline(db);
    }
  }
  return match;
}

export function getActionLog(code: string): OnlineActionLogEntry[] {
  const db = getOnlineDb();
  const log = (db.actionLogs || {})[code.toUpperCase()];
  const actions = Array.isArray(log?.actions) ? [...log.actions] : [];
  return actions.sort((a, b) => {
    // Same order as the Lambda replay: tick decides, seq breaks ties.
    const ea = typeof a?.engineTick === 'number' ? a.engineTick : (typeof a?.tick === 'number' ? a.tick : 0);
    const eb = typeof b?.engineTick === 'number' ? b.engineTick : (typeof b?.tick === 'number' ? b.tick : 0);
    if (ea !== eb) return ea - eb;
    const sa = typeof a?.seq === 'number' ? a.seq : 0;
    const sb = typeof b?.seq === 'number' ? b.seq : 0;
    if (sa !== sb) return sa - sb;
    return String(a?.at ?? '').localeCompare(String(b?.at ?? ''));
  });
}

export function replayOnlineMatch(code: string): {
  code: string;
  tick: number;
  snapshot: ReturnType<GameEngine['snapshot']>;
  winnerTeam: number | null;
  endReason: string | null;
  kills: number[];
} | null {
  const match = getOnlineMatch(code);
  if (!match) return null;
  const settings = (match.settings ?? {}) as Record<string, unknown>;
  const seed = typeof settings.seed === 'number' ? settings.seed : (match as { seed?: number }).seed ?? 0;
  const turnSeconds = match.turnSeconds ?? (typeof settings.turnSeconds === 'number' ? settings.turnSeconds : 45);
  const wind = (settings.wind as 'off' | 'light' | 'strong') ?? 'light';
  const difficulty = (settings.difficulty as 'rookie' | 'veteran' | 'elite') ?? 'veteran';
  const wormsPerTeam = typeof settings.wormsPerTeam === 'number' ? settings.wormsPerTeam : 3;
  const map = (settings.map as MatchConfig['map']) ?? 'island';
  const mode = (settings.mode as MatchConfig['mode']) ?? 'deathmatch';
  const loadout = (settings.loadout as MatchConfig['loadout']) ?? 'default';
  const teamNames = Array.isArray(settings.teamNames) ? settings.teamNames as string[] : undefined;
  const config: MatchConfig = { turnSeconds, wind, difficulty, seed, wormsPerTeam, map, mode, loadout, hotseat: false, teamCount: 2, teamNames };
  const engine = new GameEngine(config);
  const actions = getActionLog(code);
  const DT = 1 / 60;
  // Keep in sync with MAX_TICKS in infra/lambda/replay.js; the parity test fails on drift.
  const MAX_TICKS = 60 * 60 * 30;
  let cursor = 0;
  while (engine.phase !== 'gameover' && engine.tick < MAX_TICKS) {
    while (cursor < actions.length) {
      const entryTick = (typeof actions[cursor].engineTick === 'number' ? actions[cursor].engineTick : (typeof actions[cursor].tick === 'number' ? actions[cursor].tick : 0)) as number;
      if (entryTick !== engine.tick) break;
      engine.applyAction(actions[cursor].action as Parameters<GameEngine['applyAction']>[0]);
      cursor += 1;
    }
    engine.update(DT);
  }
  while (cursor < actions.length) {
    engine.applyAction(actions[cursor].action as Parameters<GameEngine['applyAction']>[0]);
    cursor += 1;
  }
  return { code: match.code, tick: engine.tick, snapshot: engine.snapshot(), winnerTeam: engine.winnerTeam, endReason: engine.endReason, kills: engine.kills };
}

// Aliases for alternate naming.
export const replayOnlineTurn = replayOnlineMatch;
export const replayMatch = replayOnlineMatch;
export const replayTurn = replayOnlineMatch;

export function resetOnlineMatches(): void {
  onlineMemory.current = { matches: {} };
  try { localStorage.removeItem(ONLINE_KEY); } catch { /* ignore */ }
}

export function registerDebugLog(payload: unknown): { stored: boolean; count: number } {
  const now = Date.now();
  const list = safeRead<unknown[]>(DEBUG_LOG_KEY) ?? [];
  const filtered = (Array.isArray(list) ? list : []).filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const expires = (item as { expiresAt?: string }).expiresAt;
    return !expires || new Date(expires).getTime() > now;
  });
  filtered.push(payload);
  const MAX_DEBUG_SESSIONS = 20;
  while (filtered.length > MAX_DEBUG_SESSIONS) filtered.shift();
  const stored = safeWrite(DEBUG_LOG_KEY, filtered);
  return { stored, count: filtered.length };
}
