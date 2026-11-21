import { expect, test } from '@playwright/test';

const API_BASE = process.env.VITE_API_BASE ?? 'https://api.wormage.flabs.tech';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('e2e-cleared')) {
      window.sessionStorage.setItem('e2e-cleared', '1');
      window.localStorage.clear();
    }
  });
});

test.describe('online two-browser match', () => {
  test.skip(!process.env.VITE_LIVE_API, 'requires live API mode');

  test('create, join, and poll status across two contexts', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto('/demo?seed=4242');
    await pageB.goto('/demo?seed=4242');

    // A creates a match.
    await pageA.getByTestId('btn-online').click();
    await pageA.getByTestId('btn-create-online').click();
    await expect(pageA.getByTestId('online-code')).toBeVisible({ timeout: 10000 });
    const code = (await pageA.getByTestId('online-code').textContent())!.trim();

    // B joins with the code.
    await pageB.getByTestId('btn-online').click();
    await pageB.getByTestId('input-join-code').fill(code);
    await pageB.getByTestId('btn-join-online').click();
    await expect(pageB.getByTestId('online-code')).toBeVisible({ timeout: 10000 });

    // Both see ready status.
    await expect(pageA.getByText(/ready/)).toBeVisible({ timeout: 10000 });
    await expect(pageB.getByText(/ready/)).toBeVisible({ timeout: 10000 });

    // Refresh in A resumes (code still visible).
    await pageA.reload();
    await pageA.getByTestId('btn-online').click();
    await expect(pageA.getByTestId('online-code')).toBeVisible({ timeout: 10000 });

    await ctxA.close();
    await ctxB.close();
  });
});
