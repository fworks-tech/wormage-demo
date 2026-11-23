import { expect, test, type Page } from '@playwright/test';

type Probe = {
  __captureOverlayHidden?: boolean;
};

const startMatch = async (page: Page) => {
  await page.goto('/demo?seed=4242');
  await page.getByTestId('btn-play').click();
  await expect(page.getByTestId('arena').locator('canvas')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as never as { __WORMAGE__?: unknown }).__WORMAGE__));
};

const openReport = async (page: Page) => {
  if (test.info().project.name === 'desktop') await page.keyboard.press('p');
  else await page.getByTestId('btn-pause').click();
  await page.getByTestId('btn-report').click();
  await expect(page.getByTestId('bug-report-dialog')).toBeVisible();
};

const storedReports = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('wormage.bugreports.v1') ?? '[]') as Array<{
    reportId: string;
    seed: number;
    url: string;
    note: string;
    screenshot: { mime: string; width: number; height: number; hasData: boolean } | null;
  }>);

test('a bug report carries a tab capture and leaves the pause menu out of it', async ({ page }) => {
  await page.addInitScript(() => {
    const probe = window as unknown as Probe;
    probe.__captureOverlayHidden = false;
    const media = navigator.mediaDevices;
    if (!media) return;
    Object.defineProperty(media, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        // The real picker keeps the overlay hidden for a while; wait two paints
        // so the assertion sees what the compositor would record.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        // The real picker takes focus; reproduce the blur so the panel must survive it.
        window.dispatchEvent(new Event('blur'));
        probe.__captureOverlayHidden = getComputedStyle(document.querySelector('.pause-overlay')!).visibility === 'hidden';
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext('2d')!;
        const paint = () => {
          context.fillStyle = '#2f6f4f';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#e8ad68';
          context.fillRect((Date.now() / 20) % canvas.width, 40, 40, 40);
        };
        paint();
        const stream = canvas.captureStream(30);
        // captureStream only emits when the canvas changes; keep painting so
        // requestVideoFrameCallback sees a frame in headless Chrome.
        const timer = window.setInterval(paint, 33);
        stream.getTracks()[0].addEventListener('ended', () => window.clearInterval(timer));
        (window as unknown as { __captureCanvas?: HTMLCanvasElement }).__captureCanvas = canvas;
        return stream;
      },
    });
  });

  await startMatch(page);
  await openReport(page);
  await page.getByTestId('btn-capture-report').click();

  await expect(page.getByTestId('report-preview')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Probe).__captureOverlayHidden)).toBe(true);
  await expect(page.locator('.pause-overlay')).toBeVisible();
  await expect(page.getByTestId('btn-capture-report')).toHaveText('Retake');

  await page.getByTestId('report-note').fill('worm floats above the grass');
  await page.getByTestId('btn-send-report').click();
  await expect(page.getByTestId('report-sent')).toBeVisible();

  const reports = await storedReports(page);
  expect(reports).toHaveLength(1);
  expect(reports[0].seed).toBe(4242);
  expect(reports[0].url).toContain('seed=4242');
  expect(reports[0].note).toBe('worm floats above the grass');
  expect(reports[0].screenshot).toEqual({ mime: 'image/png', width: 640, height: 360, hasData: true });
});

test('denied capture restores the menu and still sends the match data', async ({ page }) => {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    Object.defineProperty(media, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
  });

  await startMatch(page);
  await openReport(page);
  await page.getByTestId('btn-capture-report').click();

  await expect(page.getByTestId('report-error')).toContainText('cancelled');
  await expect(page.locator('.pause-overlay')).toBeVisible();
  await expect(page.getByTestId('report-preview')).toHaveCount(0);

  await page.getByTestId('report-note').fill('no screen capture');
  await page.getByTestId('btn-send-report').click();
  await expect(page.getByTestId('report-sent')).toBeVisible();

  const reports = await storedReports(page);
  expect(reports).toHaveLength(1);
  expect(reports[0].note).toBe('no screen capture');
  expect(reports[0].screenshot).toBeNull();
});
