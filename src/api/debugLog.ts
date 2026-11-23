import { byteSize } from './bytes';
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
// Keep each request comfortably under the server-side cap (256 KB) with margin,
// even when individual entries or snapshots are large.
const TARGET_CHUNK_BYTES = 200_000;

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
  const flushId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID()
    : `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const skeleton = {
    schemaVersion: 1,
    sessionId: engine.sessionId,
    matchId: engine.matchId,
    flushId,
    chunk: 1,
    totalChunks: 1,
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
    entries: [] as DebugLogEntry[],
    snapshots: [] as Array<{ reason: string; snapshot: unknown }>,
  };

  // Build byte-bounded chunks so a single request never exceeds the server cap,
  // even when individual entries or snapshots are large. Entries and snapshots
  // share one budget per request.
  const chunks: Array<{ entries: DebugLogEntry[]; snapshots: Array<{ reason: string; snapshot: unknown }> }> = [];
  let ei = 0;
  let si = 0;
  while (ei < entries.length || si < snapshots.length) {
    const ce: DebugLogEntry[] = [];
    const cs: Array<{ reason: string; snapshot: unknown }> = [];
    while (ei < entries.length && ce.length < ENTRY_CHUNK_SIZE) {
      const candidate = [...ce, entries[ei]];
      const testPayload = { ...skeleton, entries: candidate, snapshots: cs };
      if (ce.length > 0 && byteSize(JSON.stringify(testPayload)) > TARGET_CHUNK_BYTES) break;
      ce.push(entries[ei]);
      ei += 1;
      if (ce.length === 1 && byteSize(JSON.stringify({ ...skeleton, entries: ce, snapshots: cs })) > TARGET_CHUNK_BYTES) break;
    }
    while (si < snapshots.length && cs.length < SNAPSHOT_CHUNK_SIZE) {
      const candidate = [...cs, snapshots[si]];
      const testPayload = { ...skeleton, entries: ce, snapshots: candidate };
      if (cs.length > 0 && byteSize(JSON.stringify(testPayload)) > TARGET_CHUNK_BYTES) break;
      cs.push(snapshots[si]);
      si += 1;
      if (cs.length === 1 && byteSize(JSON.stringify({ ...skeleton, entries: ce, snapshots: cs })) > TARGET_CHUNK_BYTES) break;
    }
    if (ce.length === 0 && cs.length === 0) {
      if (ei < entries.length) { ce.push(entries[ei]); ei += 1; }
      else if (si < snapshots.length) { cs.push(snapshots[si]); si += 1; }
    }
    chunks.push({ entries: ce, snapshots: cs });
  }
  if (chunks.length === 0) chunks.push({ entries: [], snapshots: [] });

  const totalChunks = chunks.length;
  let chunkNumber = 1;

  for (const chunk of chunks) {
    const chunkEntries = chunk.entries;
    const chunkSnapshots = chunk.snapshots;
    const payload: DebugLogPayload = {
      ...skeleton,
      flushId,
      chunk: chunkNumber,
      totalChunks,
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
    chunkNumber += 1;
  }

  return true;
}
