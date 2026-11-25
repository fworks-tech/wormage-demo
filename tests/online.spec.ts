import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('e2e-cleared')) {
      window.sessionStorage.setItem('e2e-cleared', '1');
      window.localStorage.clear();
    }
  });
});

test('@smoke can create and join an online match', async ({ page }) => {
  await page.goto('/demo?seed=4242');
  await page.getByTestId('btn-online').click();
  await page.getByTestId('btn-create-online').click();
  await expect(page.getByTestId('online-code')).toBeVisible({ timeout: 5000 });
  const code = await page.getByTestId('online-code').textContent();
  expect(code?.trim()).toMatch(/^[A-Z2-9]{6}$/);

  await page.evaluate(async (matchCode) => {
    const response = await fetch(`/api/matches/online/${matchCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'e2e-bob', playerName: 'Bob' }),
    });
    if (!response.ok) throw new Error('Bob could not join');
  }, code!.trim());
  await expect(page.getByTestId('btn-start-online')).toBeVisible({ timeout: 5000 });
});

test('@smoke a shot hands the online turn to the other human before the timer', async ({ page }) => {
  await page.goto('/demo?seed=4242');
  await page.getByTestId('btn-online').click();
  await page.getByTestId('btn-create-online').click();
  await expect(page.getByTestId('online-code')).toBeVisible({ timeout: 5000 });
  const code = (await page.getByTestId('online-code').textContent())!.trim();

  await page.evaluate(async (matchCode) => {
    const response = await fetch(`/api/matches/online/${matchCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'e2e-bob', playerName: 'Bob' }),
    });
    if (!response.ok) throw new Error('Bob could not join');
  }, code);
  await expect(page.getByTestId('btn-start-online')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('btn-start-online').click();
  await expect(page.getByTestId('arena').locator('canvas')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));

  const isAi = await page.evaluate(() =>
    (window as never as { __WORMAGE__: { snapshot: () => { teams: Array<{ isAi: boolean }> } } }).__WORMAGE__
      .snapshot().teams.map((team) => team.isAi),
  );
  expect(isAi).toEqual([false, false]);

  if (test.info().project.name === 'desktop') {
    await page.keyboard.down('Space');
    await page.waitForFunction(() =>
      (window as never as { __WORMAGE__: { snapshot: () => { power: number } } }).__WORMAGE__.snapshot().power > 0.1,
    );
    await page.keyboard.up('Space');
  } else {
    await page.getByTestId('btn-fire').click();
  }

  await page.waitForFunction(
    () => (window as never as { __WORMAGE__: { snapshot: () => { turn: number } } }).__WORMAGE__.snapshot().turn >= 2,
    undefined,
    { timeout: 15000 },
  );
  await page.waitForFunction(async (matchCode) => {
    const response = await fetch(`/api/matches/online/${matchCode}`);
    const { match } = await response.json() as { match: { activeTeam: number; phase: string } };
    return match.activeTeam === 1 && match.phase === 'aim';
  }, code, { timeout: 15000 });
});
