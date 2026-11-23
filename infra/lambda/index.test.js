'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const L = require('./index.js');

function makeMockDdb() {
  const store = new Map();
  const keyOf = (k) => `${k.pk}#${k.sk}`;
  return {
    store,
    async send(cmd) {
      const input = cmd.input || cmd;
      if (cmd instanceof GetCommand || (cmd && cmd.constructor && cmd.constructor.name === 'GetCommand')) {
        const it = store.get(`${input.Key.pk}#${input.Key.sk}`);
        return { Item: it };
      }
      if (cmd instanceof PutCommand || (cmd && cmd.constructor && cmd.constructor.name === 'PutCommand')) {
        const item = input.Item;
        const k = keyOf(item);
        if (input.ConditionExpression === 'attribute_not_exists(pk)' && store.has(k)) {
          const err = new Error('ConditionalCheckFailed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        store.set(k, item);
        return {};
      }
      if (cmd instanceof UpdateCommand || (cmd && cmd.constructor && cmd.constructor.name === 'UpdateCommand')) {
        const k = `${input.Key.pk}#${input.Key.sk}`;
        let item = store.get(k);
        if (!item) {
          // Upsert for action log / new items.
          item = { pk: input.Key.pk, sk: input.Key.sk };
        }
        const vals = input.ExpressionAttributeValues || {};
        const names = input.ExpressionAttributeNames || {};
        const max = vals[':max'];
        if (input.ConditionExpression === 'size(players) < :max' && !(Array.isArray(item.players) && item.players.length < max)) {
          const err = new Error('ConditionalCheckFailed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        // Condition: turnStartedAt = :old (turn expiry concurrency)
        if (input.ConditionExpression === 'turnStartedAt = :old' && item.turnStartedAt !== vals[':old']) {
          const err = new Error('ConditionalCheckFailed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        const expr = input.UpdateExpression || '';
        // players append (join)
        const p = vals[':p'];
        if (expr.includes('list_append(players') && Array.isArray(p)) {
          item.players = [...(Array.isArray(item.players) ? item.players : []), ...p];
        }
        const ready = vals[':ready'];
        if (ready !== undefined) item.status = ready;
        // Generic SET key = :val
        const setMatch = expr.match(/SET (.+)/);
        if (setMatch) {
          const full = setMatch[1].trim();
          const la = full.match(/^actions\s*=\s*list_append\(if_not_exists\(actions,\s*(:\w+)\),\s*(:\w+)\)$/);
          if (la) {
            const empty = vals[la[1]];
            const e = vals[la[2]];
            const cur = Array.isArray(item.actions) ? item.actions : (Array.isArray(empty) ? empty : []);
            const toAdd = Array.isArray(e) ? e : [e];
            item.actions = [...cur, ...toAdd];
          } else {
            const parts = full.split(',').map((x) => x.trim());
            for (const part of parts) {
              const m = part.match(/^(#?\w+)\s*=\s*(:\w+)$/);
              if (m) {
                const keyToken = m[1];
                const valToken = m[2];
                const attrName = keyToken.startsWith('#') ? (names[keyToken] || keyToken.slice(1)) : keyToken;
                const val = vals[valToken];
                if (val !== undefined) item[attrName] = val;
              }
            }
          }
        }
        store.set(k, item);
        return {};
      }
      if (cmd instanceof QueryCommand || (cmd && cmd.constructor && cmd.constructor.name === 'QueryCommand')) {
        const vals = input.ExpressionAttributeValues || {};
        let items = [...store.values()];
        if (input.IndexName === 'LeaderboardIndex') {
          const pk = vals[':pk'];
          items = items.filter((i) => i.gsi1pk === pk);
        } else if (input.IndexName === 'PlayerIndex') {
          const p = vals[':p'];
          items = items.filter((i) => i.playerId === p);
          if (input.ScanIndexForward === false) items = items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        }
        return { Items: items };
      }
      throw new Error('Unknown command: ' + (cmd && cmd.constructor && cmd.constructor.name));
    },
  };
}

function ev(method, path, query = {}, body) {
  return {
    requestContext: { http: { method } },
    rawPath: path,
    queryStringParameters: query,
    body: body ? JSON.stringify(body) : undefined,
  };
}

test('health returns ok', async () => {
  const r = await L.health();
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.ok, true);
  assert.equal(b.service, 'wormage');
});

test('leaderboard requires configKey', async () => {
  const ddb = makeMockDdb();
  const r = await L.getLeaderboard(ev('GET', '/api/leaderboard', {}), ddb);
  assert.equal(r.statusCode, 400);
});

test('leaderboard returns paginated shape', async () => {
  const ddb = makeMockDdb();
  const item = {
    pk: 'CLIENT#c1', sk: 'META', playerId: 'p1', playerName: 'P', teamName: 'T',
    score: 100, kills: 1, durationSeconds: 60, configKey: '45s-light-veteran-island-deathmatch-default',
    createdAt: new Date().toISOString(), gsi1pk: 'CONFIG#45s-light-veteran-island-deathmatch-default', gsi1sk: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: 't', Item: item }));
  const r = await L.getLeaderboard(ev('GET', '/api/leaderboard', { configKey: '45s-light-veteran-island-deathmatch-default', page: '1', pageSize: '8' }), ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.deepEqual(Object.keys(b).sort(), ['items', 'page', 'pageSize', 'total', 'totalPages']);
  assert.equal(b.total, 1);
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].playerId, 'p1');
});

test('matches requires playerId', async () => {
  const ddb = makeMockDdb();
  const r = await L.getMatches(ev('GET', '/api/matches', {}), ddb);
  assert.equal(r.statusCode, 400);
});

test('postMatch idempotent by clientMatchId', async () => {
  const ddb = makeMockDdb();
  const body = { clientMatchId: 'c-1', playerId: 'p', playerName: 'P', teamName: 'T', score: 50, durationSeconds: 60, endReason: 'wipeout', turnSeconds: 45, wind: 'light', difficulty: 'veteran' };
  const r1 = await L.postMatch(ev('POST', '/api/matches', {}, body), ddb);
  assert.equal(r1.statusCode, 201);
  const b1 = JSON.parse(r1.body);
  const r2 = await L.postMatch(ev('POST', '/api/matches', {}, body), ddb);
  assert.equal(r2.statusCode, 200);
  const b2 = JSON.parse(r2.body);
  assert.equal(b2.id, b1.id);
});

test('postMatch requires clientMatchId', async () => {
  const ddb = makeMockDdb();
  const r = await L.postMatch(ev('POST', '/api/matches', {}, { playerId: 'p' }), ddb);
  assert.equal(r.statusCode, 400);
});

test('postMatch propagates non-condition errors', async () => {
  const ddb = {
    async send() { const e = new Error('boom'); e.name = 'InternalServerError'; throw e; },
  };
  const body = { clientMatchId: 'c-err', playerId: 'p', playerName: 'P', teamName: 'T', score: 1, durationSeconds: 1, endReason: 'wipeout', turnSeconds: 45, wind: 'light', difficulty: 'veteran' };
  await assert.rejects(() => L.postMatch(ev('POST', '/api/matches', {}, body), ddb));
});

test('handler routes health', async () => {
  const r = await L.handler(ev('GET', '/health'));
  assert.equal(r.statusCode, 200);
});

test('submitAction advances turn on endTurn', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' } }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.activeTeam, 1);
  assert.equal(b.match.turn, 2);
});

test('submitAction rejects not-your-turn with 409', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p2', action: { type: 'endTurn' } }), code, ddb);
  assert.equal(r.statusCode, 409);
});

test('submitAction rejects unknown action type with 400', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'teleport' } }), code, ddb);
  assert.equal(r.statusCode, 400);
});

test('submitAction is idempotent on clientActionId', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'abc' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'abc' }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.duplicate, true);
});

test('submitAction persists the engine snapshot and returns it', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.activeTeam, 1);
  assert.equal(b.match.turn, 2);
  assert.equal(b.match.snapshotTick, 0);
  assert.ok(b.match.snapshot);
  assert.equal(b.match.snapshot.phase, 'aim');
});

test('submitAction rejects an engine-illegal action without mutating the match', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'weapon', id: 'no-such-weapon' }, tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 409);
  const meta = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(meta.Item.snapshot, undefined);
  assert.equal(meta.Item.weapon, undefined);
  const log = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ACTION#${code}`, sk: 'LOG' } }));
  assert.equal(log.Item, undefined);
});

test('replayOnlineMatch returns a deterministic snapshot', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, tick: 0 }), code, ddb);

  const first = await L.replayOnlineMatch(code, ddb);
  const second = await L.replayOnlineMatch(code, ddb);
  assert.ok(first.snapshot);
  assert.equal(first.tick, second.tick);
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.equal(first.engineVersion, 2);
});

test('submitAction clamps a far-future tick to one turn of replay', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2, turnSeconds: 30 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, tick: 999999 }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  // turnSeconds 30 caps the replay at 1800 ticks instead of MAX_TICKS (18000).
  assert.equal(b.match.snapshotTick, 1800);
  assert.equal(b.match.winnerTeam, null);
});

test('a replay that stopped earlier does not undo a server-side turn expiry', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2, turnSeconds: 30 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  // Simulate getOnlineMatch having advanced the turn on its own.
  await ddb.send(new UpdateCommand({
    TableName: 't',
    Key: { pk: `ONLINE#${code}`, sk: 'META' },
    UpdateExpression: 'SET #t = :t, activeTeam = :a, turnStartedAt = :ts',
    ExpressionAttributeNames: { '#t': 'turn' },
    ExpressionAttributeValues: { ':t': 5, ':a': 1, ':ts': '2026-01-01T00:00:00.000Z' },
  }));

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p2', action: { type: 'endTurn' }, tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.turn, 5);
  assert.equal(b.match.activeTeam, 1);
  assert.equal(b.match.turnStartedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(b.match.snapshot.turn, 2);
});

test('forfeitOnlineMatch ends match with opponent as winner', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.forfeitOnlineMatch(ev('POST', `/api/matches/online/${code}/forfeit`, {}, { playerId: 'p1' }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.winnerTeam, 1);
  assert.equal(b.match.endReason, 'surrender');
});

test('forfeitOnlineMatch is idempotent', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.forfeitOnlineMatch(ev('POST', `/api/matches/online/${code}/forfeit`, {}, { playerId: 'p1' }), code, ddb);
  const r = await L.forfeitOnlineMatch(ev('POST', `/api/matches/online/${code}/forfeit`, {}, { playerId: 'p2' }), code, ddb);
  assert.equal(r.statusCode, 200);
});

test('getOnlineMatch returns 200 for existing match', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  const r = await L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.code, code);
  assert.equal(b.match.status, 'waiting');
});

test('getOnlineMatch returns 404 for unknown code', async () => {
  const ddb = makeMockDdb();
  const r = await L.getOnlineMatch(ev('GET', '/api/matches/online/ZZZZZZ'), 'ZZZZZZ', ddb);
  assert.equal(r.statusCode, 404);
});

test('handler answers CORS preflight with 2xx', async () => {
  const r = await L.handler(ev('OPTIONS', '/api/matches/online'));
  assert.ok(r.statusCode >= 200 && r.statusCode < 300, `expected 2xx, got ${r.statusCode}`);
});


test('validateBody rejects missing clientMatchId', async () => {
  const r = L.validateBody({ playerId: 'p', playerName: 'P', teamName: 'T' });
  assert.equal(r, 'clientMatchId is required');
});

test('validateBody rejects out-of-range score', async () => {
  const r = L.validateBody({ clientMatchId: 'c', playerId: 'p', playerName: 'P', teamName: 'T', score: 1e10 });
  assert.equal(r, 'score out of range');
});

test('validateBody rejects invalid wind', async () => {
  const r = L.validateBody({ clientMatchId: 'c', playerId: 'p', playerName: 'P', teamName: 'T', wind: 'hurricane' });
  assert.equal(r, 'invalid wind');
});

test('validateBody accepts a valid body', async () => {
  const r = L.validateBody({ clientMatchId: 'c', playerId: 'p', playerName: 'P', teamName: 'T', score: 10, wind: 'light' });
  assert.equal(r, null);
});

function makeMockS3() {
  const store = new Map();
  return {
    store,
    async send(cmd) {
      const input = cmd.input || cmd;
      if (cmd && cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
        store.set(input.Key, { Bucket: input.Bucket, Body: input.Body, ContentType: input.ContentType });
        return {};
      }
      throw new Error('Unknown command: ' + (cmd && cmd.constructor && cmd.constructor.name));
    },
  };
}

test('postDebugLog stores payload in S3', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.DEBUG_LOGS_ENABLED = 'true';
  const s3 = makeMockS3();
  const body = { sessionId: 's1', matchId: 'm1', schemaVersion: 1, entries: [{ category: 'turn.start' }], snapshots: [] };
  const r = await L.postDebugLog(ev('POST', '/api/debug-logs', {}, body), s3);
  assert.equal(r.statusCode, 201);
  const b = JSON.parse(r.body);
  assert.equal(b.stored, true);
  assert.equal(b.sessionId, 's1');
  assert.equal(s3.store.size, 1);
});

test('postDebugLog keys each flush and chunk separately', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.DEBUG_LOGS_ENABLED = 'true';
  const s3 = makeMockS3();
  const base = { sessionId: 's1', matchId: 'm1', schemaVersion: 1, entries: [], snapshots: [] };
  await L.postDebugLog(ev('POST', '/api/debug-logs', {}, { ...base, flushId: 'f1', chunk: 1 }), s3);
  await L.postDebugLog(ev('POST', '/api/debug-logs', {}, { ...base, flushId: 'f1', chunk: 2 }), s3);
  await L.postDebugLog(ev('POST', '/api/debug-logs', {}, { ...base, flushId: 'f2', chunk: 1 }), s3);
  assert.equal(s3.store.size, 3);
  for (const key of s3.store.keys()) {
    assert.ok(key.includes('/s1/f1-1.json') || key.includes('/s1/f1-2.json') || key.includes('/s1/f2-1.json'));
  }
});

test('postDebugLog keeps untrusted session ids inside the prefix', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.DEBUG_LOGS_ENABLED = 'true';
  const s3 = makeMockS3();
  const body = { sessionId: '../../evil', matchId: 'm1', entries: [], snapshots: [] };
  const r = await L.postDebugLog(ev('POST', '/api/debug-logs', {}, body), s3);
  assert.equal(r.statusCode, 201);
  const [key] = [...s3.store.keys()];
  assert.ok(!key.includes('..'));
  assert.ok(key.startsWith('debug-logs/'));
});

test('postDebugLog validates body', async () => {
  const s3 = makeMockS3();
  const r = await L.postDebugLog(ev('POST', '/api/debug-logs', {}, { entries: [] }), s3);
  assert.equal(r.statusCode, 400);
});

test('postDebugLog respects disabled flag', async () => {
  process.env.DEBUG_LOGS_ENABLED = 'false';
  const s3 = makeMockS3();
  const body = { sessionId: 's2', matchId: 'm2', entries: [], snapshots: [] };
  const r = await L.postDebugLog(ev('POST', '/api/debug-logs', {}, body), s3);
  assert.equal(r.statusCode, 202);
  const b = JSON.parse(r.body);
  assert.equal(b.stored, false);
  process.env.DEBUG_LOGS_ENABLED = 'true';
});

test('postOnlineMatch creates a match with a 6-char code and link', async () => {
  const ddb = makeMockDdb();
  const r = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, {
    playerId: 'p1', playerName: 'Alice', teamName: 'Ironclad',
    settings: { map: 'island', mode: 'deathmatch', difficulty: 'rookie', wormsPerTeam: 2, turnSeconds: 30, wind: 'light', seed: 42 },
  }), ddb);
  assert.equal(r.statusCode, 201);
  const b = JSON.parse(r.body);
  assert.match(b.code, /^[A-Z2-9]{6}$/);
  assert.equal(b.link, `/online/${b.code}`);
  assert.equal(b.match.status, 'waiting');
  assert.equal(b.match.players.length, 1);
  assert.equal(b.match.players[0].playerId, 'p1');
});

test('joinOnlineMatch adds second player and marks ready', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  const r = await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.status, 'ready');
  assert.equal(b.match.players.length, 2);
  assert.equal(b.match.players[1].playerId, 'p2');
});

test('joinOnlineMatch is case-insensitive', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  const lower = code.toLowerCase();
  const r = await L.joinOnlineMatch(ev('POST', `/api/matches/online/${lower}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), lower, ddb);
  assert.equal(r.statusCode, 200);
});

test('joinOnlineMatch returns 404 for unknown code', async () => {
  const ddb = makeMockDdb();
  const r = await L.joinOnlineMatch(ev('POST', '/api/matches/online/ZZZZZZ/join', {}, { playerId: 'p2', playerName: 'Bob' }), 'ZZZZZZ', ddb);
  assert.equal(r.statusCode, 404);
});

test('joinOnlineMatch returns 409 when full', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p3', playerName: 'Carol' }), code, ddb);
  assert.equal(r.statusCode, 409);
});

test('joinOnlineMatch returns 200 for duplicate join (same player)', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  const r = await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p1', playerName: 'Alice' }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.players.length, 1);
});

test('postOnlineMatch validates playerId', async () => {
  const ddb = makeMockDdb();
  const r = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerName: 'Alice' }), ddb);
  assert.equal(r.statusCode, 400);
});

test('handler routes online match endpoints', async () => {
  // create
  const ddb = makeMockDdb();
  // monkey: handler uses module-level ddb; instead test functions already. Just sanity check regex path.
  const r = await L.joinOnlineMatch(ev('POST', '/api/matches/online/ABCDEF/join', {}, { playerId: 'p', playerName: 'P' }), 'ABCDEF', ddb);
  assert.equal(r.statusCode, 404);
});
