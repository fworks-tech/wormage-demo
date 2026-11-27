# src/state — persistence

`storage.ts` and `profile.ts` own the app's persisted state. `src/api/mockServer.ts` also keeps its fixture database and demo scenario in `localStorage`. Reads are validated and writes are best-effort so private browsing or opaque-origin iframes do not crash; when storage is unavailable, persisted changes may not survive a refresh.

| Key | Contents | Consumer |
| --- | --- | --- |
| `wormage.settings.v1` | turn timer, wind, difficulty, sound | `App` via `loadSettings`/`saveSettings` |
| `wormage.player.v1` | stable player id + display name | `App`, match registration |
| `wormage.profile.v1` | versioned profile: id, name, XP, level, unlocks, mission progress | `App` through `LocalStorageProfileRepository`; mission wins write progress here, cloud sync not wired yet |
| `wormage.lastResult.v1` | last completed `SessionResult` | menu “last drop”, restored after refresh |
| `wormage.mockdb.v1` | mock matches (fixtures + player records) | `src/api/mockServer.ts` |
| `wormage.netScenario.v1` | demo network scenario | `src/api/mockServer.ts` |

## Rules

- **Validate on read.** `sanitizeSettings` clamps the turn timer to 20–90 s in 5 s steps, rejects unknown wind/difficulty values and clamps `teamCount` to 2–4.
- **Never store secrets or credentials.** Only local game data.
- **Version the keys** (`v1`) so a future schema change can migrate or discard safely.
- **Writes are best-effort.** `saveLastResult` failing must not break the result screen.
