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

## Upload kill switches

Debug logs and bug reports are disabled by default. While disabled, both endpoints return `202 { "stored": false, "reason": "disabled" }` and write nothing to S3.

The SSM parameters are read at deploy time:

- `/wormage/debug-logs/enabled`
- `/wormage/bug-reports/enabled`

Change the value in `infra/lib/wormage-stack.ts` and deploy through the approved infrastructure workflow. Emergency: `aws lambda update-function-configuration` can flip the env immediately, then reconcile in CDK. Do not re-enable bug reports until per-IP control (WAF per-IP or auth) is live, not on per-route throttling alone. Debug logs should remain disabled until there is an explicit operational need.

## Read stored reports

Reports are private and have no admin UI. List objects with:

```bash
aws s3 ls s3://<debug-log-bucket>/bug-reports/ --recursive
```

Download a specific JSON report with `aws s3 cp s3://<bucket>/<key> .`. Treat report text, URLs, user-agent strings and screenshots as untrusted content.

## Throttling

Per-route limits are defined in `infra/lib/wormage-stack.ts`. Bug reports default to 1 request/second with burst 2; debug logs to 2 / 5; match and online writes to 5 / 10. To tighten a route, lower its `RouteSettings` values and deploy. To stop uploads entirely, use the kill switches above rather than relying on throttling.

## Rollback

Infrastructure rollback is a revert plus redeploy through the same approved workflow. Do not use `cdk destroy` as a rollback. Removing an SNS subscription stops notification delivery but leaves the alarms in place.
