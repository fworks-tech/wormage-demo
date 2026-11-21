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
test('winning stage 1-3 offers Next stage that starts 2-3', async ({ page }) => {
  await page.goto('/?seed=4242');
  await page.evaluate(() => localStorage.setItem('wormage.currentStage', '1-3'));
  await page.getByTestId('btn-play').click();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));

  await page.evaluate(() => {
    const e = (window as never as { __WORMAGE__: { engine: { activeTeam: number; surrender: () => void } } }).__WORMAGE__.engine;
    e.activeTeam = 1;
    e.surrender();
  });

  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('btn-next-stage')).toBeVisible();

  await page.getByTestId('btn-next-stage').click();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));

  const cfg = await page.evaluate(() => {
    const e = (window as never as { __WORMAGE__: { engine: { config: { map?: string; mode?: string; difficulty?: string; wormsPerTeam?: number } } } }).__WORMAGE__.engine;
    return e.config;
  });
  expect(cfg?.map).toBe('mesa');
  expect(cfg?.mode).toBe('assassinate');
  expect(cfg?.difficulty).toBe('veteran');
  expect(cfg?.wormsPerTeam).toBe(3);

  const cs = await page.evaluate(() => localStorage.getItem('wormage.currentStage'));
  expect(cs).toBe('2-3');
});

test('final stage shows campaign complete', async ({ page }) => {
  await page.goto('/?seed=4242');
  // unlock all by marking progress
  await page.evaluate(() => {
    localStorage.setItem('wormage.stages.v1', JSON.stringify({ '1-3': true, '2-3': true }));
    localStorage.setItem('wormage.currentStage', '3-3');
  });
  await page.getByTestId('btn-play').click();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));

  await page.evaluate(() => {
    const e = (window as never as { __WORMAGE__: { engine: { activeTeam: number; surrender: () => void } } }).__WORMAGE__.engine;
    e.activeTeam = 1;
    e.surrender();
  });

  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('campaign-complete')).toBeVisible();
  await expect(page.getByTestId('btn-next-stage')).toHaveCount(0);
});
