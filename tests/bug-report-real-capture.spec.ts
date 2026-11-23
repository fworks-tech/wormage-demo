import { expect, test } from '@playwright/test';

test.skip(!process.env.REAL_CAPTURE, 'set REAL_CAPTURE=1 to capture a real tab');

test.use({
  launchOptions: {
    args: [
      '--auto-select-tab-capture-source-by-title=Wormage',
      '--enable-usermedia-screen-capturing',
    ],
  },
});

test('a real tab capture shows the game without the pause menu', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop only');
  await page.goto('/demo?seed=4242');
  await page.getByTestId('btn-play').click();
  await expect(page.getByTestId('arena').locator('canvas')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));
  await page.keyboard.press('p');
  await page.getByTestId('btn-report').click();
  await page.getByTestId('btn-capture-report').click();
  await expect(page.getByTestId('report-preview')).toBeVisible({ timeout: 20_000 });
  const src = await page.getByTestId('report-preview').getAttribute('src');
  expect(src).toMatch(/^data:image\/png/);
  const width = await page.getByTestId('report-preview').evaluate((img) => (img as HTMLImageElement).naturalWidth);
  expect(width).toBeGreaterThanOrEqual(1000);
});
