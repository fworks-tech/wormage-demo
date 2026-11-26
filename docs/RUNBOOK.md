# Backend runbook

## Alerts

Backend alarms publish to the `WormageAlarmTopic` SNS topic. When `WORMAGE_ALARM_EMAIL` is configured, SNS sends a confirmation message to that address; the subscription only delivers alerts after confirmation.

Covered signals:

- Lambda invocation errors, throttles and p99 duration above 8 seconds.
- Handled application errors logged as `{ "level": "error" }`.
- More than 20 bug reports per hour for two consecutive hours.
- DynamoDB `ThrottledRequests` on the `wormage` table.
- HTTP API 5xx responses (threshold: 2 in five minutes).

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

Change the value in `infra/lib/wormage-stack.ts` and deploy through the approved infrastructure workflow. Do not re-enable bug reports until anonymous authentication and per-route throttling are live. Debug logs should remain disabled until there is an explicit operational need.

## Read stored reports

Reports are private and have no admin UI. List objects with:

```bash
aws s3 ls s3://<debug-log-bucket>/bug-reports/ --recursive
```

Download a specific JSON report with `aws s3 cp s3://<bucket>/<key> .`. Treat report text, URLs, user-agent strings and screenshots as untrusted content.

## Rollback

Infrastructure rollback is a revert plus redeploy through the same approved workflow. Do not use `cdk destroy` as a rollback. Removing an SNS subscription stops notification delivery but leaves the alarms in place.
