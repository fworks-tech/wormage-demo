# Spec: Profile cloud save (#171)

Status: planned — blocked by M5
Scope: `src/state/`, `src/api/`, `src/mocks/`, `infra/lambda/`, `infra/lib/`, `tests/`
Decision: [ADR-0010](../adr/0010-cloud-profile-identity.md)

## Problem

A player's campaign progress lives only in the browser. `LocalStorageProfileRepository` exists (`src/state/profile.ts`), but no runtime code reads or writes it — mission progress is stored separately in `wormage.stages.v1` (`src/state/stages.ts`). Cloud sync today would copy an empty file. M5 must first make the profile a live part of the game; only then can M6 move it between devices without breaking offline play.

## Problem brief

**Success criteria**

1. Gameplay writes XP, level, unlocks and mission progress to the profile, and a refresh restores them (M5 #163–#168).
2. A profile uploaded from one device can be read back on another device under the same anonymous identity.
3. Conflicting copies converge by newest-wins, with the rule documented and tested.
4. Signed-out play makes zero profile network calls and keeps the current local behavior.
5. Tests cover first sync, conflict and signed-out mode.

**Ranked priorities**

1. Local and signed-out play never regress.
2. Conflict handling is deterministic and does not silently discard newer progress.
3. Cross-device convergence.
4. Minimal auth and infrastructure surface.
5. UI polish — no sign-in flow is required for this decision.

**Risks and constraints**

- M5 (#163–#168) is still open; #171's own plan says to wait until the profile is stable.
- The existing HS256 bearer identity (`src/api/auth.ts`) issues a stable `playerId`; Cognito would add a second identity source. ADR-0010 keeps the existing one.
- Cloud save is conditional in `docs/ROADMAP.md`; it is not a prerequisite for the PWA or Capacitor wrapper.
- Profile fields currently include a display `name`; storing it server-side needs a privacy note and a delete path.

## Proposed Solution

- **Storage:** one item in the existing single DynamoDB table (`docs/adr/0006-dynamodb-single-table.md`): `pk=PROFILE#<playerId>`, `sk=META`. The item holds a monotonically increasing `revision`, an `updatedAt` timestamp and the validated profile payload. No new GSI, table or stack resource.
- **API:** `GET /api/profile`, `PUT /api/profile` and `DELETE /api/profile` on the existing HTTP API and Lambda router. The server derives `playerId` from the verified JWT `sub`; a client-supplied id is ignored. Missing profile is `404` on GET and accepted as a first upload on PUT. Local/MSW transports implement the same contract through `src/api/client.ts`.
- **Client sync:** a pure helper in `src/state/` compares the local profile with the remote envelope. A small local cursor (`wormage.profile-sync.v1`) records the last synced `revision` and whether local changes happened while offline. `LocalStorageProfileRepository` keeps its current shape; sync wraps it rather than replacing it.
- **Conflict:** newest wins by `(revision, updatedAt)`; a tie breaks to the local copy. A remote write uses a condition on the expected revision, so a stale upload is rejected and the client reloads the remote profile. Both directions are pure functions so they can be unit tested without a browser.
- **Signed-out mode:** when there is no valid session, the app reads and writes the profile locally only. The sync runs after `ensureAnonymousSession()` in `src/main.tsx` and never blocks a match from starting.

## Out of Scope

- Cognito user pools, identity pools, sign-in UI and federation (ADR-0010 defers them).
- Migrating leaderboard, match history or online identities to a new id.
- Real-time or multi-tab sync; per-mission merge instead of whole-profile last-write-wins.
- New gameplay, XP rules or mission content (M5 owns those).
- Capacitor-native auth or store account flows.

## Acceptance Criteria

- [ ] Gameplay code writes profile fields and a refresh restores them (tracked by M5 issues, not this spec).
- [ ] `GET /api/profile` returns `404` for a new identity and the stored profile for a known one; `PUT` writes only the verified `playerId`'s item.
- [ ] First sync uploads the local profile; a second device downloads the same fields.
- [ ] Two divergent profiles converge to the one with the higher `(revision, updatedAt)`; the tie-break is the local copy.
- [ ] With no auth session, no profile request is made and local save/load/reset behave as today.
- [ ] `DELETE /api/profile` removes the stored item.
- [ ] Unit tests cover first sync, conflict and signed-out mode; handler and MSW tests cover the endpoints.

## Testing Strategy

- `tests/unit/profile-sync.test.ts`: pure merge/conflict decisions with fabricated local and remote envelopes; no DOM.
- `infra/lambda/index.test.js`: profile routes, auth-derived id, condition failure on stale revision, delete.
- `tests/unit/auth.test.ts` / MSW handler tests: local transport uses the same `/api/profile` contract.
- No new Playwright spec for the first slice — cross-device identity would need two seeded sessions and belongs with the M5 profile UI once it exists.
- Add the new spec and any new unit files to `scripts/affected.mjs`.

## Open Questions

- Should `name` be synced, or should the receiving device keep its own display name? Privacy note needed either way.
- Is whole-profile last-write-wins acceptable for mission progress, or must per-mission records merge? Deferred until M5 defines mission progress writes.
- Does the maintainer want a status badge / manual "sync now" button, or fully automatic sync? Automatic is assumed here.

## Tasks

Implementation is blocked until #163, #166, #167 and #168 land and the profile has real writers. Use stacked branches, each with its own PR and the previous branch as base:

- [ ] `docs/issue-171-cloud-save-plan` — this spec and ADR-0010.
- [ ] `feat/171-profile-api` — DynamoDB profile item, GET/PUT/DELETE routes, auth-derived id, handler tests.
- [ ] `feat/171-profile-sync` — client sync helper, local cursor, signed-out behavior, unit tests (`Closes #171`).
- [ ] `docs/171-privacy` — document stored fields, deletion and retention in `docs/DECISIONS.md` and `docs/RUNBOOK.md`; can be folded into the API branch if small.
