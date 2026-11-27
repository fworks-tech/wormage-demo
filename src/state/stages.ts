import type { Difficulty, MapId, ModeId } from '../game/types';

export interface Stage {
  id: string;
  name: string;
  map: MapId;
  mode: ModeId;
  difficulty: Difficulty;
  wormsPerTeam: number;
  unlockAfter: string | null;
}

export const STAGES: Stage[] = [
  { id: '1-3', name: 'Stage 1-3', map: 'island', mode: 'deathmatch', difficulty: 'rookie', wormsPerTeam: 2, unlockAfter: null },
  { id: '2-3', name: 'Stage 2-3', map: 'mesa', mode: 'assassinate', difficulty: 'veteran', wormsPerTeam: 3, unlockAfter: '1-3' },
  { id: '3-3', name: 'Stage 3-3', map: 'canyon', mode: 'sudden-death', difficulty: 'elite', wormsPerTeam: 3, unlockAfter: '2-3' },
];

const KEY = 'wormage.stages.v1';

export function loadProgress(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function saveProgress(progress: Record<string, boolean>): void {
  try { localStorage.setItem(KEY, JSON.stringify(progress)); } catch { /* ignore */ }
}

export function resetProgress(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function isUnlocked(stage: Stage, progress: Record<string, boolean>): boolean {
  if (!stage.unlockAfter) return true;
  return Boolean(progress[stage.unlockAfter]);
}

export function getStage(id: string): Stage | undefined {
  return STAGES.find((s) => s.id === id);
}

export function nextStage(id: string): Stage | null {
  const idx = STAGES.findIndex((s) => s.id === id);
  if (idx < 0 || idx >= STAGES.length - 1) return null;
  return STAGES[idx + 1];
}

export function completeStage(id: string): void {
  const p = loadProgress();
  p[id] = true;
  saveProgress(p);
}
