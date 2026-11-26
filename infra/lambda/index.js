'use strict';

const crypto = require('crypto');
const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { GameEngine, WEAPONS } = require('./engine.cjs');
const { replayActionLog, sortActions, ENGINE_VERSION } = require('./replay.js');

const TABLE = process.env.TABLE_NAME;
const ACTION_LOG_VERSION = 2;
const LEGACY_MATCH = Object.freeze({ legacy: true });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
  } catch (e) {
    return {};
  }
}

function qs(event) {
  return event.queryStringParameters || {};
}

async function health() {
  return json(200, { ok: true, service: 'wormage', time: new Date().toISOString() });
}

async function getLeaderboard(event, ddbClient = ddb) {
  const q = qs(event);
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.max(1, Math.min(50, Number(q.pageSize) || 8));
  const configKey = q.configKey;
  if (!configKey) return json(400, { message: 'configKey is required' });

  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'LeaderboardIndex',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': `CONFIG#${configKey}` },
  }));

  const items = result.Items || [];
  const best = new Map();
  for (const m of items) {
    const cur = best.get(m.playerId);
    if (!cur || m.score > cur.score) best.set(m.playerId, m);
  }
  const sorted = [...best.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.durationSeconds !== b.durationSeconds) return a.durationSeconds - b.durationSeconds;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  const rows = sorted.map((m, i) => ({
    rank: i + 1,
    playerId: m.playerId,
    playerName: m.playerName,
    teamName: m.teamName,
    score: m.score,
    kills: m.kills,
    durationSeconds: m.durationSeconds,
    configKey: m.configKey,
    createdAt: m.createdAt,
  }));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return json(200, { items: rows.slice(start, start + pageSize), page, pageSize, total, totalPages });
}

async function getMatches(event, ddbClient = ddb) {
  const q = qs(event);
  const playerId = q.playerId || '';
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.max(1, Math.min(50, Number(q.pageSize) || 8));
  if (!playerId) return json(400, { message: 'playerId is required' });

  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'PlayerIndex',
    KeyConditionExpression: 'playerId = :p',
    ExpressionAttributeValues: { ':p': playerId },
    ScanIndexForward: false,
  }));
  const items = (result.Items || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize).map((m) => ({
    id: m.id,
    clientMatchId: m.clientMatchId,
    matchId: m.matchId,
    playerId: m.playerId,
    playerName: m.playerName,
    teamName: m.teamName,
    score: m.score,
    durationSeconds: m.durationSeconds,
    endReason: m.endReason,
    configKey: m.configKey,
    turnSeconds: m.turnSeconds,
    wind: m.wind,
    difficulty: m.difficulty,
    kills: m.kills,
    createdAt: m.createdAt,
  }));
  return json(200, { items: pageItems, page, pageSize, total, totalPages });
}

function keyOf(turnSeconds, wind, difficulty, map, mode, loadout) {
  return `${turnSeconds}s-${wind}-${difficulty}-${map || 'island'}-${mode || 'deathmatch'}-${loadout || 'default'}`;
}

function toRecord(m) {
  return {
    id: m.id,
    clientMatchId: m.clientMatchId,
    matchId: m.matchId,
    playerId: m.playerId,
    playerName: m.playerName,
    teamName: m.teamName,
    score: m.score,
    durationSeconds: m.durationSeconds,
    endReason: m.endReason,
    configKey: m.configKey,
    turnSeconds: m.turnSeconds,
    wind: m.wind,
    difficulty: m.difficulty,
    kills: m.kills,
    createdAt: m.createdAt,
  };
}

const ALLOWED_WIND = new Set(['off', 'light', 'strong']);
const ALLOWED_DIFFICULTY = new Set(['rookie', 'veteran', 'elite']);
const ALLOWED_MAP = new Set(['island', 'mesa', 'canyon', 'desert', 'arctic']);
const ALLOWED_MODE = new Set(['deathmatch', 'assassinate', 'sudden-death', 'fort']);
const ALLOWED_LOADOUT = new Set(['default', 'heavy', 'scout']);
const ALLOWED_END = new Set(['time', 'wipeout', 'surrender']);

function isStr(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= (max || 64); }
function isNum(v, min, max) { return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max; }
function legacyGone() { return json(410, { message: 'legacy online match is no longer supported' }); }
function sameAction(a, b) {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}
function duplicateResponse(code, match, entry, playerId, action) {
  if (!entry) return null;
  if (entry.playerId !== playerId || !sameAction(entry.action, action)) {
    return json(409, { message: 'clientActionId already used' });
  }
  return json(200, { code, match: toOnlineMatch(match), duplicate: true });
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid body';
  if (!isStr(body.clientMatchId)) return 'clientMatchId is required';
  if (!isStr(body.playerId)) return 'playerId is required';
  if (!isStr(body.playerName)) return 'playerName is required';
  if (!isStr(body.teamName)) return 'teamName is required';
  if (body.score !== undefined && !isNum(body.score, 0, 1e9)) return 'score out of range';
  if (body.durationSeconds !== undefined && !isNum(body.durationSeconds, 0, 1e6)) return 'durationSeconds out of range';
  if (body.kills !== undefined && !isNum(body.kills, 0, 10000)) return 'kills out of range';
  if (body.turnSeconds !== undefined && !isNum(body.turnSeconds, 1, 600)) return 'turnSeconds out of range';
  if (body.wind !== undefined && !ALLOWED_WIND.has(body.wind)) return 'invalid wind';
  if (body.difficulty !== undefined && !ALLOWED_DIFFICULTY.has(body.difficulty)) return 'invalid difficulty';
  if (body.map !== undefined && !ALLOWED_MAP.has(body.map)) return 'invalid map';
  if (body.mode !== undefined && !ALLOWED_MODE.has(body.mode)) return 'invalid mode';
  if (body.loadout !== undefined && !ALLOWED_LOADOUT.has(body.loadout)) return 'invalid loadout';
  if (body.endReason !== undefined && !ALLOWED_END.has(body.endReason)) return 'invalid endReason';
  return null;
}

async function postMatch(event, ddbClient = ddb) {
  const body = parseBody(event);
  const err = validateBody(body);
  if (err) return json(400, { message: err });
  if (!body.clientMatchId) return json(400, { message: 'clientMatchId is required' });

  const existing = await ddbClient.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `CLIENT#${body.clientMatchId}`, sk: 'META' },
  }));
  if (existing.Item) {
    return json(200, toRecord(existing.Item));
  }

  const now = new Date().toISOString();
  const configKey = keyOf(body.turnSeconds, body.wind, body.difficulty, body.map, body.mode, body.loadout);
  const record = {
    id: `match-${crypto.randomUUID().slice(0, 8)}`,
    clientMatchId: body.clientMatchId,
    matchId: `M-${Date.now().toString(36).toUpperCase()}`,
    playerId: body.playerId,
    playerName: body.playerName,
    teamName: body.teamName,
    score: Math.max(0, Math.round(Number(body.score) || 0)),
    durationSeconds: Math.max(0, Math.round(Number(body.durationSeconds) || 0)),
    endReason: body.endReason,
    configKey,
    turnSeconds: body.turnSeconds,
    wind: body.wind,
    difficulty: body.difficulty,
    kills: Math.max(0, Math.round(Number(body.kills) || 0)),
    createdAt: now,
  };
  const item = {
    pk: `CLIENT#${body.clientMatchId}`,
    sk: 'META',
    type: 'match',
    ...record,
    gsi1pk: `CONFIG#${configKey}`,
    gsi1sk: now,
  };
  // PlayerIndex is a GSI keyed by playerId; store playerId as top-level attribute for GSI key.
  item.playerId = body.playerId;

  let created = true;
  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err) {
    if (err && err.name === 'ConditionalCheckFailedException') {
      created = false;
    } else {
      throw err;
    }
  }

  // Re-read to return the canonical (idempotent) record.
  const after = await ddbClient.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `CLIENT#${body.clientMatchId}`, sk: 'META' },
  }));
  const stored = after.Item || item;
  return json(created ? 201 : 200, toRecord(stored));
}


async function postDebugLog(event, s3Client = s3) {
  const body = parseBody(event);
  const err = validateDebugLogBody(body);
  if (err) return json(400, { message: err });

  if (process.env.DEBUG_LOGS_ENABLED === 'false') {
    return json(202, { stored: false, reason: 'disabled' });
  }
  const bucket = process.env.DEBUG_LOG_BUCKET;
  if (!bucket) return json(500, { message: 'debug log bucket is not configured' });

  const maxBytes = Number(process.env.DEBUG_LOG_MAX_PAYLOAD_BYTES || 256000);
  const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (size > maxBytes) return json(413, { message: 'payload too large' });

  const env = process.env.DEBUG_LOG_ENV || process.env.NODE_ENV || 'prod';
  const prefix = (process.env.DEBUG_LOG_PREFIX || 'debug-logs').replace(/\/+$/, '');
  const now = new Date();
  const yyyy = now.toISOString().slice(0, 4);
  const mm = now.toISOString().slice(5, 7);
  const dd = now.toISOString().slice(8, 10);
  // Client-supplied segments must not escape the prefix or collide across flushes.
  const flushId = keySegment(body.flushId || now.toISOString());
  const chunk = Number.isInteger(body.chunk) ? body.chunk : 1;
  const key = `${prefix}/${env}/${yyyy}/${mm}/${dd}/${keySegment(body.sessionId)}/${flushId}-${chunk}.json`;

  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(body),
    ContentType: 'application/json',
  }));

  console.log(JSON.stringify({
    type: 'debug-log',
    sessionId: body.sessionId,
    matchId: body.matchId,
    flushId,
    chunk,
    entries: Array.isArray(body.entries) ? body.entries.length : 0,
    snapshots: Array.isArray(body.snapshots) ? body.snapshots.length : 0,
    s3Key: key,
  }));

  return json(201, { stored: true, sessionId: body.sessionId, s3Key: key });
}

function validateDebugLogBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid body';
  if (!isStr(body.sessionId, 128)) return 'sessionId is required';
  if (!isStr(body.matchId, 128)) return 'matchId is required';
  if (!Array.isArray(body.entries)) return 'entries must be an array';
  if (!Array.isArray(body.snapshots)) return 'snapshots must be an array';
  if (body.entries.length > 100000) return 'too many entries';
  if (body.snapshots.length > 10000) return 'too many snapshots';
  if (body.schemaVersion !== undefined && !isNum(body.schemaVersion, 1, 1000)) return 'invalid schemaVersion';
  if (body.flushId !== undefined && !isStr(body.flushId, 128)) return 'invalid flushId';
  if (body.chunk !== undefined && (!Number.isInteger(body.chunk) || body.chunk < 1)) return 'invalid chunk';
  if (body.totalChunks !== undefined && (!Number.isInteger(body.totalChunks) || body.totalChunks < 1)) return 'invalid totalChunks';
  return null;
}

const SCREENSHOT_MAGIC = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
};

function validateBugReportBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid body';
  if (!isStr(body.reportId, 128)) return 'reportId is required';
  if (!isStr(body.sessionId, 128)) return 'sessionId is required';
  if (!isStr(body.matchId, 128)) return 'matchId is required';
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) return 'invalid note';
  if (body.url !== undefined && (typeof body.url !== 'string' || body.url.length > 4000)) return 'invalid url';
  if (!body.engine || typeof body.engine !== 'object' || Array.isArray(body.engine)) return 'engine is required';
  if (!body.engine.config || typeof body.engine.config !== 'object' || Array.isArray(body.engine.config)) return 'invalid config';
  if (!isNum(body.engine.seed, 0, 1e15)) return 'invalid seed';
  if (!body.engine.snapshot || typeof body.engine.snapshot !== 'object' || Array.isArray(body.engine.snapshot)) return 'snapshot is required';
  if (!body.debug || typeof body.debug !== 'object' || Array.isArray(body.debug)) return 'debug is required';
  if (!Array.isArray(body.debug.entries) || !Array.isArray(body.debug.snapshots)) return 'invalid debug';
  if (body.debug.entries.length > 5000) return 'too many debug entries';
  if (body.debug.snapshots.length > 200) return 'too many debug snapshots';
  if (body.actionLog !== undefined && !Array.isArray(body.actionLog)) return 'invalid actionLog';
  if (body.actionLog !== undefined && body.actionLog.length > 5000) return 'too many actions';
  if (body.screenshot !== undefined && body.screenshot !== null) {
    const shot = body.screenshot;
    if (typeof shot !== 'object' || Array.isArray(shot)) return 'invalid screenshot';
    if (shot.mime !== 'image/png' && shot.mime !== 'image/jpeg') return 'invalid screenshot mime';
    // 2.6 MB raw = ~3.47M base64 chars.
    if (typeof shot.data !== 'string' || shot.data.length === 0 || shot.data.length > 3500000) return 'invalid screenshot data';
    if (!isNum(shot.width, 1, 20000)) return 'invalid screenshot width';
    if (!isNum(shot.height, 1, 20000)) return 'invalid screenshot height';
  }
  return null;
}

function decodeScreenshot(shot) {
  const raw = shot.data.includes(',') ? shot.data.slice(shot.data.indexOf(',') + 1) : shot.data;
  const bytes = Buffer.from(raw, 'base64');
  const magic = SCREENSHOT_MAGIC[shot.mime];
  if (bytes.length < magic.length || !bytes.subarray(0, magic.length).equals(magic)) return null;
  return bytes;
}

async function postBugReport(event, s3Client = s3) {
  const body = parseBody(event);
  const err = validateBugReportBody(body);
  if (err) return json(400, { message: err });

  if (process.env.BUG_REPORTS_ENABLED === 'false') {
    return json(202, { stored: false, reason: 'disabled' });
  }
  const bucket = process.env.DEBUG_LOG_BUCKET;
  if (!bucket) return json(500, { message: 'debug log bucket is not configured' });

  const maxBytes = Number(process.env.BUG_REPORT_MAX_BYTES || 4000000);
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > maxBytes) {
    return json(413, { message: 'payload too large' });
  }

  let screenshotBytes = null;
  if (body.screenshot) {
    screenshotBytes = decodeScreenshot(body.screenshot);
    if (!screenshotBytes) return json(400, { message: 'invalid screenshot data' });
    if (screenshotBytes.length > 2600000) return json(413, { message: 'screenshot too large' });
    const pixels = body.screenshot.width * body.screenshot.height;
    if (!Number.isFinite(pixels) || pixels > 40_000_000) return json(413, { message: 'screenshot dimensions too large' });
  }

  const env = process.env.DEBUG_LOG_ENV || process.env.NODE_ENV || 'prod';
  const prefix = (process.env.BUG_REPORT_PREFIX || 'bug-reports').replace(/\/+$/, '');
  const now = new Date();
  const yyyy = now.toISOString().slice(0, 4);
  const mm = now.toISOString().slice(5, 7);
  const dd = now.toISOString().slice(8, 10);
  const reportId = keySegment(body.reportId);
  const base = `${prefix}/${env}/${yyyy}/${mm}/${dd}/${reportId}`;

  let screenshotKey = null;
  if (screenshotBytes && body.screenshot) {
    const ext = body.screenshot.mime === 'image/png' ? 'png' : 'jpg';
    screenshotKey = `${base}.${ext}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: screenshotKey,
      Body: screenshotBytes,
      ContentType: body.screenshot.mime,
    }));
  }

  const { screenshot: _screenshot, ...context } = body;
  const reportKey = `${base}.json`;
  const metadata = {
    ...context,
    receivedAt: now.toISOString(),
    screenshot: screenshotKey
      ? {
          key: screenshotKey,
          mime: body.screenshot.mime,
          width: body.screenshot.width ?? null,
          height: body.screenshot.height ?? null,
          bytes: screenshotBytes.length,
        }
      : null,
  };
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: reportKey,
      Body: JSON.stringify(metadata),
      ContentType: 'application/json',
    }));
  } catch (err) {
    // Avoid leaving an image object with no report metadata.
    if (screenshotKey) {
      try { await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: screenshotKey })); } catch { /* best effort */ }
    }
    throw err;
  }

  console.log(JSON.stringify({
    type: 'bug-report',
    reportId: body.reportId,
    sessionId: body.sessionId,
    matchId: body.matchId,
    screenshotBytes: screenshotBytes ? screenshotBytes.length : 0,
    reportKey,
  }));

  return json(201, {
    stored: true,
    reportId: body.reportId,
    keys: { report: reportKey, screenshot: screenshotKey },
  });
}

/** Keep untrusted key segments inside one S3 "folder" and free of separators. */
function keySegment(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, 128);
}

const ONLINE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateOnlineCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += ONLINE_CODE_ALPHABET[bytes[i] % ONLINE_CODE_ALPHABET.length];
  return code;
}

function toOnlineMatch(m) {
  const seen = new Set();
  const players = Array.isArray(m.players)
    ? m.players.filter((p) => p && typeof p.playerId === 'string' && !seen.has(p.playerId) && seen.add(p.playerId))
    : [];
  return {
    code: m.code,
    actionLogVersion: m.actionLogVersion,
    status: m.status,
    createdAt: m.createdAt,
    maxPlayers: m.maxPlayers,
    settings: m.settings || {},
    players,
    activeTeam: typeof m.activeTeam === 'number' ? m.activeTeam : 0,
    turn: typeof m.turn === 'number' ? m.turn : 1,
    turnStartedAt: m.turnStartedAt || m.createdAt,
    turnSeconds: typeof m.turnSeconds === 'number' ? m.turnSeconds : (m.settings && m.settings.turnSeconds) || 45,
    winnerTeam: m.winnerTeam != null ? m.winnerTeam : null,
    endReason: m.endReason || null,
    phase: m.phase || 'aim',
    hasFired: !!m.hasFired,
    engineVersion: m.engineVersion || null,
    snapshot: m.snapshot || null,
    snapshotTick: typeof m.snapshotTick === 'number' ? m.snapshotTick : null,
  };
}

async function postOnlineMatch(event, ddbClient = ddb) {
  const body = parseBody(event);
  if (!isStr(body.playerId)) return json(400, { message: 'playerId is required' });
  if (!isStr(body.playerName)) return json(400, { message: 'playerName is required' });
  const teamName = isStr(body.teamName) ? body.teamName : 'Team 1';
  const settings = (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) ? body.settings : {};
  if (settings.seed === undefined) {
    settings.seed = Math.floor(Math.random() * 1_000_000_000);
  }
  // DynamoDB rejects `undefined` values; keep only defined keys.
  const cleanSettings = {};
  for (const k of ['turnSeconds', 'wind', 'difficulty', 'map', 'mode', 'loadout', 'wormsPerTeam', 'teamCount', 'teamNames', 'seed']) {
    if (settings[k] !== undefined) cleanSettings[k] = settings[k];
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateOnlineCode();
    const now = new Date().toISOString();
    const item = {
      pk: `ONLINE#${code}`,
      sk: 'META',
      type: 'online-match',
      code,
      actionLogVersion: ACTION_LOG_VERSION,
      status: 'waiting',
      createdAt: now,
      maxPlayers: 2,
      settings: cleanSettings,
      activeTeam: 0,
      turn: 1,
      turnStartedAt: now,
      turnSeconds: (settings.turnSeconds != null ? settings.turnSeconds : 45),
      winnerTeam: null,
      endReason: null,
      phase: 'aim',
      hasFired: false,
      engineVersion: ENGINE_VERSION,
      revision: 0,
      ammo: [{ bazooka: 999, grenade: 3, shotgun: 4, dynamite: 2, medkit: 2, shield: 1 },
             { bazooka: 999, grenade: 3, shotgun: 4, dynamite: 2, medkit: 2, shield: 1 }],
      players: [{ playerId: body.playerId, playerName: body.playerName, teamName }],
    };
    try {
      await ddbClient.send(new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return json(201, { code, link: `/online/${code}`, match: toOnlineMatch(item) });
    } catch (err) {
      if (err && err.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }
  return json(500, { message: 'could not allocate a unique code' });
}

async function joinOnlineMatch(event, rawCode, ddbClient = ddb) {
  const code = String(rawCode || '').toUpperCase().trim();
  const body = parseBody(event);
  if (!isStr(body.playerId)) return json(400, { message: 'playerId is required' });
  if (!isStr(body.playerName)) return json(400, { message: 'playerName is required' });
  const got = await ddbClient.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `ONLINE#${code}`, sk: 'META' },
  }));
  if (!got.Item) return json(404, { message: 'match not found' });
  const match = got.Item;
  if (match.actionLogVersion !== ACTION_LOG_VERSION) return legacyGone();
  const teamName = isStr(body.teamName) ? body.teamName : `Team ${(Array.isArray(match.players) ? match.players.length : 0) + 1}`;

  if (Array.isArray(match.players) && match.players.some((p) => p && p.playerId === body.playerId)) {
    return json(200, { code: match.code, match: toOnlineMatch(match) });
  }
  if (!Array.isArray(match.players) || match.players.length >= (match.maxPlayers || 2)) {
    return json(409, { message: 'match is full' });
  }

  const newPlayer = { playerId: body.playerId, playerName: body.playerName, teamName };
  const now = new Date().toISOString();
  try {
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `ONLINE#${code}`, sk: 'META' },
      UpdateExpression: 'SET players = list_append(players, :p), #s = :ready, activeTeam = :at, turn = :t, turnStartedAt = :ts',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':p': [newPlayer], ':ready': 'ready', ':max': match.maxPlayers || 2, ':at': 0, ':t': 1, ':ts': now },
      ConditionExpression: 'size(players) < :max',
    }));
  } catch (err) {
    if (err && err.name === 'ConditionalCheckFailedException') {
      const after = await ddbClient.send(new GetCommand({
        TableName: TABLE,
        Key: { pk: `ONLINE#${code}`, sk: 'META' },
      }));
      if (!after.Item) return json(404, { message: 'match not found' });
      return json(409, { message: 'match is full' });
    }
    throw err;
  }

  const after = await ddbClient.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `ONLINE#${code}`, sk: 'META' },
  }));
  if (!after.Item) return json(404, { message: 'match not found' });
  return json(200, { code: after.Item.code, match: toOnlineMatch(after.Item) });
}

async function getOnlineMatch(event, rawCode, ddbClient = ddb) {
  const code = String(rawCode || '').toUpperCase().trim();
  const got = await ddbClient.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `ONLINE#${code}`, sk: 'META' },
  }));
  if (!got.Item) return json(404, { message: 'match not found' });
  let match = got.Item;
  if (match.actionLogVersion !== ACTION_LOG_VERSION) return legacyGone();

  const log = await getActionLog(code, ddbClient);
  const actions = log.actions;

  // A draw has no winnerTeam, so phase is the authoritative terminal marker.
  if (match.status === 'ready' && (match.phase === 'gameover' || (match.snapshot && match.snapshot.phase === 'gameover'))) {
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `ONLINE#${code}`, sk: 'META' },
      UpdateExpression: 'SET #status = :finished',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':finished': 'finished' },
    }));
    match.status = 'finished';
  }

  // Server-side turn expiry advance.
  if (match.status === 'ready' && match.winnerTeam == null && match.phase !== 'gameover' && match.turnStartedAt) {
    const elapsed = Date.now() - new Date(match.turnStartedAt).getTime();
    const ts = match.turnSeconds != null ? match.turnSeconds : 45;
    const limit = ts * 1000;
    if (elapsed >= limit) {
      const now = new Date().toISOString();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (match.status !== 'ready' || match.winnerTeam != null || match.phase === 'gameover') break;
        if (Date.now() - new Date(match.turnStartedAt).getTime() < limit) break;
        const expectedRevision = match.revision || 0;
        const newTurn = (match.turn || 1) + 1;
        const n = Array.isArray(match.players) ? match.players.length : 0;
        let nextTeam = match.activeTeam;
        for (let i = 1; i <= n; i += 1) {
          const idx = (match.activeTeam + i) % n;
          if (match.players[idx] && match.players[idx].playerId) { nextTeam = idx; break; }
        }
        try {
          await ddbClient.send(new UpdateCommand({
            TableName: TABLE,
            Key: { pk: `ONLINE#${code}`, sk: 'META' },
            UpdateExpression: 'SET activeTeam = :at, turn = :t, turnStartedAt = :ts, #phase = :aim, hasFired = :false, weapon = :weapon, snapshot = :null, snapshotTick = :null, revision = :revision',
            ExpressionAttributeNames: { '#phase': 'phase' },
            ExpressionAttributeValues: { ':at': nextTeam, ':t': newTurn, ':ts': now, ':old': match.turnStartedAt, ':expectedRevision': expectedRevision, ':aim': 'aim', ':false': false, ':weapon': 'bazooka', ':null': null, ':revision': expectedRevision + 1 },
            ConditionExpression: 'turnStartedAt = :old AND (attribute_not_exists(revision) OR revision = :expectedRevision)',
          }));
          match = { ...match, activeTeam: nextTeam, turn: newTurn, turnStartedAt: now, phase: 'aim', hasFired: false, weapon: 'bazooka', snapshot: null, snapshotTick: null, revision: expectedRevision + 1 };
          break;
        } catch (err) {
          if (!err || err.name !== 'ConditionalCheckFailedException') throw err;
          const after = await ddbClient.send(new GetCommand({
            TableName: TABLE,
            Key: { pk: `ONLINE#${code}`, sk: 'META' },
          }));
          if (!after.Item) break;
          match = after.Item;
        }
      }
    }
  }

  const out = toOnlineMatch(match);
  out.actions = actions;
  return json(200, { code: match.code, match: out });
}


const ACTION_CAP = 500;

async function getActionLog(code, ddbClient = ddb, includeSync = false) {
  const actions = [];
  let exclusiveStartKey;
  do {
    const query = {
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': 'MATCH#' + code, ':prefix': 'ACTION#' },
      ConsistentRead: true,
      ScanIndexForward: true,
    };
    if (exclusiveStartKey) query.ExclusiveStartKey = exclusiveStartKey;
    const result = await ddbClient.send(new QueryCommand(query));
    actions.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  const sorted = sortActions(actions);
  return { actions: includeSync ? sorted : sorted.filter((entry) => !entry.syncOnly) };
}

async function replayOnlineMatch(code, ddbClient) {
  const client = ddbClient || ddb;
  const normalized = String(code).toUpperCase().trim();
  const got = await client.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ONLINE#' + normalized, sk: 'META' } }));
  if (!got.Item) return null;
  if (got.Item.actionLogVersion !== ACTION_LOG_VERSION) return LEGACY_MATCH;
  const log = await getActionLog(normalized, client);
  return replayActionLog({ GameEngine, match: got.Item, actions: log.actions });
}

async function submitAction(event, rawCode, ddbClient) {
  if (!ddbClient) ddbClient = ddb;
  const code = String(rawCode || '').toUpperCase().trim();
  const body = parseBody(event);
  if (!isStr(body.playerId)) return json(400, { message: 'playerId is required' });
  if (!isStr(body.clientActionId)) return json(400, { message: 'clientActionId is required' });
  if (!body.action || typeof body.action !== 'object' || Array.isArray(body.action)) return json(400, { message: 'action is required' });
  const action = body.action;
  if (!isStr(action.type)) return json(400, { message: 'action.type is required' });
  const rawTick = (typeof body.tick === 'number' && Number.isFinite(body.tick)) ? body.tick : (typeof body.engineTick === 'number' && Number.isFinite(body.engineTick)) ? body.engineTick : null;
  const engineTick = rawTick == null ? null : Math.max(0, Math.min(1000000, Math.floor(rawTick)));

  const got = await ddbClient.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ONLINE#' + code, sk: 'META' } }));
  if (!got.Item) return json(404, { message: 'match not found' });
  const match = got.Item;
  if (match.actionLogVersion !== ACTION_LOG_VERSION) return legacyGone();

  const players = Array.isArray(match.players) ? match.players : [];
  const syncId = action.type === 'endTurn' && body.clientActionId.endsWith('-endTurn-sync')
    ? body.clientActionId
    : null;
  // Idempotency: check before readiness, turn and phase validation.
  const log = await getActionLog(code, ddbClient, true);
  const allActions = log.actions;
  const actions = allActions.filter((entry) => !entry.syncOnly);
  const duplicate = allActions.find((entry) => entry.clientActionId === body.clientActionId);
  const duplicateResult = duplicateResponse(code, match, duplicate, body.playerId, action);
  if (duplicateResult) return duplicateResult;

  if (match.status !== 'ready') return json(409, { message: 'match not ready' });
  if (match.winnerTeam != null) return json(409, { message: 'match finished' });
  if (!players.some((p) => p && p.playerId === body.playerId)) return json(403, { message: 'not a participant' });
  if (syncId && (match.phase || 'aim') === 'aim') return json(409, { message: 'shot not found' });

  if (players[match.activeTeam] && players[match.activeTeam].playerId !== body.playerId) return json(409, { message: 'not your turn' });

  const phase = match.phase || 'aim';
  const type = action.type;
  if (phase === 'gameover') return json(409, { message: 'match finished' });
  const syncOnly = type === 'endTurn' && phase !== 'aim';
  if (type === 'weapon' && !(typeof action.id === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, action.id))) {
    return json(400, { message: 'unknown weapon' });
  }
  const aimOnly = ['move', 'aim', 'jump', 'rope', 'reel', 'weapon', 'startCharge', 'releaseCharge'];
  if (type === 'fire' || type === 'startCharge') {
    if (phase !== 'aim' || match.hasFired) return json(409, { message: 'illegal action for current phase' });
  } else if (type === 'endTurn') {
    const endingShot = match.hasFired && (phase === 'projectile' || phase === 'settle');
    if (phase !== 'aim' && !endingShot) return json(409, { message: 'illegal action for current phase' });
  } else if (aimOnly.includes(type)) {
    if (phase !== 'aim') return json(409, { message: 'illegal action for current phase' });
  } else {
    return json(400, { message: 'unknown action type' });
  }

  if (allActions.length >= ACTION_CAP) return json(409, { message: 'action log full' });

  const now = new Date().toISOString();
  const seq = allActions.reduce((m, a) => Math.max(m, (a && typeof a.seq === 'number') ? a.seq : 0), 0) + 1;
  const currentTick = typeof match.snapshotTick === 'number' ? match.snapshotTick : 0;
  // The client stamps its own engine tick, which keeps running between turns.
  // Never let one action fast-forward more than a turn of simulation: a stale
  // or hostile tick could otherwise end the match by replaying to MAX_TICKS.
  const turnSeconds = typeof match.turnSeconds === 'number' && match.turnSeconds > 0 ? match.turnSeconds : 45;
  const turnTicks = Math.ceil(turnSeconds * 60) + 1;
  const requestedTick = engineTick != null ? engineTick : currentTick;
  let actionTick = Math.max(currentTick, Math.min(requestedTick, currentTick + turnTicks));
  const matchTurn = match.turn || 1;
  const revision = typeof match.revision === 'number' ? match.revision : 0;
  const actorIndex = players.findIndex((p) => p && p.playerId === body.playerId);
  const makeEntry = (tick) => ({ seq, tick, turn: matchTurn, engineTick: tick, action, playerId: body.playerId, clientActionId: body.clientActionId, at: now, ...(syncOnly ? { syncOnly: true } : {}) });
  let entry = makeEntry(actionTick);
  if (!syncOnly) {
    try {
      let before = replayActionLog({ GameEngine, match, actions, stopTick: actionTick });
      if (before.snapshot.turn < matchTurn || before.snapshot.activeTeam !== actorIndex) {
        // A paused/reloaded client may still stamp an old tick. Recover through
        // expired turns, but never apply its input to the opponent's worm.
        const recoveryTick = Math.max(actionTick, (matchTurn - 1) * turnTicks);
        actionTick = Math.min(recoveryTick, currentTick + turnTicks * Math.max(1, matchTurn));
        entry = makeEntry(actionTick);
        before = replayActionLog({ GameEngine, match, actions, stopTick: actionTick });
      }
      if (before.snapshot.turn !== matchTurn || before.snapshot.activeTeam !== actorIndex) {
        return json(409, { message: 'stale action tick' });
      }
    } catch (err) {
      console.error('replay failed', err);
      return json(409, { message: 'illegal action' });
    }
  }

  // Replay before writing anything: an action the engine cannot apply must
  // leave both the match item and the action log untouched.
  let replay;
  try {
    replay = replayActionLog({
      GameEngine,
      match,
      actions: syncOnly ? actions : [...actions, entry],
      stopTick: syncOnly ? actionTick + 1 : actionTick,
    });
  } catch (err) {
    console.error('replay failed', err);
    return json(409, { message: 'illegal action' });
  }
  const snap = replay.snapshot;
  const fired = snap.phase === 'projectile' || snap.phase === 'settle';
  // A rejected fire (no ammo, launched worm, …) is otherwise accepted and
  // incorrectly flips the room into a phase the player cannot leave.
  if (type === 'fire' && snap.phase === 'aim' && snap.turn === matchTurn) {
    return json(409, { message: 'fire had no effect' });
  }
  if (type === 'releaseCharge' && snap.phase === 'aim' && snap.turn === matchTurn) {
    return json(409, { message: 'release had no effect' });
  }
  if (syncOnly && snap.phase !== 'aim' && snap.phase !== 'gameover') {
    return json(409, { message: 'shot still in flight' });
  }
  if (syncOnly && snap.turn < matchTurn) {
    return json(409, { message: 'stale sync tick' });
  }
  const updates = {
    turnSeconds: snap.turnSeconds,
    phase: snap.phase,
    weapon: snap.weapon,
    hasFired: fired,
    winnerTeam: snap.winnerTeam,
    endReason: snap.endReason,
    engineVersion: replay.engineVersion,
    snapshot: snap,
    snapshotTick: replay.tick,
    revision: revision + 1,
  };
  // getOnlineMatch advances an expired turn on its own. A replay that stopped
  // at an earlier tick must not drag the match back to the previous team.
  if (snap.turn >= matchTurn) {
    updates.turn = snap.turn;
    updates.activeTeam = snap.activeTeam;
    if (snap.turn > matchTurn) updates.turnStartedAt = now;
  }
  if (snap.phase === 'gameover') updates.status = 'finished';

  // Sync entries are stored for idempotency but filtered out of gameplay replay.
  const transactItems = [];
  const sk = `ACTION#${String(matchTurn).padStart(4, '0')}#${String(seq).padStart(4, '0')}`;
  transactItems.push({
    Put: {
      TableName: TABLE,
      Item: { pk: 'MATCH#' + code, sk, ...entry },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  });

  const exprParts = [];
  const names = {};
  const values = {};
  for (const [k, v] of Object.entries(updates)) {
    exprParts.push('#' + k + ' = :' + k);
    names['#' + k] = k;
    values[':' + k] = v;
  }
  values[':expectedRevision'] = revision;
  transactItems.push({
    Update: {
      TableName: TABLE,
      Key: { pk: 'ONLINE#' + code, sk: 'META' },
      UpdateExpression: 'SET ' + exprParts.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_not_exists(revision) OR revision = :expectedRevision',
    },
  });
  try {
    await ddbClient.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (err && err.name === 'TransactionCanceledException') {
      const [after, latestLog] = await Promise.all([
        ddbClient.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ONLINE#' + code, sk: 'META' } })),
        getActionLog(code, ddbClient, true),
      ]);
      const stored = after.Item || match;
      const duplicate = latestLog.actions.find((entry) => entry.clientActionId === body.clientActionId);
      const duplicateResult = duplicateResponse(code, stored, duplicate, body.playerId, action);
      return duplicateResult || json(409, { message: 'concurrent action, retry' });
    }
    throw err;
  }

  const after = await ddbClient.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ONLINE#' + code, sk: 'META' } }));
  const stored = after.Item || Object.assign({}, match, updates);
  return json(200, { code, match: toOnlineMatch(stored) });
}

async function forfeitOnlineMatch(event, rawCode, ddbClient) {
  if (!ddbClient) ddbClient = ddb;
  const code = String(rawCode || '').toUpperCase().trim();
  const body = parseBody(event);
  if (!isStr(body.playerId)) return json(400, { message: 'playerId is required' });

  const got = await ddbClient.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ONLINE#' + code, sk: 'META' } }));
  if (!got.Item) return json(404, { message: 'match not found' });
  const match = got.Item;
  if (match.actionLogVersion !== ACTION_LOG_VERSION) return legacyGone();
  const players = Array.isArray(match.players) ? match.players : [];
  if (!players.some((p) => p && p.playerId === body.playerId)) return json(403, { message: 'not a participant' });

  if (match.winnerTeam != null) {
    return json(200, { code: match.code, match: toOnlineMatch(match) });
  }

  const opponentIdx = players.findIndex((p) => p && p.playerId !== body.playerId);
  const winner = opponentIdx >= 0 ? opponentIdx : null;
  const now = new Date().toISOString();
  await ddbClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: 'ONLINE#' + code, sk: 'META' },
    UpdateExpression: 'SET #s = :finished, winnerTeam = :w, endReason = :r, finishedAt = :f',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':finished': 'finished', ':w': winner, ':r': 'surrender', ':f': now },
  }));

  const after = await ddbClient.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ONLINE#' + code, sk: 'META' } }));
  const stored = after.Item || match;
  return json(200, { code: stored.code, match: toOnlineMatch(stored) });
}

exports.handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET';
  const path = (event.rawPath || event.path || '/').replace(/\/+$/, '') || '/';
  try {
    // CORS preflight: API Gateway forwards OPTIONS to this Lambda via the
    // catch-all route, so answer 2xx here instead of falling through to 404
    // (a 404 preflight breaks the browser's CORS check).
    if (method === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };
    if (method === 'GET' && path === '/health') return await health();
    if (method === 'GET' && path === '/api/leaderboard') return await getLeaderboard(event);
    if (method === 'GET' && path === '/api/matches') return await getMatches(event);
    if (method === 'POST' && path === '/api/matches') return await postMatch(event);
    if (method === 'GET' && /^\/api\/matches\/online\/[^/]+$/.test(path)) { const c = path.match(/^\/api\/matches\/online\/([^/]+)$/)[1]; return await getOnlineMatch(event, decodeURIComponent(c)); }
    if (method === 'POST' && path === '/api/matches/online') return await postOnlineMatch(event);
    const onlineJoin = path.match(/^\/api\/matches\/online\/([^/]+)\/join$/);
    if (method === 'POST' && onlineJoin) return await joinOnlineMatch(event, decodeURIComponent(onlineJoin[1]));
    const onlineAction = path.match(/^\/api\/matches\/online\/([^/]+)\/action$/);
    if (method === 'POST' && onlineAction) return await submitAction(event, decodeURIComponent(onlineAction[1]));
    const onlineForfeit = path.match(/^\/api\/matches\/online\/([^/]+)\/forfeit$/);
    if (method === 'POST' && onlineForfeit) return await forfeitOnlineMatch(event, decodeURIComponent(onlineForfeit[1]));
    const onlineReplay = path.match(/^\/api\/matches\/online\/([^/]+)\/replay$/);
    if (method === 'GET' && onlineReplay) {
      const replay = await replayOnlineMatch(decodeURIComponent(onlineReplay[1]));
      if (replay === LEGACY_MATCH) return legacyGone();
      return replay ? json(200, replay) : json(404, { message: 'match not found' });
    }
    if (method === 'POST' && path === '/api/debug-logs') return await postDebugLog(event);
    if (method === 'POST' && path === '/api/bug-reports') return await postBugReport(event);
    return json(404, { message: 'Not found' });
  } catch (err) {
    console.error(err);
    return json(500, { message: 'Internal error' });
  }
};


exports.health = health;
exports.getLeaderboard = getLeaderboard;
exports.getMatches = getMatches;
exports.postMatch = postMatch;
exports.postOnlineMatch = postOnlineMatch;
exports.joinOnlineMatch = joinOnlineMatch;
exports.getOnlineMatch = getOnlineMatch;
exports.submitAction = submitAction;
exports.forfeitOnlineMatch = forfeitOnlineMatch;
exports.getActionLog = getActionLog;
exports.replayOnlineMatch = replayOnlineMatch;
exports.replayOnlineTurn = replayOnlineMatch;
exports.replayMatch = exports.replayOnlineMatch;
exports.replayTurn = exports.replayOnlineMatch;
exports.generateOnlineCode = generateOnlineCode;
exports.postDebugLog = postDebugLog;
exports.validateDebugLogBody = validateDebugLogBody;
exports.postBugReport = postBugReport;
exports.validateBugReportBody = validateBugReportBody;
exports.keyOf = keyOf;
exports.validateBody = validateBody;
