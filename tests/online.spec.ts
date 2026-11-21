import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('e2e-cleared')) {
      window.sessionStorage.setItem('e2e-cleared', '1');
      window.localStorage.clear();
    }
  });
});

test('can create an online match and see a code', async ({ page }) => {
  await page.goto('/demo?seed=4242');
  await page.getByTestId('btn-online').click();
  await page.getByTestId('btn-create-online').click();
  await expect(page.getByTestId('online-code')).toBeVisible({ timeout: 5000 });
  const code = await page.getByTestId('online-code').textContent();
  expect(code?.trim()).toMatch(/^[A-Z2-9]{6}$/);
});
