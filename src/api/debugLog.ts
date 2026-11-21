import { api } from './client';
import type { GameEngine } from '../game/engine';
import type { DebugLogEntry } from '../game/types';

export interface DebugLogPayload {
  schemaVersion: number;
  sessionId: string;
  matchId: string;
  flushId: string;
  chunk: number;
  totalChunks: number;
  createdAt: string;
  expiresAt: string;
  session: {
    seed: number;
    teamCount: number;
    wormsPerTeam: number;
    map: string;
    mode: string;
    turnSeconds: number;
    wind: string;
    difficulty: string;
  };
  entries: DebugLogEntry[];
  snapshots: Array<{ reason: string; snapshot: unknown }>;
}

const RETENTION_DAYS = 7;

const ENTRY_CHUNK_SIZE = 500;
const SNAPSHOT_CHUNK_SIZE = 20;

// Flushes fire from the interval, the visibility handler, the finish path and cleanup.
// Serializing per engine stops two uploads from snapshotting and splicing the same entries.
const inFlight = new WeakMap<GameEngine, Promise<boolean>>();

export function flushDebugLog(engine: GameEngine): Promise<boolean> {
  const previous = inFlight.get(engine) ?? Promise.resolve(true);
  const run = previous.then(
    () => sendDebugLog(engine),
    () => sendDebugLog(engine),
  );
  inFlight.set(engine, run);
  void run.finally(() => {
    if (inFlight.get(engine) === run) inFlight.delete(engine);
  });
  return run;
}

async function sendDebugLog(engine: GameEngine): Promise<boolean> {
  const entries = [...engine.debugLog];
  const snapshots = [...engine.debugSnapshots];
  if (entries.length === 0 && snapshots.length === 0) return true;

  const now = new Date();
  const expires = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // A fresh id per flush keeps S3 keys unique across periodic and final uploads.
  // randomUUID needs a secure context; fall back for file:// and sandboxed previews.
  const flushId = crypto.randomUUID?.() ?? `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Each request carries one entry slice and one snapshot slice, so the request
  // count is the larger of the two, not their sum.
  const totalChunks = Math.max(
    1,
    Math.ceil(entries.length / ENTRY_CHUNK_SIZE),
    Math.ceil(snapshots.length / SNAPSHOT_CHUNK_SIZE),
  );
  let chunkNumber = 1;
  let entriesSent = 0;
  let snapshotsSent = 0;

  while (entriesSent < entries.length || snapshotsSent < snapshots.length) {
    const chunkEntries = entries.slice(entriesSent, entriesSent + ENTRY_CHUNK_SIZE);
    const chunkSnapshots = snapshots.slice(snapshotsSent, snapshotsSent + SNAPSHOT_CHUNK_SIZE);
    const payload: DebugLogPayload = {
      schemaVersion: 1,
      sessionId: engine.sessionId,
      matchId: engine.matchId,
      flushId,
      chunk: chunkNumber,
      totalChunks,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      session: {
        seed: engine.config.seed,
        teamCount: engine.teams.length,
        wormsPerTeam: engine.config.wormsPerTeam,
        map: engine.config.map ?? 'island',
        mode: engine.config.mode ?? 'deathmatch',
        turnSeconds: engine.config.turnSeconds,
        wind: engine.config.wind,
        difficulty: engine.config.difficulty,
      },
      entries: chunkEntries,
      snapshots: chunkSnapshots,
    };

    try {
      const response = await api.post('/api/debug-logs', payload);
      if (response.status < 200 || response.status >= 300) return false;
    } catch {
      return false;
    }

    engine.debugLog.splice(0, chunkEntries.length);
    engine.debugSnapshots.splice(0, chunkSnapshots.length);
    entriesSent += chunkEntries.length;
    snapshotsSent += chunkSnapshots.length;
    chunkNumber += 1;
  }

  return true;
}
