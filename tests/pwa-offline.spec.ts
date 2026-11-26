import { expect, test } from '@playwright/test';

const LOCAL_API_URL = 'http://localhost:5184';

test('the shell loads offline after one visit and recovers online', async ({ page, context }) => {
  await page.goto(`${LOCAL_API_URL}/demo?seed=4242`);
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
      if (await cache.match('/api/leaderboard')) return true;
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
