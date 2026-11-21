import { api } from './client';
import type { GameEngine } from '../game/engine';
import type { DebugLogEntry } from '../game/types';

export interface DebugLogPayload {
  schemaVersion: number;
  sessionId: string;
  matchId: string;
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

export async function flushDebugLog(engine: GameEngine): Promise<boolean> {
  const entries = [...engine.debugLog];
  const snapshots = [...engine.debugSnapshots];
  if (entries.length === 0 && snapshots.length === 0) return true;

  const now = new Date();
  const expires = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const payload: DebugLogPayload = {
    schemaVersion: 1,
    sessionId: engine.sessionId,
    matchId: engine.matchId,
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
    entries,
    snapshots,
  };

  try {
    const response = await api.post('/api/debug-logs', payload);
    if (response.status >= 200 && response.status < 300) {
      engine.clearDebugLog();
      engine.clearDebugSnapshots();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
