# ADR-0011: Best-effort GitHub issues from stored bug reports

**Date:** 2026-11-27

**Status:** Accepted

## Context

Bug reports are validated by the API Lambda and stored in S3 with an optional screenshot, but opening the corresponding GitHub issue is manual. The integration must preserve the existing upload contract, avoid new paid AWS infrastructure, keep the full report private and isolate GitHub outages from player submissions. The issue endpoint is public, so automatic issue creation also needs a kill switch and an abuse-control prerequisite.

## Decision

After the report JSON is stored successfully, the request Lambda may create a redacted issue in `fworks-tech/wormage-demo` through the GitHub REST API. Node 22 `fetch` handles the request; a fine-grained token with Issues read/write only for that repository lives in an SSM SecureString Standard parameter. The integration is disabled by default and fails closed when configuration is missing. Enabling it requires `AUTH_MODE=enforce`; token publication and the Lambda's token-read permission exist only while the integration is enabled.

S3 remains authoritative. Before any GitHub call, the Lambda atomically claims one of five issue slots per fixed UTC hour bucket per source IP in the existing DynamoDB table; only a SHA-256 hash is stored and TTL removes the counter. The fixed window can admit up to ten attempts across adjacent buckets near a boundary. One three-second deadline covers that claim, the SSM token read and GitHub search/create. GitHub search, create, timeout, quota and DynamoDB failures produce structured warnings and never change an already stored report into a 500. The client generates one report ID per dialog attempt and reuses it on retry; the server searches a marker derived from that ID before creation. The public issue contains only a bounded player note, app/match summary, sanitized page origin/path and S3 keys. Online match codes are redacted, and screenshots/raw diagnostics remain private.

## Alternatives Considered

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| Create the issue directly in the request Lambda | Smallest change; no queue or new AWS resource; returns the issue URL immediately | Adds bounded external latency; depends on GitHub availability | Accepted |
| S3 event → EventBridge/SQS → consumer Lambda | Decouples upload latency; durable retries | New resources, IAM, failure handling and cost; still needs idempotency | Rejected |
| GitHub Actions repository dispatch | Moves issue formatting into workflow code | Extra token scope, asynchronous handoff and more moving parts | Rejected |
| Publish the raw report or screenshot in the issue | Maximum diagnostic context | Exposes private/sensitive data and complicates attachment handling | Rejected |

## Consequences

- Maintainers get a triageable issue without manually inspecting S3 first.
- No new paid AWS service or package dependency is introduced; the existing Lambda and SSM Standard parameter are reused.
- A stored report can add up to roughly three seconds total for SSM plus GitHub, but failures remain isolated.
- GitHub Search allows 30 authenticated requests/minute, below the route's 60/minute capacity; sustained traffic can skip issue creation with warnings.
- Search-then-create is not atomic: indexing delay, a crash after creation, or concurrent same-ID submissions can still create duplicates.
- A GitHub `401` clears the cached token; rotation also requires revoking the old PAT after deploying the new one.
- Production activation stays blocked unless anonymous auth is enforced; a shared per-IP counter also caps GitHub issue attempts.
- `postBugReport` remains above the project's complexity threshold. This change extracts only the GitHub branch; split validation/storage when the report format is next modified.

## References

- [#331 — feat(infra): create GitHub issues from bug reports](https://github.com/fworks-tech/wormage-demo/issues/331)
- [Bug-report configuration](../CONFIGURATION.md#bug-reports)
- [Backend runbook](../RUNBOOK.md#github-issues-from-bug-reports)
