# Backend runbook

## Alerts

Backend alarms publish to the `WormageAlarmTopic` SNS topic. When `WORMAGE_ALARM_EMAIL` is configured, SNS sends a confirmation message to that address; the subscription only delivers alerts after confirmation.

Covered signals:

- Lambda invocation errors, throttles and p99 duration above 8 seconds.
- Handled application errors logged as `{ "level": "error" }`. Replay rejections log as `{ "level": "warn", "type": "replay-rejected" }` and do not page; expected 409s (stale tick, illegal action) are excluded by design.
- More than 20 bug reports per hour (stored reports only).
- DynamoDB `ThrottledRequests` on the `wormage` table. The table is on-demand, so this is a backstop; treat API 5xx and Lambda p99 as the real overload signals.
- HTTP API 5xx responses (threshold: 2 in five minutes). One handled 500 pages twice (ApplicationErrors plus 5xx); treat them as one incident. There is no 4xx/429 alarm; throttled abuse is tracked separately.

Without `WORMAGE_ALARM_EMAIL` the topic has no subscription and alarms fire silently. Keep the address in secrets rather than vars when possible; changing it replaces the subscription and requires re-confirmation, with a silent gap in between. Calibrate the bug-report threshold after the first production week.

To test delivery without changing metrics, set an alarm to `ALARM` in the CloudWatch console or with:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name <alarm-name> \
  --state-value ALARM \
  --state-reason "Wormage alert delivery test"
```

Return the alarm to `OK` afterward. Confirm the SNS email subscription before treating the alert path as operational.

## Anonymous authentication

Production uses `AUTH_MODE=observe` until the new client is deployed and no legacy `waiting` or `ready` matches remain. Switch `WORMAGE_AUTH_MODE` to `enforce` and redeploy through the approved workflow only after checking current clients and active matches.

A `401` means the token is missing, invalid or expired; the client refreshes once and retries. A `403` means the authenticated player does not own the record or participate in the match. Do not log bearer tokens. Secret rotation is not automated: set a new `WORMAGE_AUTH_SECRET` GitHub secret and redeploy (workflow publishes via `aws ssm put-parameter`, template holds only the name); every session re-authenticates on next refresh, so rotate in a low-traffic window. Verify with `aws ssm get-parameter --name /wormage/auth/secret --with-decryption --query Parameter.Value`.

## Upload kill switches

Debug logs are disabled by default; bug reports are enabled. While disabled, both endpoints return `202 { "stored": false, "reason": "disabled" }` and write nothing to S3.

The SSM parameters are read at deploy time:

- `/wormage/debug-logs/enabled`
- `/wormage/bug-reports/enabled`

Change the value in `infra/lib/wormage-stack.ts` and deploy through the approved infrastructure workflow. Emergency: `aws lambda update-function-configuration` can flip the env immediately, then reconcile in CDK. Bug reports stay on because anonymous auth gives per-actor attribution on top of per-route throttling and the >20/hour alarm; re-disable via the SSM default if abuse ever outruns those controls. Debug logs should remain disabled until there is an explicit operational need.

## Read stored reports

Reports are private and have no admin UI. List objects with:

```bash
aws s3 ls s3://<debug-log-bucket>/bug-reports/ --recursive
```

Download a specific JSON report with `aws s3 cp s3://<bucket>/<key> .`. Treat report text, URLs, user-agent strings and screenshots as untrusted content.

## Throttling

Per-route limits are defined in `infra/lib/wormage-stack.ts`. Bug reports default to 1 request/second with burst 2; debug logs to 2 / 5; match and online writes to 5 / 10 (300 writes/minute per route, shared across all matches). Costly reads are also isolated: online polling to 5 / 10 and replay to 1 / 2. To tighten a route, lower its entry in the throttled map and deploy. To stop uploads entirely, use the kill switches above rather than relying on throttling. Limits are per API route, not per client: one abusive client can exhaust a route for everyone. Expected backoff is registration `retry: 1`, online actions rely on the GameView 1 s commit retry, and bug reports keep the preview for manual retry.

## Budget and Lambda capacity

Spend is guarded by a USD 10/month COST budget (`wormage-monthly`) with 50%, 80% and 100% actual plus 100% forecast alerts to the alarm SNS topic. Confirm the SNS email subscription before treating the budget path as operational.

Reserved concurrency stays unset while the account concurrent-execution quota is 10. Request a quota increase to 200 via Service Quotas (`AWS Lambda / Concurrent executions`), then set `lambdaReservedConcurrency: 10` in `infra/lib/wormage-stack.ts` and redeploy through the approved workflow. Keep the reservation well below the quota so bursts and other functions still have headroom.

## Rollback

Infrastructure rollback is a revert plus redeploy through the same approved workflow. Do not use `cdk destroy` as a rollback. Removing an SNS subscription stops notification delivery but leaves the alarms in place.

## Retention and deletion protection

Online data is bounded; ranking/history is forever. `expiresAt` (epoch seconds, DynamoDB TTL) rides on online match metadata (`ONLINE#`) and the action log (`MATCH#`) with 30-day retention, refreshed on every write. Ranking/history items (`CLIENT#`) never carry `expiresAt` — a TTL stamp there would silently wipe the leaderboard.

S3 lifecycle on the data bucket: `debug-logs/` expires after 7 days, `bug-reports/` after 30 days, and incomplete multipart uploads abort after 1 day.

Production delete guards (all fail closed): the stack has CloudFormation termination protection, the table has deletion protection plus `RETAIN` removal policy and point-in-time recovery, and the bucket is `RETAIN`. Do not relax these without an ADR.

Verify live after deploy:

```bash
aws dynamodb describe-time-to-live --table-name wormage
aws dynamodb describe-table --table-name wormage --query Table.DeletionProtectionEnabled
aws s3api get-bucket-lifecycle-configuration --bucket <debug-log-bucket>
aws cloudformation describe-stacks --stack-name WormageStack --query 'Stacks[0].EnableTerminationProtection'
```

Existing online rows predate TTL. Backfill them with the idempotent dry-run script (writes nothing by default, skips legacy matches so no active legacy match expires before the auth cutover):

```bash
TABLE_NAME=wormage node infra/scripts/backfill-ttl.js
TABLE_NAME=wormage node infra/scripts/backfill-ttl.js --apply
```
