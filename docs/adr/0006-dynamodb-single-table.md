# 0006. DynamoDB single-table design for matches and leaderboard

- **Status:** Accepted
- **Date:** 2026-11-20
- **Supersedes:** none

## Context

M3 moves ranking and history off MSW fixtures onto AWS. The access patterns are small and well-defined: register a match (idempotent by `clientMatchId`), list a player's matches, and read a leaderboard for a given `configKey`. A relational database would be overkill and cost more at this scale.

## Decision

One DynamoDB table `wormage` with composite key `pk`/`sk`. A match is stored as `pk = CLIENT#<clientMatchId>`, `sk = META`, which makes registration idempotent: a `GetItem` on that key returns the existing record. Two GSIs cover the read paths:

- `LeaderboardIndex` (partition `gsi1pk = CONFIG#<configKey>`, sort `gsi1sk = createdAt`) for the per-config leaderboard.
- `PlayerIndex` (partition `playerId`, sort `createdAt`) for a player's match history.

The Lambda computes best-per-player and sorting in code; the GSI only narrows the candidate set.

## Alternatives considered

- **Multiple tables (matches, leaderboard)** — simpler mental model but doubled IAM/ops and no benefit at this scale.
- **Scan + filter** — fine for fixtures, unacceptable once real traffic exists.

## Consequences

One table to operate and back up. Adding a new access pattern means a new GSI (limit 20 per table) or a new query shape; document any new pattern here before adding it.
