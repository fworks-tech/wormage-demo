import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('e2e-cleared')) {
      window.sessionStorage.setItem('e2e-cleared', '1');
      window.localStorage.clear();
    }
  });
});

test('winning a stage marks it complete and unlocks the next', async ({ page }) => {
  await page.goto('/?seed=4242');
  // Pretend we launched stage 1-3.
  await page.evaluate(() => localStorage.setItem('wormage.currentStage', '1-3'));
  await page.getByTestId('btn-play').click();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));

  // Player (team 0) wins: hand the turn to the CPU, then surrender for it.
  await page.evaluate(() => {
    const e = (window as never as { __WORMAGE__: { engine: { activeTeam: number; surrender: () => void } } }).__WORMAGE__.engine;
    e.activeTeam = 1;
    e.surrender();
  });

  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 10_000 });

  // currentStage is reset after the match.
  const cs = await page.evaluate(() => localStorage.getItem('wormage.currentStage'));
  expect(cs).toBeNull();

  // Progress persisted.
  const progress = await page.evaluate(() => JSON.parse(localStorage.getItem('wormage.stages.v1') || '{}'));
  expect(progress['1-3']).toBe(true);

  // Next stage is unlocked in the StageSelect UI.
  await page.getByTestId('btn-change-setup').click();
  await page.getByTestId('btn-stages').click();
  await expect(page.getByTestId('stage-2-3')).toBeEnabled();
  await expect(page.getByTestId('stage-1-3')).toContainText('✓');
});