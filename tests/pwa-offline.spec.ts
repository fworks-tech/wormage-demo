import { expect, test } from '@playwright/test';

test('the shell loads offline after one visit and recovers online', async ({ page, context }) => {
  // The dev-only flag skips MSW so the PWA can own the root worker scope.
  await page.goto('/demo?seed=4242&localApi=1');
  await expect(page.getByTestId('btn-play')).toBeVisible();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));

  const apiStatus = await page.evaluate(async () => {
    const response = await fetch('/api/leaderboard?page=1&pageSize=8');
    return response.status;
  });
  expect(apiStatus).toBe(200);

  const apiWasCached = await page.evaluate(async () => {
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      // Match by stored key, not by a bare path: the runtime cache keeps the
      // full request URL, so a lookup without the query string always misses.
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith('/api/')) return true;
      }
    }
    return false;
  });
  expect(apiWasCached).toBe(false);

  // The first page loads before the worker claims it; the next one fills the runtime cache.
  await page.reload();
  await expect(page.getByTestId('btn-play')).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('btn-play')).toBeVisible();

  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId('btn-play')).toBeVisible();
});
