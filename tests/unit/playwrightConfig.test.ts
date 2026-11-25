import { expect, test } from 'vitest';
import { resolveWorkers } from '../../playwright.config';

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
