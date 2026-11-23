import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import type { GameScreenshot } from '../../src/api/types';
import type { DebugLogEntry, MatchConfig } from '../../src/game/types';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../../src/api/client', () => ({ api: { post } }));

import { BugReportUnavailableError, ReportTooLargeError, buildBugReport, sendBugReport } from '../../src/api/bugReport';

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  turnSeconds: 30,
  wind: 'light',
  difficulty: 'veteran',
  seed: 4242,
  wormsPerTeam: 2,
  ...overrides,
});

const shot = (): GameScreenshot => ({
  dataUrl: 'data:image/png;base64,AAAA',
  mime: 'image/png',
  width: 1280,
  height: 720,
  bytes: 3,
});

const entry = (engine: GameEngine, seq: number, blob = ''): DebugLogEntry => ({
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
  data: blob ? { blob } : undefined,
});

describe('bug report payload', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ status: 201, data: { reportId: 'r1' } });
    vi.stubGlobal('window', {
      location: { href: 'https://wormage.flabs.tech/demo?seed=4242' },
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 2,
      __WORMAGE__: { version: '9.9.9' },
    });
    vi.stubGlobal('navigator', { userAgent: 'test-agent', language: 'pt-BR' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('captures the seed, environment and current state', () => {
    const engine = new GameEngine(config());
    const payload = buildBugReport({ engine, note: '  worm floats  ', screenshot: shot() });

    expect(payload.schemaVersion).toBe(1);
    expect(payload.reportId).toBeTruthy();
    expect(payload.note).toBe('worm floats');
    expect(payload.sessionId).toBe(engine.sessionId);
    expect(payload.matchId).toBe(engine.matchId);
    expect(payload.mode).toBe('local');
    expect(payload.url).toContain('seed=4242');
    expect(payload.appVersion).toBe('9.9.9');
    expect(payload.userAgent).toBe('test-agent');
    expect(payload.viewport).toEqual({ width: 1280, height: 720, dpr: 2 });
    expect(payload.engine.seed).toBe(4242);
    expect(payload.engine.snapshot.phase).toBe('aim');
    expect(payload.screenshot?.data).toBe('AAAA');
    expect(payload.screenshot?.mime).toBe('image/png');
  });

  test('caps the note and debug history', () => {
    const engine = new GameEngine(config());
    engine.debugLog = Array.from({ length: 1205 }, (_, i) => entry(engine, i));
    for (let i = 0; i < 25; i += 1) engine.captureDebugSnapshot(`snap-${i}`);

    const payload = buildBugReport({ engine, note: 'x'.repeat(2500), screenshot: null });

    expect(payload.note).toHaveLength(2000);
    expect(payload.debug.entries).toHaveLength(1000);
    expect(payload.debug.entries.at(-1)?.seq).toBe(1204);
    expect(payload.debug.snapshots).toHaveLength(20);
    expect(payload.debug.snapshots.at(-1)?.reason).toBe('snap-24');
  });

  test('keeps the action log only for online matches', () => {
    const engine = new GameEngine(config());
    engine.log.push({ tick: 1, action: { type: 'endTurn' } });

    expect(buildBugReport({ engine, note: '', screenshot: null }).actionLog).toHaveLength(0);

    const online = buildBugReport({
      engine,
      note: '',
      screenshot: null,
      online: { code: 'ABC123', playerId: 'p1' },
    });
    expect(online.mode).toBe('online');
    expect(online.online).toEqual({ code: 'ABC123', playerId: 'p1' });
    expect(online.actionLog).toHaveLength(1);
  });

  test('posts the report and returns the server id', async () => {
    const engine = new GameEngine(config());
    await expect(sendBugReport({ engine, note: '', screenshot: shot() })).resolves.toBe('r1');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/api/bug-reports');
    expect((post.mock.calls[0][1] as { screenshot: { data: string } }).screenshot.data).toBe('AAAA');
  });

  test('throws when the server rejects the report', async () => {
    post.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 503 } }));
    const engine = new GameEngine(config());
    await expect(sendBugReport({ engine, note: '', screenshot: null })).rejects.toThrow('could not be sent');
  });

  test('trims large reports before upload but keeps the screenshot', async () => {
    const engine = new GameEngine(config());
    engine.debugLog = Array.from({ length: 1000 }, (_, i) => entry(engine, i, 'x'.repeat(3500)));
    for (let i = 0; i < 20; i += 1) {
      engine.captureDebugSnapshot(`snap-${i}`);
      const last = engine.debugSnapshots.at(-1);
      if (last) (last as { blob?: string }).blob = 'y'.repeat(60000);
    }
    for (let i = 0; i < 5000; i += 1) engine.log.push({ tick: i, action: { type: 'endTurn' } });

    await sendBugReport({
      engine,
      note: '',
      screenshot: shot(),
      online: { code: 'ABC123', playerId: 'p1' },
    });

    const body = post.mock.calls[0][1] as {
      screenshot: { data: string } | null;
      debug: { entries: unknown[]; snapshots: unknown[] };
      actionLog: unknown[];
    };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    expect(bytes).toBeLessThanOrEqual(3_900_000);
    expect(body.screenshot?.data).toBe('AAAA');
    expect(body.debug.snapshots).toHaveLength(0);
    expect(body.debug.entries.length).toBeLessThanOrEqual(200);
  });

  test('reports an oversized payload as too large', async () => {
    const engine = new GameEngine(config());
    const huge = { ...shot(), dataUrl: `data:image/png;base64,${'A'.repeat(4_200_000)}`, bytes: 3_150_000 };
    await expect(sendBugReport({ engine, note: '', screenshot: huge })).rejects.toBeInstanceOf(ReportTooLargeError);
    expect(post).not.toHaveBeenCalled();
  });

  test('treats a disabled endpoint as temporarily unavailable', async () => {
    post.mockResolvedValue({ status: 202, data: { stored: false, reason: 'disabled' } });
    const engine = new GameEngine(config());
    await expect(sendBugReport({ engine, note: '', screenshot: null })).rejects.toBeInstanceOf(BugReportUnavailableError);
  });
});
