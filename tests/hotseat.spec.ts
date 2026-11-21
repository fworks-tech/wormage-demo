import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('e2e-cleared')) {
      window.sessionStorage.setItem('e2e-cleared', '1');
      window.localStorage.clear();
    }
  });
});

const startHotseat = async (page: Page) => {
  await page.goto('/demo?seed=4242');
  await page.getByTestId('btn-settings').click();
  await page.getByTestId('select-players').selectOption('hotseat');
  await page.getByTestId('btn-save-settings').click();
  await page.getByTestId('btn-play').click();
  await page.getByTestId('arena').locator('canvas').waitFor();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));
};

test('hotseat mode makes team 1 human and shows the handoff overlay', async ({ page }) => {
  await startHotseat(page);
  const isAi = await page.evaluate(() => (window as never as { __WORMAGE__: { snapshot: () => { teams: Array<{ isAi: boolean }> } } }).__WORMAGE__.snapshot().teams[1].isAi);
  expect(isAi).toBe(false);

  // End team 0's turn to trigger a handoff to team 1.
  await page.evaluate(() => (window as never as { __WORMAGE__: { engine: { endTurn: () => void } } }).__WORMAGE__.engine.endTurn());
  await expect(page.getByTestId('handoff-overlay')).toBeVisible();
  await page.getByTestId('btn-handoff-ready').click();
  await expect(page.getByTestId('handoff-overlay')).toHaveCount(0);
});

test('hotseat match reaches the result screen with both players scores', async ({ page }) => {
  await startHotseat(page);
  // Wipe team 1 to force a gameover on the next turn pass.
  await page.evaluate(() => {
    const w = (window as never as { __WORMAGE__: { engine: { teams: Array<{ worms: Array<{ alive: boolean; hp: number }> }> } } }).__WORMAGE__.engine;
    for (const worm of w.teams[1].worms) {
      worm.alive = false;
      worm.hp = 0;
    }
  });
  await page.evaluate(() => (window as never as { __WORMAGE__: { engine: { endTurn: () => void } } }).__WORMAGE__.engine.endTurn());
  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('result-scores')).toBeVisible();
});
