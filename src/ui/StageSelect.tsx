import { loadProgress, isUnlocked, STAGES, type Stage } from '../state/stages';
import type { GameSettings } from '../game/types';

interface Props {
  settings: GameSettings;
  onSaveSettings: (s: GameSettings) => void;
  onStart: () => void;
  onClose: () => void;
}

export function StageSelect({ settings, onSaveSettings, onStart, onClose }: Props) {
  const progress = loadProgress();
  const startStage = (stage: Stage) => {
    if (!isUnlocked(stage, progress)) return;
    onSaveSettings({
      ...settings,
      map: stage.map,
      mode: stage.mode,
      difficulty: stage.difficulty,
      wormsPerTeam: stage.wormsPerTeam,
    });
    localStorage.setItem('wormage.currentStage', stage.id);
    onStart();
  };
  return (
    <div className="dialog" role="dialog" aria-label="Stages">
      <h2>STAGES</h2>
      <ul>
        {STAGES.map((stage) => {
          const unlocked = isUnlocked(stage, progress);
          const done = Boolean(progress[stage.id]);
          return (
            <li key={stage.id}>
              <button
                type="button"
                disabled={!unlocked}
                onClick={() => startStage(stage)}
                data-testid={`stage-${stage.id}`}
              >
                {stage.name} {done ? '✓' : unlocked ? '' : '🔒'}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={onClose} data-testid="stage-close">Close</button>
    </div>
  );
}
