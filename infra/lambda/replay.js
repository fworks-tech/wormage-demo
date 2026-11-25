'use strict';

// Pure replay core shared by the Lambda handler and the parity test. The
// engine class is injected so this file stays free of AWS and build coupling.
const DT = 1 / 60;
// 30 minutes of simulation. The old 5-minute ceiling silently dropped every
// action in a longer match; this still bounds a full replay to ~1.8 s.
const MAX_TICKS = 60 * 60 * 30;
const ENGINE_VERSION = 3;

function matchConfig(match) {
  const settings = (match && match.settings) || {};
  return {
    turnSeconds: typeof match.turnSeconds === 'number'
      ? match.turnSeconds
      : (typeof settings.turnSeconds === 'number' ? settings.turnSeconds : 45),
    wind: settings.wind || 'light',
    difficulty: settings.difficulty || 'veteran',
    seed: typeof settings.seed === 'number' ? settings.seed : 0,
    wormsPerTeam: typeof settings.wormsPerTeam === 'number' ? settings.wormsPerTeam : 3,
    map: settings.map || 'island',
    mode: settings.mode || 'deathmatch',
    loadout: settings.loadout || 'default',
    hotseat: true,
    teamCount: 2,
    teamNames: Array.isArray(settings.teamNames) ? settings.teamNames : undefined,
  };
}

function entryTick(entry) {
  if (entry && typeof entry.engineTick === 'number') return entry.engineTick;
  if (entry && typeof entry.tick === 'number') return entry.tick;
  return 0;
}

function sortActions(actions) {
  return [...(Array.isArray(actions) ? actions : [])].sort((a, b) => {
    // Tick first: the replay loop applies actions by engine tick, so arrival
    // order (seq) can leave an earlier tick behind a later one and skip both.
    const ea = entryTick(a);
    const eb = entryTick(b);
    if (ea !== eb) return ea - eb;
    const sa = a && typeof a.seq === 'number' ? a.seq : 0;
    const sb = b && typeof b.seq === 'number' ? b.seq : 0;
    if (sa !== sb) return sa - sb;
    return String((a && a.at) || '').localeCompare(String((b && b.at) || ''));
  });
}

function replayActionLog({ GameEngine, match, actions, maxTicks = MAX_TICKS, stopTick = null }) {
  const engine = new GameEngine(matchConfig(match));
  const log = sortActions(actions);
  const stop = typeof stopTick === 'number' ? Math.max(0, Math.min(stopTick, maxTicks)) : maxTicks;
  let cursor = 0;

  while (engine.phase !== 'gameover' && engine.tick < stop) {
    while (cursor < log.length && entryTick(log[cursor]) === engine.tick) {
      engine.applyAction(log[cursor].action);
      cursor += 1;
    }
    engine.update(DT);
  }
  // A turn-scoped replay stops after the action at its tick. A full-match
  // replay applies whatever is left so old logs still reach a final state.
  while (cursor < log.length && (stopTick == null || entryTick(log[cursor]) <= stop)) {
    engine.applyAction(log[cursor].action);
    cursor += 1;
  }

  return {
    code: match.code,
    tick: engine.tick,
    engineVersion: ENGINE_VERSION,
    snapshot: engine.snapshot(),
    winnerTeam: engine.winnerTeam,
    endReason: engine.endReason,
    kills: engine.kills,
  };
}

module.exports = { replayActionLog, matchConfig, entryTick, sortActions, DT, MAX_TICKS, ENGINE_VERSION };
