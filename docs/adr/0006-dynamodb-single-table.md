# 0006. DynamoDB single-table design for matches and leaderboard

- **Status:** Accepted
- **Date:** 2026-11-20
- **Updated:** 2026-11-26
- **Supersedes:** none

## Context

M3 moves ranking and history off MSW fixtures onto AWS. The access patterns are small and well-defined: register a match (idempotent by `clientMatchId`), list a player's matches, and read a leaderboard for a given `configKey`. A relational database would be overkill and cost more at this scale.

## Decision

One DynamoDB table `wormage` with composite key `pk`/`sk`. A match is stored as `pk = CLIENT#<clientMatchId>`, `sk = META`, which makes registration idempotent: a `GetItem` on that key returns the existing record. Two GSIs cover the read paths:

- `LeaderboardIndex` (partition `gsi1pk = CONFIG#<configKey>`, sort `gsi1sk = createdAt`) for the per-config leaderboard.
- `PlayerIndex` (partition `playerId`, sort `createdAt`) for a player's match history.

The Lambda computes best-per-player and sorting in code; the GSI only narrows the candidate set.

### Online action log (M4b)

Online match metadata remains at `pk = ONLINE#<code>`, `sk = META`. Matches created with `actionLogVersion: 2` store each accepted gameplay action at:

- `pk = MATCH#<code>`
- `sk = ACTION#<turn:04d>#<seq:04d>`

The action item carries `seq`, `turn`, `playerId`, `action`, `tick`, `engineTick`, `clientActionId` and `at`. `seq` is global and monotonic within the match. The Lambda reads the partition with a consistent, ascending, paginated `Query`; replay sorts by `tick → seq → at` because client ticks can arrive out of order.

A conditional `Put` for the action and the conditional match `Update` share one `TransactWriteItems` request. `clientActionId` is mandatory and checked before readiness, turn or phase validation. Identical retries return `200 duplicate`; reuse with another player or action returns `409`. A transaction conflict re-reads the strongly consistent log before deciding whether the retry already committed. The match update also requires `status = ready`, so a concurrent forfeit cannot be overwritten by a late action. Post-shot time synchronisation also stores an action item for idempotency, marked `syncOnly` and excluded from gameplay replay so it cannot cancel a projectile.

Accepted actions are validated against the exact `GameAction` shapes: unknown fields are rejected, numeric and direction fields are checked, and the serialized action is capped at 512 UTF-8 bytes. Queried items are mapped to the public action-log fields before returning them; internal `pk` and `sk` values never leave the Lambda.

The previous `ACTION#<code>/LOG` array is not read, migrated or kept in sync. Matches without `actionLogVersion: 2` are frozen and return `410 Gone` from GET, join, action, forfeit and replay. This is a deliberate cutover: deploy only when no legacy matches are active.

## Alternatives considered

- **Multiple tables (matches, leaderboard)** — simpler mental model but doubled IAM/ops and no benefit at this scale.
- **Scan + filter** — fine for fixtures, unacceptable once real traffic exists.

## Consequences

One table to operate and back up. Adding a new access pattern means a new GSI (limit 20 per table) or a new query shape; document any new pattern here before adding it.

Per-action items avoid the 400 KB single-item ceiling and make append/idempotency conditions explicit. The trade-off is a paginated read per action submission and a hard compatibility cutover for legacy online matches; rollback requires rolling forward because the old Lambda cannot read version 2 logs.
