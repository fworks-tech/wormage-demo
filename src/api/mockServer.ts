import { GameEngine, WEAPONS } from '../game/engine';
import { FIXED_DT } from '../game/config';
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
import {
  ACTION_CAP,
  MAX_ACTION_BYTES,
  checkActionPhase,
  expiredTurnUpdate,
  isTurnExpired,
  validateAction as validateSharedAction,
  validateBody,
} from './validation';

const DB_KEY = 'wormage.mockdb.v1';
const SCENARIO_KEY = 'wormage.netScenario.v1';
const DEBUG_LOG_KEY = 'wormage.debuglogs.v1';
const BUG_REPORT_KEY = 'wormage.bugreports.v1';
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

export function registerMatch(input: NewMatchInput): { record: MatchRecord; created: boolean } | { error: string; status: number } {
  const invalid = validateBody(input);
  if (invalid) return { error: invalid, status: 400 };
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
    score: Math.max(0, Math.round(Number(input.score) || 0)),
    durationSeconds: Math.max(0, Math.round(Number(input.durationSeconds) || 0)),
    endReason: input.endReason,
    configKey: keyOf(input.turnSeconds, input.wind, input.difficulty, input.map, input.mode, input.loadout),
    turnSeconds: input.turnSeconds,
    wind: input.wind,
    difficulty: input.difficulty,
    kills: Math.max(0, Math.round(Number(input.kills) || 0)),
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

export function isLegacyOnlineMatch(code: string): boolean {
  const match = getOnlineDb().matches[code.toUpperCase()];
  return !!match && match.actionLogVersion !== 2;
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
    actionLogVersion: 2,
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
    revision: 0,
  };
  db.matches[code] = match;
  persistOnline(db);
  return { code, link: `/online/${code}`, match };
}

export function joinOnlineMatch(code: string, input: { playerId: string; playerName: string; teamName?: string }): { code: string; match: OnlineMatch } | { error: 'not_found' | 'full' } | { error: string; status: number } {
  const db = getOnlineDb();
  const match = db.matches[code.toUpperCase()];
  if (!match) return { error: 'not_found' };
  if (match.actionLogVersion !== 2) return { error: 'legacy online match is no longer supported', status: 410 };
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

function sameAction(a: { type: string; [k: string]: unknown }, b: { type: string; [k: string]: unknown }): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

export function submitOnlineAction(code: string, input: { playerId: string; action: { type: string; [k: string]: unknown }; clientActionId: string; tick?: number; engineTick?: number }): { code: string; match: OnlineMatch; duplicate?: true } | { error: string; status: number } {
  if (typeof input.clientActionId !== 'string' || !input.clientActionId || input.clientActionId.length > 64) return { error: 'clientActionId is required', status: 400 };
  if (!input.action || typeof input.action !== 'object' || Array.isArray(input.action)) return { error: 'action is required', status: 400 };
  if (typeof input.action.type !== 'string' || !input.action.type) return { error: 'action.type is required', status: 400 };
  const db = getOnlineDb();
  const match = db.matches[code.toUpperCase()];
  if (!match) return { error: 'match not found', status: 404 };
  if (match.actionLogVersion !== 2) return { error: 'legacy online match is no longer supported', status: 410 };

  const syncId = input.action.type === 'endTurn' && input.clientActionId.endsWith('-endTurn-sync')
    ? input.clientActionId
    : null;
  // Idempotency (before readiness, turn and phase validation)
  if (!db.actionLogs) db.actionLogs = {};
  const log = db.actionLogs[code.toUpperCase()] || { actions: [] };
  const allActions = log.actions;
  const actions = allActions.filter((entry) => !entry.syncOnly);
  const existing = allActions.find((entry) => entry.clientActionId === input.clientActionId);
  if (existing) {
    if (existing.playerId !== input.playerId || !sameAction(existing.action, input.action)) {
      return { error: 'clientActionId already used', status: 409 };
    }
    return { code: match.code, match, duplicate: true };
  }

  if (new TextEncoder().encode(JSON.stringify(input.action)).byteLength > MAX_ACTION_BYTES) {
    return { error: 'action too large', status: 413 };
  }
  const actionError = validateSharedAction(input.action, WEAPONS);
  if (actionError) return { error: actionError, status: 400 };

  if (match.status !== 'ready') return { error: 'match not ready', status: 409 };
  if (match.winnerTeam != null) return { error: 'match finished', status: 409 };
  if (!match.players.some((p) => p.playerId === input.playerId)) return { error: 'not a participant', status: 403 };
  if (syncId && (match.phase || 'aim') === 'aim') return { error: 'shot not found', status: 409 };

  if (match.players[match.activeTeam]?.playerId !== input.playerId) return { error: 'not your turn', status: 409 };

  const gated = checkActionPhase({ phase: match.phase || 'aim', type: input.action.type, hasFired: match.hasFired ?? false });
  if (gated) return { error: gated.message, status: gated.status };

  const syncOnly = input.action.type === 'endTurn' && (match.phase || 'aim') !== 'aim';
  if (allActions.length >= ACTION_CAP) return { error: 'action log full', status: 409 };

  const now = new Date().toISOString();
  const seq = allActions.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0) + 1;
  const currentTick = match.snapshotTick ?? 0;
  const turnTicks = Math.ceil((match.turnSeconds > 0 ? match.turnSeconds : 45) * 60) + 1;
  const rawTick = typeof input.tick === 'number' ? input.tick : input.engineTick;
  const requestedTick = typeof rawTick === 'number' && Number.isFinite(rawTick) ? Math.floor(rawTick) : currentTick;
  let actionTick = Math.max(currentTick, Math.min(requestedTick, currentTick + turnTicks));
  const matchTurn = match.turn || 1;
  const revision = match.revision ?? 0;
  const actorIndex = match.players.findIndex((player) => player.playerId === input.playerId);
  const makeEntry = (tick: number): OnlineActionLogEntry => ({
    seq,
    tick,
    turn: matchTurn,
    engineTick: tick,
    action: input.action,
    playerId: input.playerId,
    clientActionId: input.clientActionId,
    at: now,
    ...(syncOnly ? { syncOnly: true } : {}),
  });
  let entry = makeEntry(actionTick);
  if (!syncOnly) {
    let before = replayActions(match, actions, actionTick);
    if (before.turn < matchTurn || before.activeTeam !== actorIndex) {
      const recoveryTick = Math.max(actionTick, (matchTurn - 1) * turnTicks);
      actionTick = Math.min(recoveryTick, currentTick + turnTicks * Math.max(1, matchTurn));
      entry = makeEntry(actionTick);
      before = replayActions(match, actions, actionTick);
    }
    if (before.turn !== matchTurn || before.activeTeam !== actorIndex) {
      return { error: 'stale action tick', status: 409 };
    }
  }

  const engine = replayActions(match, syncOnly ? actions : [...actions, entry], syncOnly ? actionTick + 1 : actionTick);
  const snap = engine.snapshot();
  if (input.action.type === 'fire' && snap.phase === 'aim' && snap.turn === matchTurn) {
    return { error: 'fire had no effect', status: 409 };
  }
  if (input.action.type === 'releaseCharge' && snap.phase === 'aim' && snap.turn === matchTurn) {
    return { error: 'release had no effect', status: 409 };
  }
  if (syncOnly && snap.phase !== 'aim' && snap.phase !== 'gameover') {
    return { error: 'shot still in flight', status: 409 };
  }
  if (syncOnly && snap.turn < matchTurn) {
    return { error: 'stale sync tick', status: 409 };
  }

  // An older replay must not drag a server-side expiry back to the prior turn.
  if (snap.turn >= matchTurn) {
    match.activeTeam = snap.activeTeam;
    if (snap.turn > matchTurn) {
      match.turn = snap.turn;
      match.turnStartedAt = now;
    }
    match.turnSeconds = snap.turnSeconds;
    match.phase = snap.phase;
    match.weapon = snap.weapon;
    match.hasFired = snap.phase === 'projectile' || snap.phase === 'settle';
    match.winnerTeam = snap.winnerTeam;
    match.endReason = snap.endReason;
    match.snapshot = snap;
    match.snapshotTick = engine.tick;
    match.revision = revision + 1;
    if (snap.phase === 'gameover') match.status = 'finished';
  }
  log.actions.push(entry);
  db.actionLogs[code.toUpperCase()] = log;
  persistOnline(db);

  return { code: match.code, match };
}

export function forfeitOnlineMatch(code: string, playerId: string): { code: string; match: OnlineMatch } | { error: string; status: number } {
  const db = getOnlineDb();
  const match = db.matches[code.toUpperCase()];
  if (!match) return { error: 'match not found', status: 404 };
  if (match.actionLogVersion !== 2) return { error: 'legacy online match is no longer supported', status: 410 };
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
  if (!match || match.actionLogVersion !== 2) return null;
  // Attach action log for replay.
  const log = (db.actionLogs || {})[code.toUpperCase()];
  if (log && Array.isArray(log.actions)) {
    (match as OnlineMatch & { actions?: unknown[] }).actions = getActionLog(code);
  }
  // A draw has no winnerTeam, so phase is the authoritative terminal marker.
  if (match.status === 'ready' && (match.phase === 'gameover' || match.snapshot?.phase === 'gameover')) {
    match.status = 'finished';
    persistOnline(db);
  }
  // Server-side turn expiry advance.
  if (match.status === 'ready' && match.winnerTeam == null && match.phase !== 'gameover' && isTurnExpired(match, Date.now())) {
    const advance = expiredTurnUpdate(match, new Date().toISOString());
    match.activeTeam = advance.activeTeam;
    match.turn = advance.turn;
    match.turnStartedAt = advance.turnStartedAt;
    match.phase = advance.phase;
    match.hasFired = advance.hasFired;
    match.weapon = advance.weapon;
    match.snapshot = advance.snapshot;
    match.snapshotTick = advance.snapshotTick;
    match.revision = (match.revision ?? 0) + 1;
    persistOnline(db);
  }
  return match;
}

function compareActionEntries(a: OnlineActionLogEntry, b: OnlineActionLogEntry): number {
  const ea = typeof a.engineTick === 'number' ? a.engineTick : (typeof a.tick === 'number' ? a.tick : 0);
  const eb = typeof b.engineTick === 'number' ? b.engineTick : (typeof b.tick === 'number' ? b.tick : 0);
  if (ea !== eb) return ea - eb;
  const sa = typeof a.seq === 'number' ? a.seq : 0;
  const sb = typeof b.seq === 'number' ? b.seq : 0;
  if (sa !== sb) return sa - sb;
  return String(a.at ?? '').localeCompare(String(b.at ?? ''));
}

export function getActionLog(code: string): OnlineActionLogEntry[] {
  const db = getOnlineDb();
  const log = (db.actionLogs || {})[code.toUpperCase()];
  const actions = Array.isArray(log?.actions) ? log.actions.filter((entry) => !entry.syncOnly) : [];
  return actions.sort(compareActionEntries);
}

function onlineMatchConfig(match: OnlineMatch): MatchConfig {
  const settings = match.settings ?? {};
  return {
    turnSeconds: match.turnSeconds ?? settings.turnSeconds ?? 45,
    wind: settings.wind ?? 'light',
    difficulty: settings.difficulty ?? 'veteran',
    seed: typeof settings.seed === 'number' ? settings.seed : 0,
    wormsPerTeam: settings.wormsPerTeam ?? 3,
    map: (settings.map as MatchConfig['map']) ?? 'island',
    mode: (settings.mode as MatchConfig['mode']) ?? 'deathmatch',
    loadout: (settings.loadout as MatchConfig['loadout']) ?? 'default',
    hotseat: true,
    teamCount: 2,
    teamNames: settings.teamNames,
  };
}

export function replayActions(match: OnlineMatch, actions: OnlineActionLogEntry[], stopTick: number | null): GameEngine {
  const engine = new GameEngine(onlineMatchConfig(match));
  const sorted = [...actions].sort(compareActionEntries);
  const limit = stopTick ?? 60 * 60 * 30;
  let cursor = 0;
  while (engine.phase !== 'gameover' && engine.tick < limit) {
    while (cursor < sorted.length) {
      const entry = sorted[cursor];
      const tick = typeof entry.engineTick === 'number' ? entry.engineTick : (typeof entry.tick === 'number' ? entry.tick : 0);
      if (tick !== engine.tick) break;
      engine.applyAction(entry.action as Parameters<GameEngine['applyAction']>[0]);
      cursor += 1;
    }
    engine.update(FIXED_DT);
  }
  while (cursor < sorted.length) {
    const entry = sorted[cursor];
    const tick = typeof entry.engineTick === 'number' ? entry.engineTick : (typeof entry.tick === 'number' ? entry.tick : 0);
    if (stopTick !== null && tick > stopTick) break;
    engine.applyAction(entry.action as Parameters<GameEngine['applyAction']>[0]);
    cursor += 1;
  }
  return engine;
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
  // Keep in sync with MAX_TICKS in infra/lambda/replay.js.
  const engine = replayActions(match, getActionLog(code), null);
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

/** Demo-mode bug reports keep metadata only; the screenshot data URL would blow the 5 MB quota. */
export function registerBugReport(payload: unknown): { stored: boolean; reportId: string; count: number } {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  const engine = body.engine && typeof body.engine === 'object' && !Array.isArray(body.engine)
    ? (body.engine as Record<string, unknown>)
    : {};
  const shot = body.screenshot && typeof body.screenshot === 'object' && !Array.isArray(body.screenshot)
    ? (body.screenshot as Record<string, unknown>)
    : null;
  const reportId = typeof body.reportId === 'string' ? body.reportId : '';
  const record = {
    reportId,
    sessionId: body.sessionId,
    matchId: body.matchId,
    seed: engine.seed,
    url: body.url,
    note: body.note,
    createdAt: body.createdAt,
    screenshot: shot
      ? { mime: shot.mime, width: shot.width, height: shot.height, hasData: typeof shot.data === 'string' && shot.data.length > 0 }
      : null,
  };
  const raw = safeRead<unknown[]>(BUG_REPORT_KEY);
  const list = Array.isArray(raw) ? raw : [];
  list.push(record);
  while (list.length > 5) list.shift();
  const stored = safeWrite(BUG_REPORT_KEY, list);
  return { stored, reportId, count: list.length };
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
