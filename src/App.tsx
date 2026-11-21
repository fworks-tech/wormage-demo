import { useCallback, useRef, useState } from 'react';
import { GameView } from './ui/GameView';
import { MainMenu } from './ui/MainMenu';
import { NewGameMenu } from './ui/NewGameMenu';
import { ResultScreen } from './ui/ResultScreen';
import { enterDemoFullscreen } from './ui/fullscreen';
import {
  loadBindings,
  loadLastResult,
  loadPlayer,
  loadSettings,
  saveBindings,
  saveLastResult,
  saveSettings,
} from './state/storage';
import { useRegisterMatch } from './api/queries';
import type { GameSettings } from './game/types';
import type { Bindings } from './state/bindings';
import { completeStage, nextStage } from './state/stages';
import type { Stage } from './state/stages';
import type { Screen, SessionResult } from './types';

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `match-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings());
  const [bindings, setBindings] = useState<Bindings>(() => loadBindings());
  const [player] = useState(() => loadPlayer());
  const [screen, setScreen] = useState<Screen>('menu');
  const [matchKey, setMatchKey] = useState(0);
  const [result, setResult] = useState<SessionResult | null>(() => loadLastResult<SessionResult>());
  const clientMatchId = useRef<string>('');
  const register = useRegisterMatch();

  const startMatch = useCallback(() => {
    // Start and Play Again are the user gesture the Fullscreen API requires.
    void enterDemoFullscreen();
    clientMatchId.current = newClientId();
    register.reset();
    setMatchKey((key) => key + 1);
    setScreen('game');
  }, [register]);

  const submitResult = useCallback(
    (finished: SessionResult) => {
      if (finished.config.hotseat) return;
      register.mutate({
        clientMatchId: clientMatchId.current || newClientId(),
        playerId: player.id,
        playerName: player.name,
        teamName: settings.teamNames?.[0] ?? 'Ironclad',
        score: finished.score,
        durationSeconds: finished.durationSeconds,
        endReason: finished.endReason,
        turnSeconds: finished.config.turnSeconds,
        wind: finished.config.wind,
        difficulty: finished.config.difficulty,
        map: finished.config.map,
        mode: finished.config.mode,
        loadout: finished.config.loadout,
        kills: finished.kills,
      });
    },
    [player.id, player.name, register, settings],
  );

  const handleFinish = useCallback(
    (finished: SessionResult) => {
      const currentStage = localStorage.getItem('wormage.currentStage');
      const withStage: SessionResult = currentStage
        ? { ...finished, stageId: currentStage }
        : finished;
      if (currentStage && finished.winnerTeam === 0) completeStage(currentStage);
      localStorage.removeItem('wormage.currentStage');
      setResult(withStage);
      saveLastResult(withStage);
      setScreen('result');
      submitResult(withStage);
    },
    [submitResult],
  );

  const handleNextStage = useCallback(
    (stage: Stage) => {
      const nextSettings: GameSettings = {
        ...settings,
        map: stage.map,
        mode: stage.mode,
        difficulty: stage.difficulty,
        wormsPerTeam: stage.wormsPerTeam,
      };
      setSettings(nextSettings);
      saveSettings(nextSettings);
      localStorage.setItem('wormage.currentStage', stage.id);
      startMatch();
    },
    [settings, startMatch],
  );

  const handleNextStageClick = useCallback(() => {
    const next = result?.stageId ? nextStage(result.stageId) : null;
    if (next) handleNextStage(next);
  }, [result, handleNextStage]);

  const handleSaveSettings = useCallback((next: GameSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const handleSaveBindings = useCallback((next: Bindings) => {
    setBindings(next);
    saveBindings(next);
  }, []);

  // Two static routes: /project is the informational page, everything else plays.
  if (window.location.pathname.startsWith('/project')) {
    return (
      <div className="app">
        <MainMenu
          settings={settings}
          player={player}
          lastResult={result}
          onStart={() => window.location.assign('/demo')}
          onSaveSettings={handleSaveSettings}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {screen === 'menu' && (
        <NewGameMenu
          onStart={startMatch}
          settings={settings}
          onSaveSettings={handleSaveSettings}
          bindings={bindings}
          onSaveBindings={handleSaveBindings}
        />
      )}

      {screen === 'game' && (
        <GameView
          key={matchKey}
          settings={settings}
          bindings={bindings}
          onSaveSettings={handleSaveSettings}
          onSaveBindings={handleSaveBindings}
          onFinish={handleFinish}
          onRestart={startMatch}
          onExit={() => setScreen('menu')}
        />
      )}

      {screen === 'result' && result && (
        <ResultScreen
          result={result}
          saving={register.isPending}
          saved={register.isSuccess}
          saveError={register.isError}
          onRetry={() => result && submitResult(result)}
          onPlayAgain={startMatch}
          onChangeSetup={() => setScreen('menu')}
          onMenu={() => window.location.assign('/project')}
          nextStage={result.stageId ? nextStage(result.stageId) : null}
          isStage={Boolean(result.stageId)}
          onNextStage={handleNextStageClick}
        />
      )}
    </div>
  );
}
