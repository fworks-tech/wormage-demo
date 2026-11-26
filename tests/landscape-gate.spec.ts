import { expect, test } from '@playwright/test';

test.describe('landscape gate', () => {
  test.use({ viewport: { width: 412, height: 839 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });

  test('a touch match freezes in portrait and resumes in landscape', async ({ page }) => {
    // Production always gates; dev opts in so the portrait layout suites still run.
    await page.goto('/demo?seed=4242&landscapeGate=1');
    await page.getByTestId('btn-play').click();

    const gate = page.getByTestId('rotate-gate');
    await expect(gate).toBeVisible();

    const tick = () =>
      page.evaluate(() => (window as never as { __WORMAGE__: { engine: { tick: number } } }).__WORMAGE__.engine.tick);
    const frozen = await tick();
    await page.waitForTimeout(300);
    expect(await tick(), 'the simulation stays frozen while the device is portrait').toBe(frozen);

    await page.setViewportSize({ width: 839, height: 412 });
    await expect(gate).toBeHidden();
    await expect.poll(() => tick()).toBeGreaterThan(frozen);

    await page.setViewportSize({ width: 412, height: 839 });
    await expect(gate).toBeVisible();
    const pausedAgain = await tick();
    await page.waitForTimeout(300);
    expect(await tick(), 'rotating back to portrait freezes it again').toBe(pausedAgain);
  });
});
