'use strict';

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const TABLE = process.env.TABLE_NAME;
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

  const maxBytes = Number(process.env.DEBUG_LOG_MAX_PAYLOAD_BYTES || 1000000);
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
  if (body.chunk !== undefined && !Number.isInteger(body.chunk)) return 'invalid chunk';
  if (body.totalChunks !== undefined && !Number.isInteger(body.totalChunks)) return 'invalid totalChunks';
  return null;
}

/** Keep untrusted key segments inside one S3 "folder" and free of separators. */
function keySegment(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, 128);
}

exports.handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET';
  const path = (event.rawPath || event.path || '/').replace(/\/+$/, '') || '/';
  try {
    if (method === 'GET' && path === '/health') return await health();
    if (method === 'GET' && path === '/api/leaderboard') return await getLeaderboard(event);
    if (method === 'GET' && path === '/api/matches') return await getMatches(event);
    if (method === 'POST' && path === '/api/matches') return await postMatch(event);
    if (method === 'POST' && path === '/api/debug-logs') return await postDebugLog(event);
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
exports.postDebugLog = postDebugLog;
exports.validateDebugLogBody = validateDebugLogBody;
exports.keyOf = keyOf;
exports.validateBody = validateBody;
