'use strict';
// Seeds the wormage DynamoDB table with the same fixtures as src/api/mockServer.ts
// so a fresh deploy has a populated leaderboard. Idempotent by clientMatchId.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.TABLE_NAME;
if (!TABLE) { console.error('TABLE_NAME is required'); process.exit(1); }
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const FIXTURE_PLAYERS = ['VerminViper','DirtDauber','Boomhauer','Wormhole','GrenadeGus','TNTina','Sapper','Mudlark','Fuse','Nibbler','Shrapnel','Hollow'];
const CONFIGS = [
  { turnSeconds: 45, wind: 'light', difficulty: 'veteran' },
  { turnSeconds: 45, wind: 'light', difficulty: 'rookie' },
  { turnSeconds: 60, wind: 'strong', difficulty: 'veteran' },
  { turnSeconds: 30, wind: 'off', difficulty: 'elite' },
  { turnSeconds: 45, wind: 'strong', difficulty: 'elite' },
  { turnSeconds: 60, wind: 'light', difficulty: 'veteran' },
];

function keyOf(cfg) {
  return `${cfg.turnSeconds}s-${cfg.wind}-${cfg.difficulty}-island-deathmatch-default`;
}

async function main() {
  const now = Date.now();
  let count = 0;
  for (let index = 0; index < FIXTURE_PLAYERS.length; index += 1) {
    const name = FIXTURE_PLAYERS[index];
    for (let round = 0; round < CONFIGS.length; round += 1) {
      const cfg = CONFIGS[round];
      const score = 420 + ((index * 137 + round * 251) % 1180);
      const created = new Date(now - (index * 3 + round) * 36e5 - 864e5).toISOString();
      const configKey = keyOf(cfg);
      const clientMatchId = `fixture-${index}-${round}`;
      const item = {
        pk: `CLIENT#${clientMatchId}`,
        sk: 'META',
        type: 'match',
        id: `fixture-${index}-${round}`,
        clientMatchId,
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
        gsi1pk: `CONFIG#${configKey}`,
        gsi1sk: created,
      };
      try {
        await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
      } catch (err) {
        if (!err || err.name !== 'ConditionalCheckFailedException') throw err;
      }
      count += 1;
    }
  }
  console.log(`Seeded ${count} fixture matches into ${TABLE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
