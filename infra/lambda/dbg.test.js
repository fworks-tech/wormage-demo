const test = require('node:test');
const assert = require('node:assert/strict');
const { GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
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
        store.set(keyOf(item), item);
        return {};
      }
      if (cmd instanceof UpdateCommand || (cmd && cmd.constructor && cmd.constructor.name === 'UpdateCommand')) {
        const k = `${input.Key.pk}#${input.Key.sk}`;
        let it = store.get(k);
        if (!it) it = { pk: input.Key.pk, sk: input.Key.sk };
        const vals = input.ExpressionAttributeValues || {};
        const names = input.ExpressionAttributeNames || {};
        const expr = input.UpdateExpression || '';
        const setMatch = expr.match(/SET (.+)/);
        if (setMatch) {
          const parts = setMatch[1].split(',').map((x) => x.trim());
          for (const part of parts) {
            const m = part.match(/^(#?\w+)\s*=\s*(:\w+)$/);
            if (m) {
              const attrName = m[1].startsWith('#') ? (names[m[1]] || m[1].slice(1)) : m[1];
              const val = vals[m[2]];
              if (val !== undefined) it[attrName] = val;
            }
            const la = part.match(/^actions\s*=\s*list_append\(if_not_exists\(actions,\s*(:\w+)\),\s*(:\w+)\)$/);
            if (la) {
              const empty = vals[la[1]];
              const e = vals[la[2]];
              const cur = Array.isArray(it.actions) ? it.actions : (Array.isArray(empty) ? empty : []);
              const toAdd = Array.isArray(e) ? e : [e];
              it.actions = [...cur, ...toAdd];
            }
          }
        }
        store.set(k, it);
        return {};
      }
      throw new Error('Unknown: ' + (cmd && cmd.constructor && cmd.constructor.name));
    },
  };
}

test('dbg', async () => {
  const ddb = makeMockDdb();
  const c = await L.postOnlineMatch({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/matches/online', body: JSON.stringify({ playerId: 'p1', playerName: 'Alice' }) }, ddb);
  const code = JSON.parse(c.body).code;
  await L.joinOnlineMatch({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/matches/online/' + code + '/join', body: JSON.stringify({ playerId: 'p2', playerName: 'Bob' }) }, code, ddb);
  const r1 = await L.submitAction({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/matches/online/' + code + '/action', body: JSON.stringify({ playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'abc' }) }, code, ddb);
  console.log('r1', r1.statusCode);
  console.log('keys', [...ddb.store.keys()]);
  const item = ddb.store.get('ACTION#' + code + '#LOG');
  console.log('action item', JSON.stringify(item));
  const r2 = await L.submitAction({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/matches/online/' + code + '/action', body: JSON.stringify({ playerId: 'p1', action: { type: 'endTurn' }, clientActionId: 'abc' }) }, code, ddb);
  console.log('r2', r2.statusCode, r2.body);
});
