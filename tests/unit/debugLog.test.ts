import { beforeEach, describe, expect, test, vi } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import type { DebugLogEntry, MatchConfig } from '../../src/game/types';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../../src/api/client', () => ({ api: { post } }));

import { flushDebugLog } from '../../src/api/debugLog';

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  turnSeconds: 30,
  wind: 'light',
  difficulty: 'veteran',
  seed: 4242,
  wormsPerTeam: 2,
  ...overrides,
});

const entry = (engine: GameEngine, seq: number): DebugLogEntry => ({
  seq,
  sessionId: engine.sessionId,
  matchId: engine.matchId,
  t: 0,
  tick: 0,
  turn: 1,
  actorType: 'system',
  category: 'test',
  level: 'info',
  message: 'test',
});

describe('debug logging', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ status: 201, data: {} });
  });

  test('records match and turn snapshots', () => {
    const engine = new GameEngine(config());
    expect(engine.debugLog.some((entry) => entry.category === 'match.start')).toBe(true);
    expect(engine.debugLog.some((entry) => entry.category === 'turn.start')).toBe(true);
    expect(engine.debugSnapshots.some((snapshot) => snapshot.reason === 'match.start')).toBe(true);
    expect(engine.debugSnapshots.some((snapshot) => snapshot.reason === 'turn.start')).toBe(true);
    expect(engine.sessionId).toBeTruthy();
    expect(engine.matchId).toBeTruthy();
  });

  test('match.end snapshot records the terminal state', () => {
    const engine = new GameEngine(config());
    engine.surrender();
    const end = engine.debugSnapshots.find((snapshot) => snapshot.reason === 'match.end');
    expect(end?.snapshot.phase).toBe('gameover');
    expect(end?.snapshot.endReason).toBe('surrender');
    expect(end?.snapshot.winnerTeam).not.toBeNull();
  });

  test('clears debug state', () => {
    const engine = new GameEngine(config());
    engine.clearDebugLog();
    engine.clearDebugSnapshots();
    expect(engine.debugLog).toHaveLength(0);
    expect(engine.debugSnapshots).toHaveLength(0);
  });

  test('uploads one request per chunk and advertises the real chunk count', async () => {
    const engine = new GameEngine(config());
    engine.debugLog = Array.from({ length: 2000 }, (_, i) => ({
      ...entry(engine, i),
      data: { blob: 'x'.repeat(200) },
    }));
    engine.debugSnapshots = [{ reason: 'only', snapshot: engine.snapshot() }];

    await flushDebugLog(engine);

    expect(post.mock.calls.length).toBeGreaterThan(1);
    const payloads = post.mock.calls.map((call) => call[1] as { chunk: number; totalChunks: number; flushId: string; entries: unknown[] });
    expect(payloads.map((p) => p.chunk)).toEqual(payloads.map((_, i) => i + 1));
    expect(payloads.every((p) => p.totalChunks === payloads.length)).toBe(true);
    expect(new Set(payloads.map((p) => p.flushId)).size).toBe(1);
    expect(engine.debugLog).toHaveLength(0);
    expect(engine.debugSnapshots).toHaveLength(0);
  });

  test('serializes concurrent flushes so entries are sent once', async () => {
    const engine = new GameEngine(config());
    const results = await Promise.all([flushDebugLog(engine), flushDebugLog(engine)]);
    expect(results).toEqual([true, true]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(engine.debugLog).toHaveLength(0);
    expect(engine.debugSnapshots).toHaveLength(0);
  });
});
