# ADR-0010: Cloud profile sync reuses the anonymous player identity

**Date:** 2026-11-26
**Status:** Accepted
**Supersedes:** none

## Context

Issue #171 asks for cloud save and its plan proposes a Cognito identity pool. The app already issues a stable anonymous `playerId` from `POST /api/auth/session`: an HS256 bearer token whose verified `sub` claim is the only accepted identity (ADR-0008). Cognito is not present in the client or the CDK stack; adding a user or identity pool would create a second identity source, need a sign-in UI and token verification path, and expand M5 scope. The local profile (`src/state/profile.ts`) is also not yet written by gameplay, so sync cannot ship before M5.

## Decision

Profile sync uses the verified anonymous `playerId` as its cloud key. `GET/PUT/DELETE /api/profile` store one item per player in the existing DynamoDB table; the server ignores any client-supplied identity. Conflict resolution is last-write-wins by `(revision, updatedAt)` with the local copy winning ties. Signed-out play stays local-only. Cognito user and identity pools stay deferred; a later ADR can introduce them with an explicit identity migration.

## Alternatives Considered

| Option | Pros | Cons | Why rejected |
| --- | --- | --- | --- |
| Cognito unauthenticated identity pool | Stable id, managed service | Two identity sources; new SDK and infra; still no sign-in | Deferred — no benefit over the existing verified id |
| Cognito user pool with sign-in | Real accounts, recovery and federation | Sign-up UI, RS256/JWKS verification, account migration, M5 scope expansion | Rejected for this slice |
| Existing anonymous HS256 `playerId` | Already deployed, server-verified, no new dependency | No account recovery; id is tied to the local token | Accepted |

## Consequences

- Cross-device sync works only when both devices authenticate as the same anonymous identity; losing the local token loses access to the cloud profile.
- No password, email or recovery flow exists; account lifecycle remains a future decision.
- Profile storage contains a player-chosen display name, XP, level, unlocks and mission progress. A delete route and a privacy note are part of the work, not extras.
- Last-write-wins can discard progress from a second offline device; the rule is documented and tested rather than hidden.
- If Cognito is introduced later, this decision needs a superseding ADR and an identity migration plan.
