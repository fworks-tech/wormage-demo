'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GetCommand, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
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
