import { api } from './client';
import type { GameEngine } from '../game/engine';
import type { DebugLogEntry } from '../game/types';

export interface DebugLogPayload {
  schemaVersion: number;
  sessionId: string;
  matchId: string;
  createdAt: string;
  expiresAt: string;
  chunk?: number;
  totalChunks?: number;
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

export async function flushDebugLog(engine: GameEngine): Promise<boolean> {
  const entries = [...engine.debugLog];
  const snapshots = [...engine.debugSnapshots];
  if (entries.length === 0 && snapshots.length === 0) return true;

  const now = new Date();
  const expires = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const totalChunks = Math.max(
    1,
    Math.ceil(entries.length / ENTRY_CHUNK_SIZE) + Math.ceil(snapshots.length / SNAPSHOT_CHUNK_SIZE),
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
