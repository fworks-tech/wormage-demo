# src/api — contracts, transport and mock backend

| File | Responsibility |
| --- | --- |
| `types.ts` | `MatchRecord`, `LeaderboardRow`, `Paginated<T>`, `CursorPaginated<T>`, `NewMatchInput`, `MockScenario` |
| `mockServer.ts` | fixtures, pagination, ranking tie-break, idempotent writes, latency/failure scenarios, localStorage persistence |
| `client.ts` | Axios instances, in-process adapter, `initApiLayer()` transport selection |
| `queries.ts` | TanStack Query hooks: `useLeaderboard`, `useMatchHistory`, `useMatchHistoryCursor`, `useRegisterMatch`, query keys |
| `debugLog.ts` | chunked `POST /api/debug-logs` uploads, serialized per engine |
| `bugReport.ts` | bug-report payload, caps and `POST /api/bug-reports` upload |

## Transport selection

`initApiLayer()` (called from `main.tsx` before React mounts):

- **live:** `VITE_API_MODE=live` or `VITE_LIVE_API=true` (plus `VITE_API_BASE_URL`) → requests hit the AWS backend (`api.wormage.flabs.tech`).
- **default:** start the MSW worker → requests use the normal XHR adapter and are intercepted at the network layer.
- **`--mode single` or `VITE_LOCAL_API=true` or SW failure:** use the Axios adapter, which calls the same `mockServer` functions synchronously in the page.

All paths share request validation and state, so the demo, the tests and the deployed build behave identically (aside from real network timing).

## Contracts

```
GET  /api/leaderboard?configKey=45s-light-veteran&page=1&pageSize=8
GET  /api/matches?playerId=player-abc&page=1&pageSize=8
GET  /api/matches?playerId=player-abc&limit=8&cursor=opaque → { items, nextCursor, limit }
POST /api/matches   { clientMatchId, playerId, playerName, teamName,
                      score, durationSeconds, endReason,
                      turnSeconds, wind, difficulty, kills }
POST /api/debug-logs   { sessionId, matchId, schemaVersion, entries, snapshots, flushId, chunk }
POST /api/bug-reports  { reportId, sessionId, matchId, note, url, engine, debug, actionLog,
                         screenshot: { mime, width, height, data } }
```

- Ranking: best match per player for the requested ruleset, sorted by score desc, duration asc, `createdAt` asc. Deterministic by construction.
- History: the player's matches, newest first.
- Writes: idempotent on `clientMatchId`; duplicates return `200` with the existing record instead of `201`.

## TanStack Query behaviour

- `staleTime` 10–20 s, `retry: 1`, `placeholderData: keepPreviousData` for smooth pagination.
- Both boards are invalidated after a successful registration, so Ranking and History refresh together.
- Failures never block play: the game only needs the API on the result screen, where the user can retry with the same `clientMatchId`.

## Extending

Add a route in three places, all in this folder plus `src/mocks/handlers.ts`:

1. `types.ts` — request/response contract.
2. `mockServer.ts` — implementation and storage.
3. `handlers.ts` + `client.ts` local adapter — expose it over both transports.
