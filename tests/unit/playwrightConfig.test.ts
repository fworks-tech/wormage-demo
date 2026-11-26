import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { resolveWorkers } from '../../playwright.config';

test('CI runs the PR smoke selection with one worker', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('PW_WORKERS=1 npm run test:smoke');
});

test('CI shards the full browser matrix into four serial jobs', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  expect(workflow).toContain("contains(github.event.pull_request.labels.*.name, 'ci:full')");
  expect(workflow).toContain('[1,2,3,4]');
  expect(workflow).toContain('PW_WORKERS=1 npm run test:e2e -- --shard=');
  expect(workflow).toContain('playwright-report-${{ matrix.shard }}');
});

test('Playwright defaults to a bounded parallel worker count', () => {
  expect(resolveWorkers(undefined, 2)).toBe(1);
  expect(resolveWorkers(undefined, 4)).toBe(3);
  expect(resolveWorkers(undefined, 16)).toBe(4);
});

test('PW_WORKERS explicitly restores serial debugging or raises the cap', () => {
  expect(resolveWorkers('1', 16)).toBe(1);
  expect(resolveWorkers('6', 16)).toBe(6);
});

test('PW_WORKERS rejects values that cannot describe a worker count', () => {
  for (const value of ['', '0', '-1', '1.5', 'many']) {
    expect(() => resolveWorkers(value, 16)).toThrow(/positive integer/);
  }
});
