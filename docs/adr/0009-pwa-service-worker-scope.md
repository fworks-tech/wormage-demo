# 0009. One root service worker, owned by the PWA in production

- **Status:** Accepted
- **Date:** 2026-11-26
- **Supersedes:** none

## Context

Issue #169 needs an offline app shell and a service worker that Android Chrome can turn into a WebAPK. MSW already registers `public/mockServiceWorker.js` at scope `/` in development and in the standard Vercel build. A browser can have only one service worker controlling a given scope, so registering a second root worker would either fail or take control away from MSW and stop mock requests from being intercepted.

The existing API layer already has two transports: MSW over the network and an in-process Axios adapter that calls the same `mockServer` fixtures. The single-file build uses the in-process adapter because sandboxed previews have no service workers.

## Decision

`initApiLayer()` picks the in-process adapter for production builds unless `VITE_API_BASE_URL` selects the live API. Development keeps MSW, so the existing unit and E2E suites still exercise the network-level mocks. The PWA worker is registered only when MSW is not active and the build is not `--mode single`.

`public/sw.js` precaches the shell and the hashed production assets injected by the Vite build. Navigations are network-first with a cached `index.html` fallback; other same-origin static requests are cache-first. `/api/` and `/mockServiceWorker.js` bypass the cache entirely. Each registration adds a build id query parameter to the worker URL, so a deploy installs a new worker, deletes old `wormage-shell-*` caches, skips waiting and claims clients immediately.

## Alternatives considered

| Option | Why Considered | Why Rejected |
|--------|---------------|-------------|
| Register the PWA worker alongside MSW | No mock-transport change | Two workers cannot control the same scope; mocks would break |
| Edit the generated MSW worker to cache the shell | Keeps MSW in production | MSW regenerates the file; caching rules would be coupled to a dependency |
| Enable the PWA only outside MSW | Smallest change | The deployed demo would still have no offline shell or WebAPK |

## Consequences

**Positive:** the deployed demo gets an offline shell and can mint an Android WebAPK. Live API and mock data share the same fixtures, and API responses are never served from the shell cache. A new deploy replaces old caches instead of stranding users on an old build.

**Negative:** production no longer exercises the MSW network path; it uses the in-process adapter. Two transports remain, and the PWA worker adds a build-time injection step plus one E2E spec that runs against a separate local-API dev server.

## References

- Issue [#169](https://github.com/fworks-tech/wormage-demo/issues/169)
- [ADR 0003](0003-server-authoritative-online.md) — live API authority
- [DECISIONS §6](../DECISIONS.md#6-msw-in-dev-an-in-process-adapter-for-the-single-file-build)
