import { useState } from 'react';
import { DIFFICULTY } from '../game/config';
import type { SessionResult } from '../types';
import type { Stage } from '../state/stages';
import { formatDuration } from './Leaderboard';
import { resultLine } from './resultLines';

interface ResultScreenProps {
  result: SessionResult;
  saving: boolean;
  saved: boolean;
  saveError: boolean;
  onRetry: () => void;
  onPlayAgain: () => void;
  onChangeSetup: () => void;
  onMenu: () => void;
  nextStage: Stage | null;
  isStage: boolean;
  onNextStage?: () => void;
}

const REASON_COPY: Record<string, string> = {
  wipeout: 'Enemy team wiped out',
  surrender: 'You called the retreat',
  time: 'Clock ran out',
};

export function ResultScreen({
  result,
  saving,
  saved,
  saveError,
  onRetry,
  onPlayAgain,
  onChangeSetup,
  onMenu,
  nextStage,
  isStage,
  onNextStage,
}: ResultScreenProps) {
  const hotseat = Boolean(result.config.hotseat);
  const won = result.playerWon;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const kills = `${result.kills} kill${result.kills === 1 ? '' : 's'}`;
  const wind = result.config.wind === 'off' ? 'no wind' : `${result.config.wind} wind`;

  const copyResult = async () => {
    const summary = `Wormage — ${won ? 'Victory' : 'Defeat'}, ${result.score} pts, ${kills}, ${formatDuration(
      result.durationSeconds,
    )}, seed ${result.config.seed}`;
    try {
      await navigator.clipboard.writeText(summary);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className="result-shell">
      <div className="result-card" data-testid="result-screen">
        <p className="eyebrow">{hotseat ? 'Match complete' : won ? 'Island secured' : 'Island lost'}</p>
        <h1>{hotseat ? (result.winnerTeam === null ? 'Draw' : result.winnerTeam === 0 ? 'Player 1 wins' : 'Player 2 wins') : won ? 'Victory' : 'Wiped out'}</h1>
        <p className="result-reason">{REASON_COPY[result.endReason] ?? result.endReason}</p>
        <p className="result-line" data-testid="result-line">
          {resultLine(result)}
        </p>

        <div className="score-block">
          <span className="score-value" data-testid="result-score">
            {result.score}
          </span>
          <span className="score-label">score</span>
        </div>

        {(hotseat || (result.config.teamCount ?? 2) > 2) && result.teamScores && result.teamScores.length > 1 && (
          <div className="score-block" data-testid="result-scores">
            <span className="score-value">
              {result.teamScores.map((s, i) => `P${i + 1} ${s}`).join(' · ')}
            </span>
            <span className="score-label">
              {result.winnerTeam === null
                ? 'draw'
                : `Player ${result.winnerTeam + 1} wins`}
            </span>
          </div>
        )}

        <p className="result-meta">
          {kills} · {formatDuration(result.durationSeconds)} · {wind} · {DIFFICULTY[result.config.difficulty].label} ·
          seed <span className="mono">{result.config.seed}</span>
        </p>

        <div className={`save-state ${saveError ? 'save-error' : ''}`} data-testid="save-state">
          {saving && <span>Filing the after-action report…</span>}
          {!saving && saved && <span>Logged to the ranking and match history.</span>}
          {!saving && saveError && (
            <span>
              Could not reach the archive.{' '}
              <button type="button" className="link-btn" onClick={onRetry} data-testid="btn-retry-save">
                Retry
              </button>
            </span>
          )}
        </div>

        <div className="result-actions">
          {isStage && won && nextStage && (
            <button type="button" className="primary-btn big" onClick={onNextStage} data-testid="btn-next-stage">
              Next stage
            </button>
          )}
          {isStage && won && !nextStage && (
            <p className="campaign-complete" data-testid="campaign-complete">
              Campaign complete
            </p>
          )}
          <button type="button" className="primary-btn big" onClick={onPlayAgain} data-testid="btn-play-again">
            Play again
          </button>
          <button type="button" className="ghost-btn" onClick={onChangeSetup} data-testid="btn-change-setup">
            Change setup
          </button>
          <button type="button" className="ghost-btn" onClick={copyResult} data-testid="btn-copy-result">
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy result'}
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={onMenu}
            disabled={saving}
            data-testid="btn-main-menu"
          >
            Main menu
          </button>
        </div>
      </div>
    </div>
  );
}
