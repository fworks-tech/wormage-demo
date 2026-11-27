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

## Observability and cost attribution

The HTTP API `$default` stage writes JSON access logs to `/aws/apigateway/wormage` with 30-day retention. Each event contains `requestId`, `routeKey`, method, status, latency, source IP and response length. Authorization headers, request/response bodies, query strings and screenshots are never included. Source IP is operational personal data: keep the log group IAM-restricted and do not export it to broader tooling.

The `wormage-backend` CloudWatch dashboard covers Lambda traffic/errors/latency, API traffic/errors/latency, DynamoDB capacity/throttles and the `Wormage/Application` error/bug-report signals. It uses standard metrics only; detailed route metrics and X-Ray stay disabled for cost control.

All taggable stack resources receive `Project=wormage`, `Environment=prod`, `ManagedBy=CDK` and `CostCenter=wormage`. The keys are present on the stack and backend resources, but Billing has not listed them in `list-cost-allocation-tags` yet. Activation and the first tag-attributed baseline remain open in #279; applying a tag does not make it visible in Cost Explorer until its tag key is activated.

HTTP API access logging uses stage log delivery, not an account-wide API Gateway CloudWatch role. The deploy principal still needs the CloudWatch Logs delivery permissions documented by AWS. Verify a real request after deploy:

```bash
curl -sS -D - -o /dev/null https://api.wormage.flabs.tech/health
aws logs filter-log-events \
  --log-group-name /aws/apigateway/wormage \
  --filter-pattern '{ $.requestId = "<x-amzn-request-id>" }'
aws logs describe-log-groups \
  --log-group-name-prefix /aws/apigateway/wormage \
  --query 'logGroups[0].retentionInDays'
```

If the filter is empty, repeat it after API Gateway finishes delivering the event; do not treat a single immediate miss as a logging failure.

## Anonymous authentication

Production uses `AUTH_MODE=observe` until the new client is deployed and no legacy `waiting` or `ready` matches remain. Switch `WORMAGE_AUTH_MODE` to `enforce` and redeploy through the approved workflow only after checking current clients and active matches.

A `401` means the token is missing, invalid or expired; the client refreshes once and retries. A `403` means the authenticated player does not own the record or participate in the match. Do not log bearer tokens. Secret rotation is not automated: set a new `WORMAGE_AUTH_SECRET` GitHub secret and redeploy (workflow publishes via `aws ssm put-parameter`, template holds only the name); every session re-authenticates on next refresh, so rotate in a low-traffic window. Verify with `aws ssm get-parameter --name /wormage/auth/secret --with-decryption --query Parameter.Value`.

## Upload kill switches

Debug logs are disabled by default; bug reports are enabled. While disabled, both endpoints return `202 { "stored": false, "reason": "disabled" }` and write nothing to S3.

The SSM parameters are read at deploy time:

- `/wormage/debug-logs/enabled`
- `/wormage/bug-reports/enabled`
- `/wormage/github-issues/enabled`

Debug-log and bug-report defaults live in `infra/lib/wormage-stack.ts`; change them and deploy through the approved infrastructure workflow. The GitHub issue flag is controlled by the `WORMAGE_GITHUB_ISSUES_ENABLED` repository variable, as described below. Emergency: `aws lambda update-function-configuration` can flip an environment value immediately, then reconcile it in CDK. Bug reports stay on because anonymous auth gives per-actor attribution on top of per-route throttling and the >20/hour alarm; re-disable via the SSM default if abuse ever outruns those controls. Debug logs should remain disabled until there is an explicit operational need. The GitHub token parameter is read at runtime and cached per warm Lambda environment; it is not baked into the function environment.

## GitHub issues from bug reports

The integration is disabled by default and only runs after the report JSON is stored in S3. It creates a public issue with a redacted summary and S3 keys; the full report and screenshot stay private. Online match codes are removed from the public page URL. S3 storage, the `bug-report` metric and the API response remain successful when GitHub is unavailable. One three-second deadline covers the DynamoDB rate-limit claim, the SSM token read and the GitHub requests.

Issue creation is limited to five attempts per fixed UTC hour bucket per source IP. The Lambda stores only a SHA-256 hash of the IP in `BUG_REPORT_ISSUE#<hash>` items with TTL cleanup. The conditional counter is shared across Lambda environments; exhausted quota or a DynamoDB failure skips the GitHub call but never discards the report. Because the window is fixed rather than rolling, up to ten attempts can occur within a short interval spanning two adjacent buckets.

Prerequisites:

1. Create a fine-grained GitHub PAT for `fworks-tech/wormage-demo` with Issues read/write only.
2. Add it as the `WORMAGE_GITHUB_TOKEN` GitHub Actions secret. Never paste it into the CDK template, source or logs.
3. Set `WORMAGE_AUTH_MODE=enforce`. HTTP API route throttling alone is not per IP, so the stack and workflow refuse activation without enforced anonymous auth.
4. Set the repository variable `WORMAGE_GITHUB_ISSUES_ENABLED=true` and deploy through the approved workflow. The workflow publishes the token to `/wormage/github/bug-report-token`; a missing token fails the deploy when the flag is on. While disabled, the workflow does not publish the token and the Lambda role cannot read it.

Verify the parameter exists without printing its value:

```bash
aws ssm get-parameter --name /wormage/github/bug-report-token --query Parameter.Name
```

Disable by setting `WORMAGE_GITHUB_ISSUES_ENABLED=false` and redeploying. Existing S3 reports are unaffected. For an emergency, edit only the Lambda's `GITHUB_ISSUES_ENABLED` environment variable to `false`, then reconcile the value in CDK. Rotate the PAT through the GitHub secret and redeploy, then revoke the old PAT. A GitHub `401` clears the warm environment's cached token so the next report reloads the new value from SSM.

Inspect failures without exposing tokens or report bodies:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/<handler-log-group> \
  --filter-pattern '{ $.type = "github-issue-failed" }'
```

Each admitted issue attempt performs one GitHub Search request before a possible create. Authenticated GitHub Search allows 30 requests/minute, while the bug-report route permits 60/minute; sustained traffic can therefore skip issue creation with warnings even though uploads remain successful. Monitor `github-issue-failed` and lower report volume if this becomes frequent.

After activation, submit one controlled report and verify the S3 objects, the marked GitHub issue and the optional `githubIssue` response. The dialog reuses one `reportId` across Send retries. Replaying the same payload also exercises server deduplication. Search-then-create is not atomic: indexing delay, a crash after creation, or two concurrent submissions with the same ID can still produce duplicates; close the duplicate manually if it occurs.

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

### Cost Explorer baseline

Cost Explorer is enabled: `GetCostAndUsage` returned data on 2026-11-27. The baseline below is the most recent completed month, October 2026 (`2026-10-01` through `2026-11-01`, end exclusive), using `UnblendedCost` with credits and refunds excluded.

| Service | October 2026 (USD) |
| --- | ---: |
| Account total | 7.3466934786 |
| AWS Lambda | 0 |
| Amazon API Gateway | 0 |
| Amazon DynamoDB | 0 |
| Amazon Simple Storage Service | 0.0001750054 |
| AmazonCloudWatch | 0 |
| AWS X-Ray | 0 |
| Amazon Simple Notification Service | 0 |

Missing service groups are recorded as zero. The account total includes unrelated workloads, so it is not a Wormage-only baseline. November-to-date is also not comparable: it is partial and includes unrelated EC2, ECS, RDS and networking spend.

The four cost tag keys are applied to the stack and backend resources, but Billing did not list them on 2026-11-27 and `UpdateCostAllocationTagsStatus` returned `Tag keys not found`. Recheck after 24–48 hours, activate the keys, then record the first tag-attributed month. [Cost allocation tag backfill](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-allocation-backfill.html) can apply activation for up to twelve months, but tag values are available only for months when the resource carried the tag. `CostCenter` was added to the stack on 2026-11-27, so October cannot be attributed to `CostCenter=wormage`.

```bash
aws ce list-cost-allocation-tags
aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status '[
    {"TagKey":"CostCenter","Status":"Active"},
    {"TagKey":"Project","Status":"Active"},
    {"TagKey":"Environment","Status":"Active"},
    {"TagKey":"ManagedBy","Status":"Active"}
  ]'
# Gate: the update response must contain Errors: []. Retry failed keys.
aws ce list-cost-allocation-tags
# Continue only when all four keys show Status=Active; activation can take 24–48 hours.
MONTH_START=YYYY-MM-DD # First day of the month under review.
MONTH_END=YYYY-MM-DD   # First day of the following month; End is exclusive.
aws ce get-cost-and-usage \
  --time-period Start="$MONTH_START",End="$MONTH_END" \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter '{"And":[{"Tags":{"Key":"CostCenter","Values":["wormage"]}},{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit","Refund"]}}}]}' \
  --group-by Type=DIMENSION,Key=SERVICE
```

A query for the current month returns partial costs. Record the baseline only for a completed month with full `CostCenter` tag coverage and activation; completing a month alone does not tag earlier usage. If the resource carried `CostCenter` throughout a prior month but the key was inactive, complete the appropriate tag backfill before using that month.

Budget refinement stays manual: keep the USD 10 cap, review tagged service costs weekly for the first month, investigate any increase before changing the limit, and update this section with the query date and new baseline only after maintainer review.

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
