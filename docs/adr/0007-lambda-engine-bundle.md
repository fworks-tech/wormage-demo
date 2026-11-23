# 0007. Bundle the renderer-free engine for Lambda replay

- **Status:** Accepted
- **Date:** 2026-11-22
- **Supersedes:** none

## Context

ADR 0003 makes the server the authority for online matches, but the Lambda handler is plain CommonJS and the simulation is TypeScript/ESM. The handler stored the action log but could not apply it, so every client replayed locally and the stored match item had no canonical state. Reimplementing the rules in the handler would create a second physics source; importing the TypeScript source directly would require a runtime transform the Lambda does not have.

## Decision

The infrastructure package bundles `src/game/engine.ts` with esbuild into `infra/lambda/engine.cjs` before `cdk synth`, `cdk deploy` and `cdk test`. The engine imports only renderer-free modules (`config`, `terrain`, `ai`, `types`, content data), so the bundle runs in the Node 22 Lambda runtime.

The replay loop lives in `infra/lambda/replay.js` and receives the engine class as an argument. The handler uses it to:

- replay the stored action log up to the submitted action tick and persist the resulting `GameSnapshot`;
- return the same snapshot in the match payload both players poll;
- expose `GET /api/matches/online/:code/replay` for a full-match replay;
- reject an action that makes the engine throw before writing either the match item or the action log.

The generated bundle is a build artifact and is not committed. `infra/package.json` owns the build step so a deploy cannot ship a stale `engine.cjs`.

## Alternatives considered

- **Port the rules to JavaScript in the handler** — rejected: two physics sources drift immediately.
- **Ship `ts-node` or a transpiler in the Lambda** — rejected: larger, slower cold starts and a second build path.
- **Persist only the full action log and replay on the client** — rejected: it leaves the server without an authoritative state and cannot reject an illegal action.
- **Serialize and restore the engine state** — deferred: the RNG and terrain generation are closures, so a restore format is a larger change than replaying from the seed. Replay cost is bounded by `MAX_TICKS` (300 s).

## Consequences

- The Lambda and the browser execute the same engine source, so replay parity can be tested directly.
- `infra/lambda/engine.cjs` is roughly 820 KB, mostly Zod pulled through the content schema. Lambda package size and cold start grow accordingly.
- Match items now carry a full snapshot and `engineVersion`; a rule change must bump the version before old logs are replayed on the new build.
- Each submitted action replays from the seed to its tick. The action cap (500) and `MAX_TICKS` bound the work; if matches get longer, state serialization or periodic snapshots become the next step.
- `mapSize=1` is a browser-only world-scale toggle and does not appear in online settings; online matches always replay at the default scale.
