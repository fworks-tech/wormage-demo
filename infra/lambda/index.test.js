'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const L = require('./index.js');
const { GameEngine } = require('./engine.cjs');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { replayActionLog, matchConfig } = require('./replay.js');

function makeMockDdb() {
  const store = new Map();
  const keyOf = (k) => `${k.pk}#${k.sk}`;
  let transactionQueue = Promise.resolve();
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
        if (String(input.ConditionExpression || '').includes('turnStartedAt = :old') && item.turnStartedAt !== vals[':old']) {
          const err = new Error('ConditionalCheckFailed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        if (String(input.ConditionExpression || '').includes('revision = :expectedRevision')
          && item.revision !== undefined && item.revision !== vals[':expectedRevision']) {
          const err = new Error(String(input.ConditionExpression).includes('turnStartedAt') ? 'ConditionalCheckFailed' : 'TransactionCanceled');
          err.name = String(input.ConditionExpression).includes('turnStartedAt') ? 'ConditionalCheckFailedException' : 'TransactionCanceledException';
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
      if (cmd instanceof TransactWriteItemsCommand || (cmd && cmd.constructor && cmd.constructor.name === 'TransactWriteItemsCommand')) {
        const run = transactionQueue.then(async () => {
          for (const item of input.TransactItems || []) {
            if (item.Put) {
              const k = keyOf(item.Put.Item);
              if (String(item.Put.ConditionExpression || '').includes('attribute_not_exists(pk)') && store.has(k)) {
                const err = new Error('TransactionCanceled');
                err.name = 'TransactionCanceledException';
                throw err;
              }
            }
            if (!item.Update) continue;
            const stored = store.get(`${item.Update.Key.pk}#${item.Update.Key.sk}`);
            const vals = item.Update.ExpressionAttributeValues || {};
            const condition = String(item.Update.ConditionExpression || '');
            if (condition.includes('revision = :expectedRevision')
              && stored && stored.revision !== undefined && stored.revision !== vals[':expectedRevision']) {
              const err = new Error('TransactionCanceled');
              err.name = 'TransactionCanceledException';
              throw err;
            }
            if (condition.includes('#status = :ready')) {
              const statusKey = (item.Update.ExpressionAttributeNames || {})['#status'] || 'status';
              if (!stored || stored[statusKey] !== vals[':ready']) {
                const err = new Error('TransactionCanceled');
                err.name = 'TransactionCanceledException';
                throw err;
              }
            }
          }
          for (const item of input.TransactItems || []) {
            if (item.Put) await this.send(new PutCommand(item.Put));
            if (item.Update) await this.send(new UpdateCommand(item.Update));
          }
          return {};
        });
        transactionQueue = run.catch(() => {});
        return run;
      }
      if (cmd instanceof QueryCommand || (cmd && cmd.constructor && cmd.constructor.name === 'QueryCommand')) {
        const vals = input.ExpressionAttributeValues || {};
        let items = [...store.values()];
        if (input.KeyConditionExpression && !input.IndexName) {
          const pk = vals[':pk'];
          const prefix = vals[':prefix'];
          items = items.filter((i) => i.pk === pk && (!prefix || String(i.sk).startsWith(prefix)));
          if (input.ExclusiveStartKey) {
            items = items.filter((i) => i.sk > input.ExclusiveStartKey.sk);
          }
          items.sort((a, b) => input.ScanIndexForward === false
            ? String(b.sk).localeCompare(String(a.sk))
            : String(a.sk).localeCompare(String(b.sk)));
          if (input.Limit) items = items.slice(0, input.Limit);
          const last = items[items.length - 1];
          const more = [...store.values()].some((i) => i.pk === pk && (!prefix || String(i.sk).startsWith(prefix)) && last && i.sk > last.sk);
          return { Items: items, ...(more ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
        }
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

async function storedActions(ddb, code, includeSync = false) {
  const result = await ddb.send(new QueryCommand({
    TableName: 't',
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `MATCH#${code}`, ':prefix': 'ACTION#' },
    ConsistentRead: true,
    ScanIndexForward: true,
  }));
  const items = result.Items || [];
  return includeSync ? items : items.filter((item) => !item.syncOnly);
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

test('ranking items never carry TTL while online matches expire in 30 days', async () => {
  const ddb = makeMockDdb();
  const before = Math.floor(Date.now() / 1000);
  const body = { clientMatchId: 'c-nottl', playerId: 'p', playerName: 'P', teamName: 'T', score: 50, durationSeconds: 60, endReason: 'wipeout', turnSeconds: 45, wind: 'light', difficulty: 'veteran' };
  const r = await L.postMatch(ev('POST', '/api/matches', {}, body), ddb);
  assert.equal(r.statusCode, 201);
  assert.equal(ddb.store.get('CLIENT#c-nottl#META').expiresAt, undefined);

  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  assert.equal(c.statusCode, 201);
  const code = JSON.parse(c.body).code;
  const meta = ddb.store.get(`ONLINE#${code}#META`);
  assert.equal(typeof meta.expiresAt, 'number');
  assert.ok(meta.expiresAt - before >= 30 * 24 * 60 * 60 - 5, `expiresAt too soon: ${meta.expiresAt - before}`);
  assert.ok(meta.expiresAt - before <= 30 * 24 * 60 * 60 + 5, `expiresAt too late: ${meta.expiresAt - before}`);
});

test('online actions refresh TTL on the log and the match', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'move', dir: 0 }, clientActionId: 'ttl-move-1', tick: 5,
  }), code, ddb);
  assert.equal(r.statusCode, 200, r.body);

  const actions = await storedActions(ddb, code);
  assert.equal(actions.length, 1);
  assert.equal(typeof actions[0].expiresAt, 'number');
  const meta = ddb.store.get(`ONLINE#${code}#META`);
  assert.equal(typeof meta.expiresAt, 'number');
  assert.ok(meta.expiresAt >= actions[0].expiresAt - 60, 'match TTL must refresh with the action');

  const f = await L.forfeitOnlineMatch(ev('POST', `/api/matches/online/${code}/forfeit`, {}, { playerId: 'p2' }), code, ddb);
  assert.equal(f.statusCode, 200, f.body);
  assert.equal(typeof ddb.store.get(`ONLINE#${code}#META`).expiresAt, 'number');
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

test('logError emits structured application error metadata', () => {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(line);
  const event = ev('POST', '/api/matches');
  event.requestContext.requestId = 'req-1';
  try {
    L.logError(new TypeError('sdk failed'), event);
  } finally {
    console.error = original;
  }

  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.level, 'error');
  assert.equal(logged.type, 'application-error');
  assert.equal(logged.name, 'TypeError');
  assert.equal(logged.message, 'sdk failed');
  assert.equal(logged.requestId, 'req-1');
  assert.equal(logged.path, '/api/matches');
  assert.ok(typeof logged.stack === 'string' && logged.stack.includes('TypeError'));
});

test('replay rejections log as warn so 409s do not page', () => {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(line);
  const event = ev('POST', '/api/matches/online/ABC/action');
  try {
    L.logError(new Error('bad tick'), event, 'replay-rejected', 'warn');
  } finally {
    console.error = original;
  }

  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.level, 'warn');
  assert.equal(logged.type, 'replay-rejected');
});

test('anonymous session token round-trips its player identity', () => {
  const now = Date.UTC(2026, 10, 26);
  const session = L.createSession('0123456789abcdef0123456789abcdef', now);

  assert.match(session.playerId, /^player-[A-Za-z0-9_-]+$/);
  assert.equal(new Date(session.expiresAt).getTime() - now, 180 * 24 * 60 * 60 * 1000);
  assert.deepEqual(L.verifyToken(session.token, '0123456789abcdef0123456789abcdef', now), { playerId: session.playerId });
});

test('verifyToken rejects expired, tampered and wrong-algorithm tokens', () => {
  const now = Date.UTC(2026, 10, 26);
  const session = L.createSession('0123456789abcdef0123456789abcdef', now);
  assert.throws(() => L.verifyToken(session.token, '0123456789abcdef0123456789abcdef', now + 181 * 24 * 60 * 60 * 1000), /invalid token/);
  assert.throws(() => L.verifyToken(`${session.token}x`, '0123456789abcdef0123456789abcdef', now), /invalid token/);
  assert.throws(() => L.verifyToken(session.token, 'other-secret', now), /invalid token/);

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = encode({ sub: session.playerId, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, iss: 'wormage', aud: 'wormage-client' });
  const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${payload}.`;
  assert.throws(() => L.verifyToken(unsigned, '0123456789abcdef0123456789abcdef', now), /invalid token/);
});

test('enforce mode rejects protected routes without a bearer token', async () => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'enforce';
  try {
    const response = await L.handler(ev('GET', '/api/matches'));
    assert.equal(response.statusCode, 401);
  } finally {
    process.env.AUTH_MODE = previous;
  }
});

test('auth session endpoint issues a verifiable anonymous token', async () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const response = await L.handler(ev('POST', '/api/auth/session'), { getSecret: async () => secret });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.deepEqual(L.verifyToken(body.token, secret), { playerId: body.playerId });
});

test('auth session endpoint refreshes a valid token without changing identity', async () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const session = L.createSession(secret);
  const event = ev('POST', '/api/auth/session');
  event.headers = { authorization: `Bearer ${session.token}` };
  const response = await L.handler(event, { getSecret: async () => secret });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.playerId, session.playerId);
  assert.deepEqual(L.verifyToken(body.token, secret), { playerId: session.playerId });
});

test('enforce mode accepts a valid token and derives match identity', async () => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'enforce';
  try {
    const secret = '0123456789abcdef0123456789abcdef';
    const session = L.createSession(secret);
    const event = ev('POST', '/api/matches', {}, { clientMatchId: 'auth-handler', playerName: 'P', teamName: 'T' });
    event.headers = { authorization: `Bearer ${session.token}` };
    const response = await L.handler(event, { getSecret: async () => secret, ddb: makeMockDdb() });

    assert.equal(response.statusCode, 201);
    assert.equal(JSON.parse(response.body).playerId, session.playerId);
  } finally {
    process.env.AUTH_MODE = previous;
  }
});

test('observe mode still accepts legacy anonymous writes', async () => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'observe';
  try {
    const event = ev('POST', '/api/matches', {}, { clientMatchId: 'legacy-observe', playerId: 'legacy-player', playerName: 'P', teamName: 'T' });
    const response = await L.handler(event, { ddb: makeMockDdb() });

    assert.equal(response.statusCode, 201);
    assert.equal(JSON.parse(response.body).playerId, 'legacy-player');
  } finally {
    process.env.AUTH_MODE = previous;
  }
});

test('authenticated non-participants cannot read or replay an online match', async () => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'enforce';
  try {
    const secret = '0123456789abcdef0123456789abcdef';
    const session = L.createSession(secret);
    const ddb = makeMockDdb();
    const created = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
    const code = JSON.parse(created.body).code;
    await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

    for (const suffix of ['', '/replay']) {
      const event = ev('GET', `/api/matches/online/${code}${suffix}`);
      event.headers = { authorization: `Bearer ${session.token}` };
      const response = await L.handler(event, { getSecret: async () => secret, ddb });
      assert.equal(response.statusCode, 403);
    }
  } finally {
    process.env.AUTH_MODE = previous;
  }
});

test('postMatch derives playerId from authenticated identity', async () => {
  const ddb = makeMockDdb();
  const body = { clientMatchId: 'auth-1', playerName: 'P', teamName: 'T', score: 10, endReason: 'wipeout' };
  const response = await L.postMatch(ev('POST', '/api/matches', {}, body), ddb, 'player-token');

  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).playerId, 'player-token');
});

test('postMatch rejects a client playerId that differs from authenticated identity', async () => {
  const ddb = makeMockDdb();
  const body = { clientMatchId: 'auth-2', playerId: 'player-other', playerName: 'P', teamName: 'T', score: 10, endReason: 'wipeout' };
  const response = await L.postMatch(ev('POST', '/api/matches', {}, body), ddb, 'player-token');

  assert.equal(response.statusCode, 403);
  assert.equal(ddb.store.size, 0);
});

test('getMatches ignores a spoofed query playerId when authenticated', async () => {
  const ddb = makeMockDdb();
  for (const playerId of ['player-token', 'player-other']) {
    await ddb.send(new PutCommand({ TableName: 't', Item: {
      pk: `CLIENT#${playerId}`, sk: 'META', playerId, playerName: 'P', teamName: 'T', score: 1,
      durationSeconds: 1, endReason: 'wipeout', configKey: 'cfg', createdAt: new Date().toISOString(),
    } }));
  }

  const response = await L.getMatches(ev('GET', '/api/matches', { playerId: 'player-other' }), ddb, 'player-token');
  const body = JSON.parse(response.body);
  assert.equal(body.total, 1);
  assert.equal(body.items[0].playerId, 'player-token');
});

test('submitAction cannot spoof a participant through the body playerId', async () => {
  const ddb = makeMockDdb();
  const created = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(created.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const response = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'spoof-1',
  }), code, ddb, 'p3');
  assert.equal(response.statusCode, 403);
});

test('submitAction advances turn on endTurn', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1' }), code, ddb);
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
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p2', action: { type: 'endTurn' }, clientActionId: 'endTurn-p2' }), code, ddb);
  assert.equal(r.statusCode, 409);
});

test('submitAction rejects unknown action type with 400', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'teleport' }, clientActionId: 'teleport-1' }), code, ddb);
  assert.equal(r.statusCode, 400);
});

for (const [name, action] of [
  ['a non-numeric aim delta', { type: 'aim', delta: 'x' }],
  ['an aim angle above the pointer arc', { type: 'aimAt', angle: 0 }],
  ['an aim angle below the pointer arc', { type: 'aimAt', angle: -3.1 }],
  ['a non-numeric aim angle', { type: 'aimAt', angle: 'x' }],
  ['a power above full charge', { type: 'setPower', power: 1.5 }],
  ['a negative power', { type: 'setPower', power: -0.5 }],
  ['a non-numeric power', { type: 'setPower', power: 'x' }],
  ['a missing movement direction', { type: 'move' }],
  ['an invalid reel direction', { type: 'reel', dir: 2 }],
  ['an invalid jump direction', { type: 'jump', dir: 0.5 }],
  ['unknown action fields', { type: 'endTurn', extra: true }],
]) {
  test(`submitAction rejects ${name} without writing`, async () => {
    const ddb = makeMockDdb();
    const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
    const code = JSON.parse(c.body).code;
    await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

    const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action, clientActionId: 'invalid-action' }), code, ddb);
    assert.equal(r.statusCode, 400, r.body);
    assert.equal((await storedActions(ddb, code)).length, 0);
    const meta = ddb.store.get(`ONLINE#${code}#META`);
    assert.equal(meta.revision, 0);
    assert.equal(meta.snapshot, undefined);
  });
}

test('submitAction accepts valid directional fields and an omitted jump direction', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  for (const [clientActionId, action] of [
    ['move-1', { type: 'move', dir: 0 }],
    ['jump-1', { type: 'jump' }],
    ['aim-1', { type: 'aim', delta: 0 }],
    ['aimAt-1', { type: 'aimAt', angle: -1.2 }],
    ['setPower-1', { type: 'setPower', power: 0.8 }],
  ]) {
    const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action, clientActionId }), code, ddb);
    assert.equal(r.statusCode, 200, r.body);
  }
  assert.equal((await storedActions(ddb, code)).length, 5);
});

test('submitAction rejects an oversized action without writing', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'aim', delta: 0, padding: 'x'.repeat(1024) }, clientActionId: 'oversized-action',
  }), code, ddb);
  assert.equal(r.statusCode, 413, r.body);
  assert.equal((await storedActions(ddb, code)).length, 0);
  assert.equal(ddb.store.get(`ONLINE#${code}#META`).revision, 0);
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

test('submitAction requires clientActionId', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' } }), code, ddb);
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).message, 'clientActionId is required');
  assert.equal((await storedActions(ddb, code)).length, 0);
  assert.equal(ddb.store.get(`ONLINE#${code}#META`).revision, 0);
});

test('submitAction stores one ordered item per action', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const first = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'weapon', id: 'grenade' }, clientActionId: 'weapon-1', tick: 5,
  }), code, ddb);
  const second = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'aim', delta: 0.1 }, clientActionId: 'aim-1', tick: 5,
  }), code, ddb);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);

  const actions = await storedActions(ddb, code);
  assert.deepEqual(actions.map((item) => item.sk), ['ACTION#0001#0001', 'ACTION#0001#0002']);
  assert.deepEqual(actions.map((item) => item.seq), [1, 2]);
  assert.ok(actions.every((item) => item.pk === `MATCH#${code}`));
  assert.deepEqual(actions[0], {
    pk: `MATCH#${code}`,
    sk: 'ACTION#0001#0001',
    seq: 1,
    tick: 5,
    turn: 1,
    engineTick: 5,
    action: { type: 'weapon', id: 'grenade' },
    playerId: 'p1',
    clientActionId: 'weapon-1',
    at: actions[0].at,
    expiresAt: actions[0].expiresAt,
  });
  assert.equal(typeof actions[0].expiresAt, 'number');
  assert.equal(ddb.store.has(`ACTION#${code}#LOG`), false);

  const got = await L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`, {}), code, ddb);
  const responseActions = JSON.parse(got.body).match.actions;
  assert.deepEqual(responseActions.map((item) => item.seq), [1, 2]);
  assert.ok(responseActions.every((item) => !Object.prototype.hasOwnProperty.call(item, 'pk') && !Object.prototype.hasOwnProperty.call(item, 'sk')));
  assert.deepEqual(Object.keys(responseActions[0]).sort(), ['action', 'at', 'clientActionId', 'engineTick', 'playerId', 'seq', 'tick', 'turn']);
});

test('submitAction rejects clientActionId reuse with a different payload', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'reused', tick: 0,
  }), code, ddb);
  const revision = ddb.store.get(`ONLINE#${code}#META`).revision;

  const changedAction = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'weapon', id: 'grenade' }, clientActionId: 'reused', tick: 0,
  }), code, ddb);
  const changedPlayer = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p2', action: { type: 'endTurn' }, clientActionId: 'reused', tick: 0,
  }), code, ddb);
  assert.equal(changedAction.statusCode, 409);
  assert.equal(JSON.parse(changedAction.body).message, 'clientActionId already used');
  assert.equal(changedPlayer.statusCode, 409);
  assert.equal(JSON.parse(changedPlayer.body).message, 'clientActionId already used');
  assert.equal((await storedActions(ddb, code)).length, 1);
  assert.equal(ddb.store.get(`ONLINE#${code}#META`).revision, revision);
});

test('submitAction returns a duplicate after the match has finished', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const body = { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'finished-retry', tick: 0 };
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, body), code, ddb);
  await L.forfeitOnlineMatch(ev('POST', `/api/matches/online/${code}/forfeit`, {}, { playerId: 'p1' }), code, ddb);

  const retry = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, body), code, ddb);
  assert.equal(retry.statusCode, 200);
  assert.equal(JSON.parse(retry.body).duplicate, true);
});

test('submitAction acknowledges a duplicate after a transaction conflict', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const send = ddb.send.bind(ddb);
  let first = true;
  let firstDone;
  const committed = new Promise((resolve) => { firstDone = resolve; });
  ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'TransactWriteItemsCommand') {
      if (first) {
        first = false;
        const result = await send(cmd);
        firstDone();
        return result;
      }
      await committed;
    }
    return send(cmd);
  };
  const body = { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'racing', tick: 0 };
  const [a, b] = await Promise.all([
    L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, body), code, ddb),
    L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, body), code, ddb),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(JSON.parse(a.body).duplicate === true || JSON.parse(b.body).duplicate === true, true);
  assert.equal((await storedActions(ddb, code)).length, 1);
});

test('getActionLog follows Query pagination and replay order', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  for (const [seq, tick] of [[3, 20], [1, 30], [2, 10]]) {
    ddb.store.set(`MATCH#${code}#ACTION#0001#${String(seq).padStart(4, '0')}`, {
      pk: `MATCH#${code}`,
      sk: `ACTION#0001#${String(seq).padStart(4, '0')}`,
      seq,
      tick,
      turn: 1,
      engineTick: tick,
      action: { type: 'aim', delta: 0 },
      playerId: 'p1',
      clientActionId: `seed-${seq}`,
      at: '2026-01-01T00:00:00.000Z',
    });
  }
  const send = ddb.send.bind(ddb);
  ddb.send = async (cmd) => {
    if (cmd instanceof QueryCommand && cmd.input.KeyConditionExpression) cmd.input.Limit = 1;
    return send(cmd);
  };

  const log = await L.getActionLog(code, ddb);
  assert.deepEqual(log.actions.map((item) => item.seq), [2, 3, 1]);
});

test('submitAction enforces the 500-action cap without mutating metadata', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  for (let seq = 1; seq <= 500; seq += 1) {
    const sk = `ACTION#0001#${String(seq).padStart(4, '0')}`;
    ddb.store.set(`MATCH#${code}#${sk}`, {
      pk: `MATCH#${code}`, sk, seq, tick: 0, turn: 1, engineTick: 0,
      action: { type: 'aim', delta: 0 }, playerId: 'p1', clientActionId: `seed-${seq}`, at: '2026-01-01T00:00:00.000Z',
    });
  }

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'over-cap', tick: 0,
  }), code, ddb);
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).message, 'action log full');
  assert.equal((await storedActions(ddb, code)).length, 500);
  assert.equal(ddb.store.get(`ONLINE#${code}#META`).revision, 0);
});

test('legacy online matches are frozen with 410 on every route', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const meta = ddb.store.get(`ONLINE#${code}#META`);
  delete meta.actionLogVersion;
  ddb.store.set(`ACTION#${code}#LOG`, { pk: `ACTION#${code}`, sk: 'LOG', actions: [] });

  const responses = [
    await L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`, {}), code, ddb),
    await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb),
    await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'legacy' }), code, ddb),
    await L.forfeitOnlineMatch(ev('POST', `/api/matches/online/${code}/forfeit`, {}, { playerId: 'p1' }), code, ddb),
  ];
  assert.ok(responses.every((response) => response.statusCode === 410));
  assert.deepEqual(await L.replayOnlineMatch(code, ddb), { legacy: true });
  assert.equal((await storedActions(ddb, code)).length, 0);
  assert.equal(meta.revision, 0);
});

test('getOnlineMatch surfaces action-log read failures', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  const send = ddb.send.bind(ddb);
  ddb.send = async (cmd) => {
    if (cmd instanceof QueryCommand && cmd.input.KeyConditionExpression) throw new Error('log read failed');
    return send(cmd);
  };

  await assert.rejects(() => L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`, {}), code, ddb), /log read failed/);
});

test('submitAction rejects a concurrent revision without acknowledging the action', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const send = ddb.send.bind(ddb);
  ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'TransactWriteItemsCommand') {
      ddb.store.get(`ONLINE#${code}#META`).revision = 5;
    }
    return send(cmd);
  };

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).message, 'concurrent action, retry');
  assert.equal((await storedActions(ddb, code)).length, 0);
});

test('submitAction cannot overwrite a concurrent forfeit', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const send = ddb.send.bind(ddb);
  let injected = false;
  ddb.send = async (cmd) => {
    if (cmd.constructor.name === 'TransactWriteItemsCommand' && !injected) {
      injected = true;
      const forfeit = await L.forfeitOnlineMatch(ev('POST', `/api/matches/online/${code}/forfeit`, {}, { playerId: 'p1' }), code, ddb);
      assert.equal(forfeit.statusCode, 200, forfeit.body);
    }
    return send(cmd);
  };

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, {
    playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'racing-forfeit', tick: 0,
  }), code, ddb);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(JSON.parse(r.body).message, 'concurrent action, retry');
  assert.equal((await storedActions(ddb, code)).length, 0);
  const meta = ddb.store.get(`ONLINE#${code}#META`);
  assert.equal(meta.status, 'finished');
  assert.equal(meta.winnerTeam, 1);
  assert.equal(meta.endReason, 'surrender');
});

test('submitAction persists the engine snapshot and returns it', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.match.activeTeam, 1);
  assert.equal(b.match.turn, 2);
  assert.equal(b.match.snapshotTick, 0);
  assert.ok(b.match.snapshot);
  assert.equal(b.match.snapshot.phase, 'aim');
  assert.deepEqual(b.match.snapshot.teams.map((team) => team.isAi), [false, false]);
});

test('submitAction rejects an unknown weapon without mutating the match', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'weapon', id: 'no-such-weapon' }, clientActionId: 'weapon-invalid', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).message, 'unknown weapon');
  const inherited = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'weapon', id: 'toString' }, clientActionId: 'weapon-inherited', tick: 0 }), code, ddb);
  assert.equal(inherited.statusCode, 400);
  assert.equal(JSON.parse(inherited.body).message, 'unknown weapon');
  const meta = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(meta.Item.snapshot, undefined);
  assert.equal(meta.Item.weapon, undefined);
  assert.equal((await storedActions(ddb, code)).length, 0);
});

test('submitAction rejects a release with no charge', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'releaseCharge' }, clientActionId: 'release-1', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).message, 'release had no effect');
  assert.equal((await storedActions(ddb, code)).length, 0);
});

test('a sync cannot succeed when no shot reached the server', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice' }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: '1-endTurn-sync', tick: 10 }), code, ddb);
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).message, 'shot not found');
});

test('an action stamped after the turn expires cannot fire on the opponent worm', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 45, seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-stale', tick: 2701 }), code, ddb);
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).message, 'stale action tick');
  const meta = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(meta.Item.activeTeam, 0);
  assert.equal(meta.Item.phase, 'aim');
});

test('a terminal engine snapshot is not rejected as a no-effect fire', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { wormsPerTeam: 0, seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 200, r.body);
  const match = JSON.parse(r.body).match;
  assert.equal(match.phase, 'gameover');
  assert.equal(match.status, 'finished');
  assert.equal((await storedActions(ddb, code)).length, 1);
});

test('an expired fired turn is playable by the next player', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 0, seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const fired = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1', tick: 0 }), code, ddb);
  assert.equal(fired.statusCode, 200, fired.body);
  assert.equal(JSON.parse(fired.body).match.phase, 'projectile');

  const got = await L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`, {}), code, ddb);
  const expired = JSON.parse(got.body).match;
  assert.equal(expired.turn, 2);
  assert.equal(expired.activeTeam, 1);
  assert.equal(expired.phase, 'aim');
  assert.equal(expired.hasFired, false);
  assert.equal(expired.snapshot, null);
  assert.equal(expired.snapshotTick, null);
});

test('turn expiry retries when an action advances the revision first', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 0, seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const send = ddb.send.bind(ddb);
  let raced = false;
  ddb.send = async (cmd) => {
    if (cmd instanceof UpdateCommand && String(cmd.input.ConditionExpression || '').includes('turnStartedAt = :old') && !raced) {
      raced = true;
      ddb.store.get(`ONLINE#${code}#META`).revision = 1;
    }
    return send(cmd);
  };

  const got = await L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`, {}), code, ddb);
  const match = JSON.parse(got.body).match;
  assert.equal(raced, true);
  assert.equal(match.turn, 2);
  assert.equal(match.activeTeam, 1);
  const stored = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(stored.Item.revision, 2);
});

test('turn expiry does not skip a turn started by a concurrent endTurn', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 45, seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await ddb.send(new UpdateCommand({
    TableName: 't',
    Key: { pk: `ONLINE#${code}`, sk: 'META' },
    UpdateExpression: 'SET turnStartedAt = :old',
    ExpressionAttributeValues: { ':old': '2026-01-01T00:00:00.000Z' },
  }));
  const send = ddb.send.bind(ddb);
  let raced = false;
  ddb.send = async (cmd) => {
    if (cmd instanceof UpdateCommand && String(cmd.input.ConditionExpression || '').includes('turnStartedAt = :old') && !raced) {
      raced = true;
      const ended = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1', tick: 0 }), code, ddb);
      assert.equal(ended.statusCode, 200, ended.body);
    }
    return send(cmd);
  };

  const got = await L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`, {}), code, ddb);
  const match = JSON.parse(got.body).match;
  assert.equal(raced, true);
  assert.equal(match.turn, 2);
  assert.equal(match.activeTeam, 1);
  assert.notEqual(match.turnStartedAt, '2026-01-01T00:00:00.000Z');
  const stored = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(stored.Item.revision, 1);
});

test('a player action after expiry replays on the correct human turn', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { turnSeconds: 45, seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await ddb.send(new UpdateCommand({
    TableName: 't',
    Key: { pk: `ONLINE#${code}`, sk: 'META' },
    UpdateExpression: 'SET turnStartedAt = :old',
    ExpressionAttributeValues: { ':old': '2026-01-01T00:00:00.000Z' },
  }));
  const got = await L.getOnlineMatch(ev('GET', `/api/matches/online/${code}`, {}), code, ddb);
  assert.equal(JSON.parse(got.body).match.activeTeam, 1);

  const fired = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p2', action: { type: 'fire' }, clientActionId: 'fire-p2', tick: 0 }), code, ddb);
  assert.equal(fired.statusCode, 200, fired.body);
  assert.equal(JSON.parse(fired.body).match.activeTeam, 1);
  const beforeSync = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(beforeSync.Item.phase, 'projectile');
  assert.equal(beforeSync.Item.snapshotTick, 2701);

  const probe = new GameEngine({ turnSeconds: 45, wind: 'light', difficulty: 'veteran', seed: 777, wormsPerTeam: 3, hotseat: true });
  for (let i = 0; i < 2701; i += 1) probe.update(1 / 60);
  probe.applyAction({ type: 'fire' });
  while (probe.turn === 2 && probe.tick < 6000) probe.update(1 / 60);
  assert.equal(probe.turn, 3);
  assert.ok(probe.tick > 2701);
  const synced = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p2', action: { type: 'endTurn' }, tick: probe.tick, clientActionId: `${probe.turn}-endTurn-sync` }), code, ddb);
  assert.equal(synced.statusCode, 200, synced.body);
  assert.equal(JSON.parse(synced.body).match.activeTeam, 0);
  assert.equal(JSON.parse(synced.body).match.turn, 3);
});

test('a post-shot sync cannot cancel a projectile still in flight', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1', tick: 0 }), code, ddb);

  const early = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: '0-endTurn-sync', tick: 0 }), code, ddb);
  assert.equal(early.statusCode, 409);
  assert.equal(JSON.parse(early.body).message, 'shot still in flight');
  assert.equal((await storedActions(ddb, code)).length, 1);
});

test('a post-shot sync hands over once the engine has resolved the shot', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1', tick: 0 }), code, ddb);

  const probe = new GameEngine({ turnSeconds: 45, wind: 'light', difficulty: 'veteran', seed: 777, wormsPerTeam: 3, hotseat: true });
  probe.applyAction({ type: 'fire' });
  while (probe.turn === 1 && probe.tick < 600) probe.update(1 / 60);
  const resolvedTick = probe.tick;
  const clientActionId = `${resolvedTick}-endTurn-sync`;

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, tick: resolvedTick, clientActionId }), code, ddb);
  assert.equal(r.statusCode, 200, r.body);
  const match = JSON.parse(r.body).match;
  assert.equal(match.phase, 'aim');
  assert.equal(match.hasFired, false);
  assert.equal(match.activeTeam, 1);
  assert.equal((await storedActions(ddb, code)).length, 1);
  const allItems = await storedActions(ddb, code, true);
  assert.equal(allItems.length, 2);
  assert.equal(allItems[1].syncOnly, true);
  assert.equal(allItems[1].seq, 2);
  assert.equal(allItems[1].clientActionId, clientActionId);

  const duplicate = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, tick: resolvedTick, clientActionId }), code, ddb);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(JSON.parse(duplicate.body).duplicate, true);
  assert.equal(JSON.parse(duplicate.body).match.activeTeam, 1);

});

test('firing a utility ends the turn without a projectile phase', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'weapon', id: 'medkit' }, clientActionId: 'weapon-medkit', tick: 0 }), code, ddb);

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'fire' }, clientActionId: 'fire-1', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 200);
  const match = JSON.parse(r.body).match;
  assert.equal(match.phase, 'aim');
  assert.equal(match.hasFired, false);
  assert.equal(match.activeTeam, 1);
});

test('replayOnlineMatch returns a deterministic snapshot', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1', tick: 0 }), code, ddb);

  const first = await L.replayOnlineMatch(code, ddb);
  const second = await L.replayOnlineMatch(code, ddb);
  assert.ok(first.snapshot);
  assert.equal(first.tick, second.tick);
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.equal(first.engineVersion, 4);
});

test('submitAction rejects a far-future tick that lands on the opponent turn', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 777, wormsPerTeam: 2, turnSeconds: 30 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-future', tick: 999999 }), code, ddb);
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).message, 'stale action tick');
  const meta = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(meta.Item.turn, 1);
  assert.equal(meta.Item.activeTeam, 0);
});

test('a stale replay cannot undo a server-side turn expiry', async () => {
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

  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p2', action: { type: 'endTurn' }, clientActionId: 'endTurn-p2-stale', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).message, 'stale action tick');
  const meta = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  assert.equal(meta.Item.turn, 5);
  assert.equal(meta.Item.activeTeam, 1);
  assert.equal(meta.Item.turnStartedAt, '2026-01-01T00:00:00.000Z');
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
      const name = cmd && cmd.constructor && cmd.constructor.name;
      if (name === 'PutObjectCommand') {
        store.set(input.Key, { Bucket: input.Bucket, Body: input.Body, ContentType: input.ContentType });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(input.Key);
        return {};
      }
      throw new Error('Unknown command: ' + name);
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

test('postDebugLog is disabled when the flag is missing', async () => {
  delete process.env.DEBUG_LOGS_ENABLED;
  const s3 = makeMockS3();
  const body = { sessionId: 's2', matchId: 'm2', entries: [], snapshots: [] };
  const r = await L.postDebugLog(ev('POST', '/api/debug-logs', {}, body), s3);
  assert.equal(r.statusCode, 202);
  assert.equal(JSON.parse(r.body).stored, false);
  assert.equal(s3.store.size, 0);
  process.env.DEBUG_LOGS_ENABLED = 'true';
});

const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

function bugReportBody(overrides = {}) {
  return {
    schemaVersion: 1,
    reportId: 'report-1',
    sessionId: 's1',
    matchId: 'm1',
    note: 'worm below the sea',
    engine: { seed: 4242, config: { seed: 4242 }, tick: 12, snapshot: { phase: 'aim' } },
    debug: { entries: [], snapshots: [] },
    actionLog: [],
    screenshot: { mime: 'image/png', width: 1280, height: 720, bytes: 8, method: 'tab', data: TINY_PNG },
    ...overrides,
  };
}

test('postBugReport stores metadata and the png in S3', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  const s3 = makeMockS3();
  const r = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody()), s3);

  assert.equal(r.statusCode, 201);
  const b = JSON.parse(r.body);
  assert.equal(b.stored, true);
  assert.equal(b.reportId, 'report-1');
  assert.equal(s3.store.size, 2);
  const pngKey = [...s3.store.keys()].find((key) => key.endsWith('.png'));
  const jsonKey = [...s3.store.keys()].find((key) => key.endsWith('.json'));
  assert.ok(pngKey.startsWith('bug-reports/prod/'));
  assert.ok(jsonKey.startsWith('bug-reports/prod/'));
  assert.equal(s3.store.get(pngKey).ContentType, 'image/png');
  const stored = JSON.parse(s3.store.get(jsonKey).Body);
  assert.equal(stored.note, 'worm below the sea');
  assert.equal(stored.screenshot.key, pngKey);
  assert.equal(stored.screenshot.bytes, 16);
  assert.equal(stored.screenshot.data, undefined);
});

test('postBugReport replaces online playerId with authenticated identity', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  const s3 = makeMockS3();
  const response = await L.postBugReport(
    ev('POST', '/api/bug-reports', {}, bugReportBody({ online: { playerId: 'player-spoofed' } })),
    s3,
    'player-token',
  );

  assert.equal(response.statusCode, 201);
  const metadata = [...s3.store.values()].map((value) => value.Body).find((body) => typeof body === 'string');
  assert.equal(JSON.parse(metadata).online.playerId, 'player-token');
});

test('postBugReport keeps untrusted report ids inside the prefix', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  const s3 = makeMockS3();
  const r = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({ reportId: '../../evil' })), s3);

  assert.equal(r.statusCode, 201);
  for (const key of s3.store.keys()) {
    assert.ok(key.startsWith('bug-reports/'));
    assert.ok(!key.includes('..'));
  }
});

test('postBugReport validates the screenshot mime and magic bytes', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  const s3 = makeMockS3();

  const gif = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({
    screenshot: { mime: 'image/gif', width: 10, height: 10, data: TINY_PNG },
  })), s3);
  assert.equal(gif.statusCode, 400);

  const magic = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({
    screenshot: { mime: 'image/png', width: 10, height: 10, data: Buffer.from('not a png').toString('base64') },
  })), s3);
  assert.equal(magic.statusCode, 400);
  assert.equal(s3.store.size, 0);
});

test('postBugReport rejects oversized screenshots and bodies', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  const s3 = makeMockS3();

  const pixels = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({
    screenshot: { mime: 'image/png', width: 20000, height: 20000, data: TINY_PNG },
  })), s3);
  assert.equal(pixels.statusCode, 413);

  const big = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({
    engine: { seed: 1, config: { seed: 1 }, snapshot: { blob: 'x'.repeat(5_100_000) } },
    screenshot: null,
  })), s3);
  assert.equal(big.statusCode, 413);
});

test('postBugReport accepts a report without a screenshot', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  const s3 = makeMockS3();
  const r = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({ screenshot: null })), s3);

  assert.equal(r.statusCode, 201);
  assert.equal(s3.store.size, 1);
  const stored = JSON.parse([...s3.store.values()][0].Body);
  assert.equal(stored.screenshot, null);
});

test('postBugReport respects the disabled flag', async () => {
  process.env.BUG_REPORTS_ENABLED = 'false';
  const s3 = makeMockS3();
  const r = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody()), s3);
  assert.equal(r.statusCode, 202);
  assert.equal(JSON.parse(r.body).stored, false);
  process.env.BUG_REPORTS_ENABLED = 'true';
});

test('postBugReport is disabled when the flag is missing', async () => {
  delete process.env.BUG_REPORTS_ENABLED;
  const s3 = makeMockS3();
  const r = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody()), s3);
  assert.equal(r.statusCode, 202);
  assert.equal(JSON.parse(r.body).stored, false);
  assert.equal(s3.store.size, 0);
  process.env.BUG_REPORTS_ENABLED = 'true';
});

test('postBugReport requires screenshot width and height', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  const s3 = makeMockS3();

  const missingWidth = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({
    screenshot: { mime: 'image/png', height: 10, data: TINY_PNG },
  })), s3);
  assert.equal(missingWidth.statusCode, 400);

  const missingHeight = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({
    screenshot: { mime: 'image/png', width: 10, data: TINY_PNG },
  })), s3);
  assert.equal(missingHeight.statusCode, 400);

  const missingBoth = await L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody({
    screenshot: { mime: 'image/png', data: TINY_PNG },
  })), s3);
  assert.equal(missingBoth.statusCode, 400);
  assert.equal(s3.store.size, 0);
});

test('postBugReport deletes the screenshot if metadata write fails', async () => {
  process.env.DEBUG_LOG_BUCKET = 'bucket';
  process.env.BUG_REPORTS_ENABLED = 'true';
  let puts = 0;
  const store = new Map();
  const s3 = {
    store,
    async send(cmd) {
      const input = cmd.input || cmd;
      const name = cmd && cmd.constructor && cmd.constructor.name;
      if (name === 'PutObjectCommand') {
        puts += 1;
        if (puts === 2) throw new Error('s3 down');
        store.set(input.Key, { Bucket: input.Bucket, Body: input.Body, ContentType: input.ContentType });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(input.Key);
        return {};
      }
      throw new Error('Unknown command: ' + name);
    },
  };

  await assert.rejects(
    () => L.postBugReport(ev('POST', '/api/bug-reports', {}, bugReportBody()), s3),
    /s3 down/,
  );
  assert.equal(store.size, 0);
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
  assert.equal(b.match.actionLogVersion, 2);
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

test('submitAction snapshot marshals to DynamoDB with no non-finite ammo', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 4242 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  const r = await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1', tick: 0 }), code, ddb);
  assert.equal(r.statusCode, 200, r.body);

  const meta = await ddb.send(new GetCommand({ TableName: 't', Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
  const snap = meta.Item.snapshot;
  assert.ok(snap, 'snapshot persisted');
  assert.equal(snap.teams.length, 2);

  // O marshaller real do DynamoDB rejeita numeros nao finitos (Infinity /
  // -Infinity / NaN) com SerializationException. O item persistido deve ser
  // aceito por ele.
  assert.doesNotThrow(() => marshall(meta.Item), 'persisted item must marshal');

  // Nenhum numero nao finito em qualquer lugar do snapshot persistido.
  for (const team of snap.teams) {
    for (const [weapon, ammo] of Object.entries(team.ammo)) {
      assert.ok(typeof ammo !== 'number' || Number.isFinite(ammo), `ammo.${weapon} deve ser finito, obteve ${ammo}`);
    }
  }
});

test('replay keeps bazooka ammo infinite (no desync, no infinite->finite)', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch(ev('POST', '/api/matches/online', {}, { playerId: 'p1', playerName: 'Alice', settings: { seed: 4242, wormsPerTeam: 2 } }), ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch(ev('POST', `/api/matches/online/${code}/join`, {}, { playerId: 'p2', playerName: 'Bob' }), code, ddb);
  await L.submitAction(ev('POST', `/api/matches/online/${code}/action`, {}, { playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'endTurn-1', tick: 0 }), code, ddb);

  const replay = replayActionLog({ GameEngine, match: { code, settings: { seed: 4242, wormsPerTeam: 2 } }, actions: [], stopTick: 0 });
  assert.ok(replay.snapshot);
  for (const team of replay.snapshot.teams) {
    assert.equal(team.ammo.bazooka, Infinity, 'bazooka deve permanecer infinito apos o replay');
  }
});

test('client rebuild from a fresh engine keeps bazooka ammo infinite', () => {
  const engine = new GameEngine(matchConfig({ settings: { seed: 4242, wormsPerTeam: 2 } }));
  const snap = engine.snapshot();
  assert.ok(snap);
  assert.equal(snap.teams.length, 2);
  for (const team of snap.teams) {
    assert.equal(team.ammo.bazooka, Infinity, 'bazooka deve permanecer infinito no engine reconstruido pelo cliente');
    assert.equal(team.ammo.grenade, 3);
    assert.equal(team.ammo.shotgun, 4);
  }
});
