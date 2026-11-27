import { beforeEach, expect, test } from 'vitest';
import { listMatchesCursor, resetMockData, registerMatch } from '../../src/api/mockServer';

beforeEach(() => resetMockData());

function seed(playerId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const r = registerMatch({
      clientMatchId: `c-${playerId}-${i}`,
      playerId,
      playerName: 'P',
      teamName: 'T',
      score: i,
      durationSeconds: 60,
      endReason: 'wipeout',
      turnSeconds: 45,
      wind: 'light',
      difficulty: 'veteran',
      kills: 0,
    });
    if (!('record' in r)) throw new Error('seed failed');
  }
}

test('cursor paginates without overlap and ends with null nextCursor', () => {
  seed('p-cursor', 5);
  const p1 = listMatchesCursor('p-cursor', 2);
  expect(p1.items).toHaveLength(2);
  expect(p1.nextCursor).toBeTruthy();
  const p2 = listMatchesCursor('p-cursor', 2, p1.nextCursor);
  expect(p2.items).toHaveLength(2);
  const ids1 = new Set(p1.items.map((m) => m.id));
  for (const m of p2.items) expect(ids1.has(m.id)).toBe(false);
  const p3 = listMatchesCursor('p-cursor', 2, p2.nextCursor);
  expect(p3.items).toHaveLength(1);
  expect(p3.nextCursor).toBeNull();
});

test('invalid cursor throws', () => {
  seed('p-bad', 1);
  expect(() => listMatchesCursor('p-bad', 2, '!!!not-base64')).toThrow();
  const wrongShape = btoa(JSON.stringify({ createdAt: 'x' }));
  expect(() => listMatchesCursor('p-bad', 2, wrongShape)).toThrow();
});
