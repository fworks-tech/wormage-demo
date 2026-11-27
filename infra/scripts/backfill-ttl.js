'use strict';
// Backfills DynamoDB TTL (`expiresAt`, epoch seconds) on online items only.
// Dry-run by default: prints what would change, writes nothing. Idempotent:
// only ONLINE#/MATCH# items missing expiresAt are touched, so re-running
// after --apply finds nothing to do. Ranking/history (CLIENT#) never match,
// and legacy online matches (actionLogVersion !== 2) are skipped so no
// active legacy match expires before the auth cutover.
// Usage: TABLE_NAME=wormage node infra/scripts/backfill-ttl.js [--apply]
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.TABLE_NAME;
if (!TABLE) { console.error('TABLE_NAME is required'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const ONLINE_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACTION_LOG_VERSION = 2;

function baseMs(item) {
  for (const k of ['createdAt', 'at', 'turnStartedAt', 'finishedAt']) {
    const t = item[k] && Date.parse(item[k]);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

async function main() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const parentCache = new Map();
  const parentIsLegacy = async (code) => {
    if (!parentCache.has(code)) {
      const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `ONLINE#${code}`, sk: 'META' } }));
      const m = res.Item;
      parentCache.set(code, !m || m.actionLogVersion !== ACTION_LOG_VERSION);
    }
    return parentCache.get(code);
  };

  let scanned = 0;
  let missing = 0;
  let legacy = 0;
  let updated = 0;
  let startKey;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'attribute_not_exists(expiresAt) AND (begins_with(pk, :o) OR begins_with(pk, :m))',
      ExpressionAttributeValues: { ':o': 'ONLINE#', ':m': 'MATCH#' },
      ExclusiveStartKey: startKey,
    }));
    const items = res.Items || [];
    scanned += (res.ScannedCount ?? items.length);
    for (const item of items) {
      const isMeta = item.pk.startsWith('ONLINE#');
      const isLegacy = isMeta
        ? item.actionLogVersion !== ACTION_LOG_VERSION
        : await parentIsLegacy(item.pk.slice('MATCH#'.length));
      if (isLegacy) {
        legacy += 1;
        if (!APPLY && legacy <= 20) console.log(`skipping legacy ${item.pk}#${item.sk}`);
        continue;
      }
      missing += 1;
      const expiresAt = Math.floor(baseMs(item) / 1000) + ONLINE_TTL_SECONDS;
      if (!APPLY) {
        if (missing <= 20) console.log(`would set expiresAt=${expiresAt} on ${item.pk}#${item.sk}`);
        continue;
      }
      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: 'SET expiresAt = :exp',
          ConditionExpression: 'attribute_not_exists(expiresAt)',
          ExpressionAttributeValues: { ':exp': expiresAt },
        }));
        updated += 1;
      } catch (err) {
        if (!err || err.name !== 'ConditionalCheckFailedException') throw err;
      }
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  console.log(`${APPLY ? 'Updated' : 'Would update'} ${APPLY ? updated : missing} of ${scanned} scanned items; skipped ${legacy} legacy (dry-run=${!APPLY})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
