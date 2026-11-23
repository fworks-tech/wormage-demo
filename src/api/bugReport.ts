import { byteSize } from './bytes';
import { api } from './client';
import type { GameScreenshot } from './types';
import type { GameEngine } from '../game/engine';
import type { ActionLogEntry, DebugLogEntry, GameSnapshot, MatchConfig } from '../game/types';

interface BugReportPayload {
  schemaVersion: 1;
  reportId: string;
  createdAt: string;
  note: string;
  sessionId: string;
  matchId: string;
  mode: 'local' | 'online';
  online: { code: string; playerId: string } | null;
  url: string;
  appVersion: string;
  userAgent: string;
  language: string;
  timezone: string;
  viewport: { width: number; height: number; dpr: number };
  engine: {
    seed: number;
    config: MatchConfig;
    tick: number;
    elapsed: number;
    phase: string;
    snapshot: GameSnapshot;
  };
  debug: {
    entries: DebugLogEntry[];
    snapshots: Array<{ reason: string; snapshot: GameSnapshot }>;
  };
  actionLog: ActionLogEntry[];
  screenshot: {
    mime: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
    data: string;
  } | null;
}

interface BugReportOptions {
  engine: GameEngine;
  note: string;
  screenshot: GameScreenshot | null;
  online?: { code: string; playerId: string } | null;
  appVersion?: string;
}

const MAX_NOTE = 2000;
const MAX_DEBUG_ENTRIES = 1000;
const MAX_DEBUG_SNAPSHOTS = 20;
const MAX_ACTION_LOG = 5000;
// The Lambda accepts 4 MB; keep a margin for the transport overhead.
const MAX_BODY_BYTES = 3_900_000;

function reportId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build the payload without touching network state, so it is unit-testable. */
export function buildBugReport({
  engine,
  note,
  screenshot,
  online,
  appVersion,
}: BugReportOptions): BugReportPayload {
  const win = typeof window !== 'undefined' ? window : null;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const version = appVersion
    ?? (win as unknown as { __WORMAGE__?: { version?: string } } | null)?.__WORMAGE__?.version
    ?? 'unknown';

  return {
    schemaVersion: 1,
    reportId: reportId(),
    createdAt: new Date().toISOString(),
    note: note.trim().slice(0, MAX_NOTE),
    sessionId: engine.sessionId,
    matchId: engine.matchId,
    mode: online ? 'online' : 'local',
    online: online ?? null,
    url: win?.location.href ?? '',
    appVersion: version,
    userAgent: nav?.userAgent ?? '',
    language: nav?.language ?? '',
    timezone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return '';
      }
    })(),
    viewport: {
      width: win?.innerWidth ?? 0,
      height: win?.innerHeight ?? 0,
      dpr: win?.devicePixelRatio ?? 1,
    },
    engine: {
      seed: engine.config.seed,
      config: { ...engine.config },
      tick: engine.tick,
      elapsed: engine.elapsed,
      phase: engine.phase,
      snapshot: engine.snapshot(),
    },
    debug: {
      entries: engine.debugLog.slice(-MAX_DEBUG_ENTRIES),
      snapshots: engine.debugSnapshots.slice(-MAX_DEBUG_SNAPSHOTS),
    },
    actionLog: online ? engine.log.slice(-MAX_ACTION_LOG) : [],
    screenshot: screenshot
      ? {
          mime: screenshot.mime,
          width: screenshot.width,
          height: screenshot.height,
          data: screenshot.dataUrl.includes(',')
            ? screenshot.dataUrl.slice(screenshot.dataUrl.indexOf(',') + 1)
            : screenshot.dataUrl,
        }
      : null,
  };
}

export class ReportTooLargeError extends Error {
  constructor() {
    super('This report is too large to upload');
    this.name = 'ReportTooLargeError';
  }
}

export class BugReportUnavailableError extends Error {
  constructor() {
    super('Bug reporting is temporarily unavailable');
    this.name = 'BugReportUnavailableError';
  }
}

/** Drop optional context, never the screenshot, until the body fits. */
function fitPayload(payload: BugReportPayload): void {
  if (byteSize(JSON.stringify(payload)) <= MAX_BODY_BYTES) return;
  payload.debug.snapshots = [];
  if (byteSize(JSON.stringify(payload)) <= MAX_BODY_BYTES) return;
  payload.debug.entries = payload.debug.entries.slice(-200);
  if (byteSize(JSON.stringify(payload)) <= MAX_BODY_BYTES) return;
  payload.actionLog = [];
  if (byteSize(JSON.stringify(payload)) <= MAX_BODY_BYTES) return;
  throw new ReportTooLargeError();
}

export async function sendBugReport(options: BugReportOptions): Promise<string> {
  const payload = buildBugReport(options);
  fitPayload(payload);
  try {
    const response = await api.post<{ reportId?: string; stored?: boolean }>(
      '/api/bug-reports',
      payload,
      { timeout: 60_000 },
    );
    if (response.data?.stored === false) throw new BugReportUnavailableError();
    return response.data?.reportId ?? payload.reportId;
  } catch (err) {
    if (err instanceof ReportTooLargeError || err instanceof BugReportUnavailableError) throw err;
    throw new Error('The report could not be sent');
  }
}
