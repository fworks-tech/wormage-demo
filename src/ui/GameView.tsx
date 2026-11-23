import { useCallback, useEffect, useRef, useState } from 'react';
import { GameEngine } from '../game/engine';
import { ArenaRenderer } from '../game/renderer';
import { flushDebugLog } from '../api/debugLog';
import { SoundKit } from '../game/audio';
import { AIM, FIXED_DT } from '../game/config';
import type { GameSettings, GameSnapshot, WeaponId } from '../game/types';
import { MOVEMENT_ALIASES, type Bindings, type MovementAliasAction } from '../state/bindings';
import type { SessionResult } from '../types';
import { BugReportDialog } from './BugReportDialog';
import { ControlsDialog } from './ControlsDialog';
import { Hud } from './Hud';
import { SettingsDialog } from './SettingsDialog';
import { captureGameTab, type GameScreenshot } from './screenCapture';
import { enterDemoFullscreen, useFullscreen } from './fullscreen';
import { useDialogFocus } from './useDialogFocus';
import { useOnlineMatch, useSubmitOnlineAction, useForfeitOnlineMatch } from '../api/queries';
import type { OnlineMatch } from '../api/types';
import { sendBugReport } from '../api/bugReport';
import { loadOnlineSession } from '../state/storage';

/** Screen-space slop so finger jitter on a tap is not treated as a shot. */
const DRAG_SLOP_PX = 8;

const MOVEMENT_ALIAS_CODES = new Set<string>(Object.values(MOVEMENT_ALIASES));

type PausePanel = 'settings' | 'controls' | 'report' | null;

interface GameViewProps {
  settings: GameSettings;
  bindings: Bindings;
  onSaveSettings: (settings: GameSettings) => void;
  onSaveBindings: (bindings: Bindings) => void;
  onFinish: (result: SessionResult) => void;
  onRestart: () => void;
  onExit: () => void;
  online?: boolean;
  onlineCode?: string;
  playerId?: string;
  playerTeamIndex?: number;
}

/**
 * Owns the match: simulation, renderer, input and pause rules live here.
 * React only sees throttled snapshots (~10 Hz), never a render per frame.
 */
export function GameView({
  settings,
  bindings,
  onSaveSettings,
  onSaveBindings,
  onFinish,
  onRestart,
  onExit,
  online = false,
  onlineCode,
  playerId,
  playerTeamIndex = 0,
}: GameViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const rendererRef = useRef<ArenaRenderer | null>(null);
  const soundRef = useRef<SoundKit | null>(null);
  const pausedRef = useRef(false);
  const handoffRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const lastActiveTeamRef = useRef<number | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const pausePanelRef = useRef<PausePanel>(null);
  const capturingRef = useRef(false);
  // HUD pointer input lives outside the keyboard set; the fixed-step loop reads it.
  const hudMoveRef = useRef<-1 | 0 | 1>(0);
  const lastUiPush = useRef(0);
  const accumulator = useRef(0);
  const dragRef = useRef<{ active: boolean; moved: boolean; startX: number; startY: number }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
  });

  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [handoff, setHandoff] = useState<number | null>(null);
  const [pausePanel, setPausePanel] = useState<PausePanel>(null);
  pausePanelRef.current = pausePanel;
  // The card unmounts while a panel is open; its button takes focus back afterwards.
  const lastPanel = useRef<PausePanel>(null);
  if (pausePanel) lastPanel.current = pausePanel;
  const dialogRef = useDialogFocus<HTMLDivElement>(paused && !capturing, pausePanel ?? 'root');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onlineMatch = useOnlineMatch(online ? (onlineCode ?? null) : null, online);
  const onlineMatchRef = useRef(onlineMatch);
  useEffect(() => { onlineMatchRef.current = onlineMatch; }, [onlineMatch]);
  const cleanupRef = useRef<(() => void) | null>(null);
  const submitAction = useSubmitOnlineAction();
  const forfeit = useForfeitOnlineMatch();
  const lastServerActionCountRef = useRef(0);
  const lastLocalActionCountRef = useRef(0);
  const isMyTurn = online ? (onlineMatch.data?.activeTeam === playerTeamIndex) : true;
  const isMyTurnRef = useRef(isMyTurn);
  isMyTurnRef.current = isMyTurn;
  const fullscreen = useFullscreen();

  // `?seed=123` makes terrain and AI jitter reproducible for E2E runs.
  const seedRef = useRef(
    (() => {
      const raw = Number(new URLSearchParams(window.location.search).get('seed'));
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : Math.floor(Math.random() * 1_000_000_000);
    })(),
  );

  const setPause = useCallback((value: boolean) => {
    if (finishedRef.current) return;
    pausedRef.current = value;
    setPaused(value);
    setPausePanel(null);
    if (engineRef.current) {
      engineRef.current.moveDir = 0;
      engineRef.current.reelDir = 0;
      // A release under the pause card must not fire the held shot.
      if (value) {
        engineRef.current.cancelCharge();
        // Keyup can land on the pause dialog; drop held movement on resume.
        keysRef.current.clear();
      }
    }
    hudMoveRef.current = 0;
  }, []);

  const captureReport = useCallback(async () => {
    if (capturingRef.current) throw new Error('Capture already in progress');
    capturingRef.current = true;
    setCapturing(true);
    try {
      // getDisplayMedia needs the click's user activation. The overlay hides on
      // the next commit, before the stream delivers any frame.
      return await captureGameTab();
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  }, []);

  const sendReport = useCallback(
    async ({ note, screenshot }: { note: string; screenshot: GameScreenshot | null }) => {
      const engine = engineRef.current;
      if (!engine) throw new Error('No active match');
      return sendBugReport({
        engine,
        note,
        screenshot,
        online: online && onlineCode && playerId ? { code: onlineCode, playerId } : null,
      });
    },
    [online, onlineCode, playerId],
  );

  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return;

    let timer: number | null = null;
    const start = async () => {
      if (online) {
        while (!disposed && !onlineMatchRef.current?.data) {
          await new Promise<void>((resolve) => { timer = window.setTimeout(resolve, 100); });
          if (disposed) return;
        }
      }
      if (disposed) return;
      const matchData = online ? onlineMatchRef.current?.data : undefined;
      const serverSettings = matchData?.settings;
      const resolvedSeed = (serverSettings?.seed != null) ? serverSettings.seed : seedRef.current;
      if (online && serverSettings?.seed != null) seedRef.current = serverSettings.seed;

    const engine = new GameEngine({
      turnSeconds: serverSettings?.turnSeconds ?? settings.turnSeconds,
      wind: serverSettings?.wind ?? settings.wind,
      difficulty: serverSettings?.difficulty ?? settings.difficulty,
      seed: resolvedSeed,
      wormsPerTeam: serverSettings?.wormsPerTeam ?? settings.wormsPerTeam ?? 3,
      map: (serverSettings?.map as GameSettings['map']) ?? settings.map ?? 'island',
      mode: (serverSettings?.mode as GameSettings['mode']) ?? settings.mode ?? 'deathmatch',
      loadout: (serverSettings?.loadout as GameSettings['loadout']) ?? settings.loadout ?? 'default',
      hotseat: online ? false : settings.hotseat ?? false,
      teamCount: online ? 2 : settings.teamCount ?? 2,
      teamNames: online ? serverSettings?.teamNames ?? settings.teamNames?.slice(0, 2) : settings.teamNames,
    });
    engineRef.current = engine;
    // E2E instrumentation: lets Playwright observe the authoritative simulation
    // state instead of scraping pixels. Read-only by convention.
    if (typeof window !== 'undefined') {
      (window as unknown as { __WORMAGE__?: unknown }).__WORMAGE__ = {
        engine,
        snapshot: () => engine.snapshot(),
        ...(new URLSearchParams(window.location.search).get('debug') === '1'
          ? {
              debugLog: () => engine.debugLog,
              clearDebugLog: () => engine.clearDebugLog(),
              flushDebugLog: () => flushDebugLog(engine),
            }
          : {}),
        version: '1.0.0',
      };
    }
    const sound = new SoundKit(settings.sound);
    soundRef.current = sound;

    const onResult = () => {
      if (finishedRef.current || disposed) return;
      finishedRef.current = true;
      const result: SessionResult = {
        winnerTeam: engine.winnerTeam,
        playerTeam: 0,
        playerWon: engine.winnerTeam === 0,
        score: engine.scoreFor(0),
        teamScores: engine.teams.map((t) => engine.scoreFor(t.id)),
        teamKills: engine.teams.map((t) => engine.kills[t.id] ?? 0),
        durationSeconds: Math.round(engine.elapsed),
        endReason: engine.endReason ?? 'wipeout',
        kills: engine.kills[0],
        config: {
          turnSeconds: settings.turnSeconds,
          wind: settings.wind,
          difficulty: settings.difficulty,
          seed: seedRef.current,
          map: settings.map ?? 'island',
          mode: settings.mode ?? 'deathmatch',
          loadout: settings.loadout ?? 'default',
          hotseat: settings.hotseat ?? false,
          teamCount: settings.teamCount ?? 2,
          teamNames: settings.teamNames,
        },
        recordedAt: new Date().toISOString(),
      };
      void flushDebugLog(engine);
      window.setTimeout(() => {
        if (!disposed) onFinish(result);
      }, 1500);
    };

    const tick = () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      // Gameover must be handled even while a handoff freezes the simulation.
      if (engine.phase === 'gameover') onResult();
      const dt = Math.min(0.08, renderer.app.ticker.deltaMS / 1000);
      if (handoffRef.current !== null) {
        renderer.render(dt, true);
        const next = engine.snapshot();
        snapshotRef.current = next;
        const now = performance.now();
        if (now - lastUiPush.current > 100) {
          lastUiPush.current = now;
          setSnapshot(next);
        }
        return;
      }
      // Rendering keeps the real frame delta; the simulation only advances in
      // fixed steps. The clamp caps catch-up after a stalled tab.
      const isPaused = pausedRef.current;

      if (!isPaused) {
        accumulator.current += dt;
        while (accumulator.current >= FIXED_DT) {
          accumulator.current -= FIXED_DT;
          const keymap = bindingsRef.current;
          // Arrow keys stay as aliases so the documented controls survive a rebind.
          const held = (action: MovementAliasAction) =>
            keysRef.current.has(keymap[action]) || keysRef.current.has(MOVEMENT_ALIASES[action]);

          // The AI drives its own worm; player input only steers on human turns.
          if (!engine.teams[engine.activeTeam].isAi) {
            if (engine.phase === 'aim' || engine.retreatActive) {
              const hudDir = hudMoveRef.current;
              if (hudDir !== 0) engine.setMove(hudDir);
              else if (held('left')) engine.setMove(-1);
              else if (held('right')) engine.setMove(1);
              else engine.setMove(0);

              if (engine.activeWorm?.rope) {
                if (held('aimUp')) engine.setReel(-1);
                else if (held('aimDown')) engine.setReel(1);
                else engine.setReel(0);
              } else {
                engine.setReel(0);
                if (engine.phase === 'aim') {
                  if (held('aimUp')) engine.aimBy(AIM.rate * FIXED_DT);
                  if (held('aimDown')) engine.aimBy(-AIM.rate * FIXED_DT);
                }
              }
            } else {
              hudMoveRef.current = 0;
              engine.setMove(0);
              engine.setReel(0);
            }
          } else {
            // A pad held when the turn passed must not walk the next human worm.
            hudMoveRef.current = 0;
          }

          engine.update(FIXED_DT);
        }

        for (const event of engine.events.splice(0)) {
          renderer.handleEvent(event);
          switch (event.type) {
            case 'fire':
              sound.play('fire');
              break;
            case 'explosion':
              sound.play('boom');
              break;
            case 'mineExplosion':
              sound.play('mine');
              break;
            case 'hurt':
              sound.play('hurt');
              break;
            case 'death':
              sound.play('death');
              break;
            case 'splash':
              sound.play('splash');
              break;
            case 'bounce':
              sound.play('bounce');
              break;
            case 'jump':
              sound.play('jump');
              break;
            case 'turn':
              sound.play('turn');
              if (settings.hotseat) {
                if (lastActiveTeamRef.current !== null && event.teamId !== lastActiveTeamRef.current) {
                  handoffRef.current = event.teamId;
                  setHandoff(event.teamId);
                }
                lastActiveTeamRef.current = event.teamId;
              }
              break;
            case 'gameover':
              sound.play(engine.winnerTeam === 0 ? 'victory' : 'death');
              break;
            default:
              break;
          }
        }

        if (engine.phase === 'gameover') onResult();
      }

      renderer.render(dt, isPaused);

      const next = engine.snapshot();
      snapshotRef.current = next;
      // UI sync at ~10 Hz: React never renders per frame.
      const now = performance.now();
      if (now - lastUiPush.current > 100) {
        lastUiPush.current = now;
        setSnapshot(next);
      }
    };

    const attach = async () => {
      try {
        const renderer = await ArenaRenderer.create(host, engine);
        if (disposed) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        // E2E needs the painted canvas; the renderer owns it now.
        (window as unknown as { __WORMAGE__: { painter: unknown } }).__WORMAGE__.painter = renderer.terrainPainter;
        renderer.app.ticker.add(tick);
        setReady(true);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : 'Renderer failed to start');
      }
    };
    void attach();

    const pauseAuto = () => {
      // Keep the current pause panel alive: the screen-capture picker blurs the
      // window, and closing the report card there would lose the capture.
      if (!pausedRef.current) setPause(true);
    };
    const onVisibility = () => {
      if (document.hidden) {
        pauseAuto();
        const engine = engineRef.current;
        if (engine) void flushDebugLog(engine);
      }
    };
    window.addEventListener('blur', pauseAuto);
    document.addEventListener('visibilitychange', onVisibility);
    const flushTimer = window.setInterval(() => {
      const engine = engineRef.current;
      if (engine) void flushDebugLog(engine);
    }, 30_000);

    cleanupRef.current = () => {
      window.clearInterval(flushTimer);
      window.removeEventListener('blur', pauseAuto);
      window.removeEventListener('visibilitychange', onVisibility);
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.app.ticker.remove(tick);
        renderer.destroy();
      }
      rendererRef.current = null;
      const engine = engineRef.current;
      if (engine) void flushDebugLog(engine);
      engineRef.current = null;
      delete (window as unknown as { __WORMAGE__?: unknown }).__WORMAGE__;
      soundRef.current = null;
    };

    };
    void start();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // The match runs from a settings snapshot taken at mount.    // The match runs from a settings snapshot taken at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (capturingRef.current) return;
      if (handoffRef.current !== null) return;
      if (online && !isMyTurnRef.current) return;
      const target = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const keys = bindingsRef.current;
      // Esc belongs to the browser while fullscreen; pausing on the same key would
      // resume the match the user just left.
      if (e.code === 'Escape' && document.fullscreenElement) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        // A sub-panel closes first; only the pause card resumes the match.
        if (pausePanelRef.current) setPausePanel(null);
        else setPause(!pausedRef.current);
        return;
      }
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.code === keys.pause) {
        e.preventDefault();
        if (pausePanelRef.current) setPausePanel(null);
        else setPause(!pausedRef.current);
        return;
      }
      // A dialog button owns its own Space/Enter activation; do not also resume.
      if (target?.closest('.overlay') && (target.tagName === 'BUTTON' || target.tagName === 'A')) return;
      if (pausedRef.current) {
        if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          setPause(false);
        }
        return;
      }
      const engine = engineRef.current;
      const snap = snapshotRef.current;
      if (!engine || !snap || finishedRef.current) return;

      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();

      if ([keys.left, keys.right, keys.aimUp, keys.aimDown].includes(e.code) || MOVEMENT_ALIAS_CODES.has(e.code)) {
        keysRef.current.add(e.code);
        return;
      }
      if (e.code === keys.fire) {
        keysRef.current.add(e.code);
        if (!e.repeat && !snap.teams[snap.activeTeam]?.isAi) { if (online) engine.record({ type: 'startCharge' }); else engine.startCharge(); }
        return;
      }
      if (e.code === keys.jump) {
        if (!e.repeat && !snap.teams[snap.activeTeam]?.isAi) { if (online) engine.record({ type: 'jump' }); else engine.jump(); }
        return;
      }
      if (e.code === keys.rope) {
        if (!e.repeat && !snap.teams[snap.activeTeam]?.isAi) { if (online) engine.record({ type: 'rope' }); else engine.useRope(); }
        return;
      }
      const weaponByKey: Record<string, WeaponId> = {
        [keys.weapon1]: 'bazooka',
        [keys.weapon2]: 'grenade',
        [keys.weapon3]: 'shotgun',
        [keys.weapon4]: 'dynamite',
      };
      const weapon = weaponByKey[e.code];
      if (weapon) {
        if (online) engine.record({ type: 'weapon', id: weapon }); else engine.selectWeapon(weapon);
        return;
      }
      if (e.code === keys.endTurn && !snap.teams[snap.activeTeam]?.isAi) { if (online) engine.record({ type: 'endTurn' }); else engine.endTurn(); }
    };

    const up = (e: KeyboardEvent) => {
      if (capturingRef.current) return;
      keysRef.current.delete(e.code);
      if (e.code === bindingsRef.current.fire && engineRef.current) { if (online) engineRef.current.record({ type: 'releaseCharge' }); else engineRef.current.releaseCharge(); }
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [setPause]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !ready) return;
    const canvas = renderer.canvas;

    const localPoint = (e: PointerEvent) => renderer.toWorld(e.clientX, e.clientY);

    const onDown = (e: PointerEvent) => {
      const engine = engineRef.current;
      if (!engine || pausedRef.current || finishedRef.current || handoffRef.current !== null) return;
      if (online && !isMyTurnRef.current) return;
      const snap = engine.snapshot();
      if (snap.phase !== 'aim' || snap.teams[snap.activeTeam]?.isAi) return;
      const point = localPoint(e);
      engine.setAimFromPoint(point.x, point.y);
      dragRef.current = { active: true, moved: false, startX: e.clientX, startY: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const engine = engineRef.current;
      const drag = dragRef.current;
      if (!engine || !drag.active) return;
      if (online && !isMyTurnRef.current) return;
      const point = localPoint(e);
      const worm = engine.activeWorm;
      if (!worm) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= DRAG_SLOP_PX) {
        drag.moved = true;
      }
      engine.setAimFromPoint(point.x, point.y);
      if (!engine.charging) {
        const distance = Math.hypot(point.x - worm.x, point.y - (worm.y - 14));
        engine.power = Math.min(1, Math.max(0.12, distance / 340));
      }
    };

    const onUp = () => {
      const engine = engineRef.current;
      const wasActive = dragRef.current.active;
      const moved = dragRef.current.moved;
      dragRef.current = { active: false, moved: false, startX: 0, startY: 0 };
      if (!engine || !wasActive || !moved) return;
      // The other thumb may be holding FIRE; its release owns the shot.
      if (engine.charging) return;
      if (online) engine.record({ type: 'fire' }); else engine.fire();
    };

    const onCancel = () => {
      dragRef.current = { active: false, moved: false, startX: 0, startY: 0 };
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    const noMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', noMenu);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('contextmenu', noMenu);
    };
  }, [ready]);

  // Online: apply opponent actions from polled server state.
  // shortcut: the action lands at this client's tick, not the sender's, so the
  // local engine can drift from the server snapshot; add a snapshot re-sync
  // before online play leaves the prototype (M4b).
  useEffect(() => {
    if (!online || !onlineMatch.data || !engineRef.current) return;
    const engine = engineRef.current;
    const serverActions = (onlineMatch.data as { actions?: Array<{ tick: number; action: { type: string; [k: string]: unknown }; playerId: string }> }).actions ?? [];
    if (serverActions.length <= lastServerActionCountRef.current) return;
    const newActions = serverActions.slice(lastServerActionCountRef.current);
    for (const entry of newActions) {
      // Only apply opponent's actions (local player's were already applied).
      if (entry.playerId !== playerId) {
        engine.applyAction(entry.action as Parameters<typeof engine.applyAction>[0]);
      }
    }
    lastServerActionCountRef.current = serverActions.length;
  }, [online, onlineMatch.data, playerId]);

  // Online: submit local commit actions to server.
  useEffect(() => {
    if (!online || !onlineCode || !playerId || !engineRef.current) return;
    const engine = engineRef.current;
    const interval = window.setInterval(() => {
      const log = engine.log;
      const count = lastLocalActionCountRef.current;
      if (log.length <= count) return;
      const newEntries = log.slice(count);
      for (const entry of newEntries) {
        // Only submit commit actions (not move/aim which are local-only).
        const commitTypes = ['fire', 'endTurn', 'jump', 'rope', 'weapon', 'startCharge', 'releaseCharge'];
        if (commitTypes.includes(entry.action.type)) {
          void submitAction.mutateAsync({
            code: onlineCode,
            playerId,
            action: entry.action as { type: string; [k: string]: unknown },
            clientActionId: `${entry.tick}-${entry.action.type}`,
            tick: entry.tick,
          }).catch(() => { /* ignore */ });
        }
      }
      lastLocalActionCountRef.current = log.length;
    }, 200);
    return () => window.clearInterval(interval);
  }, [online, onlineCode, playerId, submitAction]);

  const engine = engineRef.current;

  return (
    <div className="game-shell">
      <div ref={hostRef} className="arena-host" data-testid="arena" aria-label="Battle arena" role="img" />

      {!ready && !error && (
        <div className="loading-overlay">
          <div className="loader" />
          <p>Digging trenches…</p>
        </div>
      )}
      {error && (
        <div className="loading-overlay">
          <p className="error-text">The arena could not start: {error}</p>
          <button type="button" className="primary-btn" onClick={onExit}>
            Back to menu
          </button>
        </div>
      )}

      {snapshot && ready && (
        <Hud
          snapshot={snapshot}
          paused={paused}
          onMove={(dir) => {
            hudMoveRef.current = dir;
            engineRef.current?.setMove(dir);
          }}
          onAim={(dir) => engineRef.current?.aimBy(dir * 0.06)}
          onAimStop={() => undefined}
          onJump={() => { const e = engineRef.current; if (!e) return; if (online) e.record({ type: 'jump' }); else e.jump(); }}
          onRope={() => { const e = engineRef.current; if (!e) return; if (online) e.record({ type: 'rope' }); else e.useRope(); }}
          onReel={(dir) => engineRef.current?.setReel(dir)}
          onChargeStart={() => { const e = engineRef.current; if (!e) return; if (online) e.record({ type: 'startCharge' }); else e.startCharge(); }}
          onChargeEnd={() => { const e = engineRef.current; if (!e) return; if (online) e.record({ type: 'releaseCharge' }); else e.releaseCharge(); }}
          onChargeCancel={() => engineRef.current?.cancelCharge()}
          onSelectWeapon={(weapon) => { const e = engineRef.current; if (!e) return; if (online) e.record({ type: 'weapon', id: weapon }); else e.selectWeapon(weapon); }}
          onEndTurn={() => { const e = engineRef.current; if (!e) return; if (online) e.record({ type: 'endTurn' }); else e.endTurn(); }}
          onPause={() => {
            // The capture hides the overlay; the HUD is clickable during that
            // window and must not close the report panel.
            if (!capturingRef.current) setPause(true);
          }}
        />
      )}

      {paused && (
        <div
          ref={dialogRef}
          className={`overlay pause-overlay${capturing ? ' pause-overlay--capturing' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={pausePanel === 'settings' ? 'Settings' : pausePanel === 'controls' ? 'Controls' : pausePanel === 'report' ? 'Report a bug' : 'Game paused'}
          onClick={(event) => {
            if (event.target === event.currentTarget && pausePanel) setPausePanel(null);
          }}
        >
          {pausePanel === 'settings' ? (
            <SettingsDialog settings={settings} onSave={onSaveSettings} onClose={() => setPausePanel(null)} />
          ) : pausePanel === 'controls' ? (
            <ControlsDialog bindings={bindings} onSave={onSaveBindings} onClose={() => setPausePanel(null)} />
          ) : pausePanel === 'report' ? (
            <BugReportDialog onCapture={captureReport} onSend={sendReport} onClose={() => setPausePanel(null)} />
          ) : (
            <div className="overlay-card">
              <p className="eyebrow">Truce</p>
              <h2>Paused</h2>
              <p className="muted">The clock, wind and fuses are frozen until you resume.</p>
              <div className="overlay-actions overlay-actions-stacked">
                <button type="button" className="primary-btn" onClick={() => setPause(false)} data-testid="btn-resume">
                  Resume
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  data-testid="btn-controls"
                  autoFocus={lastPanel.current === 'controls'}
                  onClick={() => setPausePanel('controls')}
                >
                  Controls
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  data-testid="btn-settings"
                  autoFocus={lastPanel.current === 'settings'}
                  onClick={() => setPausePanel('settings')}
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  data-testid="btn-report"
                  autoFocus={lastPanel.current === 'report'}
                  onClick={() => setPausePanel('report')}
                >
                  Report bug
                </button>
                {fullscreen.supported && !fullscreen.active && (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void enterDemoFullscreen()}
                    data-testid="btn-fullscreen"
                  >
                    Fullscreen
                  </button>
                )}
                <button type="button" className="ghost-btn" data-testid="btn-restart" onClick={onRestart}>
                  Restart Match
                </button>
                <button type="button" className="ghost-btn" onClick={onExit}>
                  Quit to Menu
                </button>
              </div>
            </div>
          )}
        </div>
      )}


      {online && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 5, display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ color: '#f4ead7', fontSize: 12, fontWeight: 700 }}>
            {isMyTurn ? 'Your turn' : "Opponent's turn"}
            {onlineMatch.data && ` · ${Math.max(0, Math.ceil((new Date(onlineMatch.data.turnStartedAt).getTime() + onlineMatch.data.turnSeconds * 1000 - Date.now()) / 1000))}s`}
          </span>
          <button type="button" className="ghost-btn" style={{ fontSize: 11 }} onClick={() => forfeit.mutateAsync({ code: onlineCode!, playerId: playerId! }).then(() => onExit()).catch(() => {})} data-testid="btn-forfeit">
            Forfeit
          </button>
        </div>
      )}

      {handoff !== null && (
        <div className="overlay handoff-overlay" data-testid="handoff-overlay" role="dialog" aria-modal="true" aria-label="Pass the device">
          <div className="overlay-card">
            <p className="eyebrow">Pass the device</p>
            <h2>Player {handoff + 1}&apos;s turn</h2>
            <p className="muted">Hand the device to the next commander before you act.</p>
            <div className="overlay-actions overlay-actions-stacked">
              <button
                type="button"
                className="primary-btn"
                data-testid="btn-handoff-ready"
                onClick={() => {
                  handoffRef.current = null;
                  setHandoff(null);
                }}
              >
                Ready
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
