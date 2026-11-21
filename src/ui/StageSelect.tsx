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
    <div className="overlay-card stages-dialog" data-testid="stages-dialog">
      <p className="eyebrow">Campaign</p>
      <h2>Stages</h2>
      <p className="muted">Pick a stage. Clear one to unlock the next.</p>
      <ul className="stage-list">
        {STAGES.map((stage) => {
          const unlocked = isUnlocked(stage, progress);
          const done = Boolean(progress[stage.id]);
          return (
            <li key={stage.id}>
              <button
                type="button"
                className="stage-btn"
                disabled={!unlocked}
                onClick={() => startStage(stage)}
                data-testid={`stage-${stage.id}`}
              >
                <span className="stage-name">{stage.name}</span>
                <span className="stage-meta">
                  {done ? '✓ cleared' : unlocked ? 'available' : '🔒 locked'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="overlay-actions">
        <button type="button" className="ghost-btn" onClick={onClose} data-testid="stage-close">
          Close
        </button>
      </div>
    </div>
  );
}