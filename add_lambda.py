import re

p = 'infra/lambda/index.js'
s = open(p).read()

anchor = "exports.handler = async (event) => {"

funcs = r'''
const ACTION_CAP = 500;

async function getActionLog(code, ddbClient) {
  const got = await ddbClient.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ACTION#' + code, sk: 'LOG' } }));
  return got.Item || { pk: 'ACTION#' + code, sk: 'LOG', actions: [] };
}

async function submitAction(event, rawCode, ddbClient) {
  if (!ddbClient) ddbClient = ddb;
  const code = String(rawCode || '').toUpperCase().trim();
  const body = parseBody(event);
  if (!isStr(body.playerId)) return json(400, { message: 'playerId is required' });
  if (!body.action || typeof body.action !== 'object' || Array.isArray(body.action)) return json(400, { message: 'action is required' });
  const action = body.action;
  if (!isStr(action.type)) return json(400, { message: 'action.type is required' });

  const got = await ddbClient.send(new GetCommand({ TableName: TABLE, Key: { pk: 'ONLINE#' + code, sk: 'META' } }));
  if (!got.Item) return json(404, { message: 'match not found' });
  const match = got.Item;

  if (match.status !== 'ready') return json(409, { message: 'match not ready' });
  if (match.winnerTeam != null) return json(409, { message: 'match finished' });

  const players = Array.isArray(match.players) ? match.players : [];
  if (!players.some((p) => p && p.playerId === body.playerId)) return json(403, { message: 'not a participant' });
  if (players[match.activeTeam] && players[match.activeTeam].playerId !== body.playerId) return json(409, { message: 'not your turn' });

  const phase = match.phase || 'aim';
  const type = action.type;
  if (phase === 'gameover') return json(409, { message: 'match finished' });
  const aimOnly = ['move', 'aim', 'jump', 'rope', 'reel', 'weapon', 'startCharge', 'releaseCharge'];
  if (type === 'fire' || type === 'startCharge') {
    if (phase !== 'aim' || match.hasFired) return json(409, { message: 'illegal action for current phase' });
  } else if (type === 'endTurn') {
    if (phase !== 'aim') return json(409, { message: 'illegal action for current phase' });
  } else if (aimOnly.includes(type)) {
    if (phase !== 'aim') return json(409, { message: 'illegal action for current phase' });
  } else {
    return json(400, { message: 'unknown action type' });
  }

  const log = await getActionLog(code, ddbClient);
  const actions = Array.isArray(log.actions) ? log.actions : [];
  if (body.clientActionId && actions.some((a) => a && a.clientActionId === body.clientActionId)) {
    return json(200, { code, match: toOnlineMatch(match), duplicate: true });
  }
  if (actions.length >= ACTION_CAP) return json(409, { message: 'action log full' });

  const now = new Date().toISOString();
  const updates = {};
  if (type === 'endTurn') {
    const n = players.length;
    let nextTeam = match.activeTeam;
    for (let i = 1; i <= n; i++) {
      const idx = (match.activeTeam + i) % n;
      if (players[idx]) { nextTeam = idx; break; }
    }
    updates.activeTeam = nextTeam;
    updates.turn = (match.turn || 1) + 1;
    updates.turnStartedAt = now;
    updates.phase = 'aim';
    updates.hasFired = false;
  } else if (type === 'fire') {
    updates.phase = 'projectile';
    updates.hasFired = true;
  }
  if (type === 'weapon' && isStr(action.id)) {
    updates.weapon = action.id;
  }

  const exprParts = [];
  const names = {};
  const values = {};
  for (const [k, v] of Object.entries(updates)) {
    exprParts.push('#' + k + ' = :' + k);
    names['#' + k] = k;
    values[':' + k] = v;
  }
  if (exprParts.length > 0) {
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: 'ONLINE#' + code, sk: 'META' },
      UpdateExpression: 'SET ' + exprParts.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  }

  const entry = { tick: match.turn || 1, action, playerId: body.playerId, clientActionId: body.clientActionId || null, at: now };
  await ddbClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: 'ACTION#' + code, sk: 'LOG' },
    UpdateExpression: 'SET actions = list_append(if_not_exists(actions, :empty), :e)',
    ExpressionAttributeValues: { ':empty': [], ':e': [entry] },
  }));

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

'''

assert anchor in s
s = s.replace(anchor, funcs + anchor, 1)

# Add routes
old_route = "    const onlineJoin = path.match(/^\\/api\\/matches\\/online\\/([^/]+)\\/join$/);\n    if (method === 'POST' && onlineJoin) return await joinOnlineMatch(event, decodeURIComponent(onlineJoin[1]));"
new_route = old_route + "\n    const onlineAction = path.match(/^\\/api\\/matches\\/online\\/([^/]+)\\/action$/);\n    if (method === 'POST' && onlineAction) return await submitAction(event, decodeURIComponent(onlineAction[1]));\n    const onlineForfeit = path.match(/^\\/api\\/matches\\/online\\/([^/]+)\\/forfeit$/);\n    if (method === 'POST' && onlineForfeit) return await forfeitOnlineMatch(event, decodeURIComponent(onlineForfeit[1]));"
assert old_route in s
s = s.replace(old_route, new_route, 1)

# Exports
s = s.replace(
  "exports.getOnlineMatch = getOnlineMatch;",
  "exports.getOnlineMatch = getOnlineMatch;\nexports.submitAction = submitAction;\nexports.forfeitOnlineMatch = forfeitOnlineMatch;",
  1)

open(p, 'w').write(s)
print('done')
