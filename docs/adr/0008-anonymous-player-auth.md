# ADR-0008: Anonymous player authentication

**Date:** 2026-11-26  
**Status:** Proposed

## Context

Wormage keeps anonymous play, but match history, match registration and online actions currently trust a public `playerId`. Anyone who knows another player's ID can impersonate that player. The replacement must preserve anonymous play without adding a full account system or migrating existing public IDs into credentials.

## Decision

Issue a short-lived HS256 bearer token from `POST /api/auth/session`. The token carries `sub`, `iat`, `exp`, `iss` and `aud`; the server derives `playerId` only from the verified `sub` claim. Store the 32-byte signing secret in AWS Secrets Manager and inject only its ARN into the Lambda environment.

The client stores the token locally and sends it through the Axios `Authorization` header. The mock server implements the same token contract for local and MSW transports.

Roll out in two modes:

1. `observe`: issue and accept tokens, but tolerate legacy clients while recording compatibility metrics.
2. `enforce`: require a valid token on every non-public route and reject client-supplied identity mismatches.

Existing records remain intact. A new token creates a new anonymous identity; ownership of historical records is not transferred automatically.

## Alternatives Considered

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| Public `playerId` | Simplest | Trivial impersonation | Rejected |
| Cognito user pools | Full identity lifecycle | Account UX, migration and M5 scope expansion | Deferred |
| HMAC bearer token | Anonymous, small, server-verifiable | Requires secret rotation and client storage | Accepted |

## Consequences

- Match writes and online actions become resistant to `playerId` spoofing.
- Token expiry requires a refresh path; expired sessions receive `401`.
- Secret rotation must accept the previous and current key during a bounded overlap.
- Auth cutover requires no active legacy `waiting` or `ready` matches before `enforce`.
