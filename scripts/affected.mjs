// Selects the tests a diff can reach. The map is deliberately coarse: a missed
// dependency silently skips tests, while a wide match only costs a few minutes.
// Anything without a rule falls back to the full suite.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, planRuns, runSelected } from './test-runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const GAME_UNIT = [
  'tests/unit/ai.test.ts',
  'tests/unit/authoritativeInputs.test.ts',
  'tests/unit/cpuNoPlan.test.ts',
  'tests/unit/engine.test.ts',
  'tests/unit/mines.test.ts',
  'tests/unit/ragdoll.test.ts',
  'tests/unit/debugLog.test.ts',
  'tests/unit/jump.test.ts',
  'tests/unit/lambdaReplay.test.ts',
  'tests/unit/lootPhysics.test.ts',
  'tests/unit/parity.test.ts',
  'tests/unit/replay.test.ts',
  'tests/unit/rope.test.ts',
  'tests/unit/wind.test.ts',
];
const GAME_E2E = ['tests/combat.spec.ts', 'tests/jump.spec.ts', 'tests/rope.spec.ts'];
const UI_E2E = [
  'tests/bug-report.spec.ts',
  'tests/bug-report-real-capture.spec.ts',
  'tests/combat.spec.ts',
  'tests/data.spec.ts',
  'tests/fullscreen.spec.ts',
  'tests/hud-layout.spec.ts',
  'tests/jump.spec.ts',
  'tests/landscape-gate.spec.ts',
  'tests/menu.spec.ts',
  'tests/mobile-hud.spec.ts',
  'tests/pwa.spec.ts',
  'tests/rope.spec.ts',
  'tests/settings.spec.ts',
  'tests/stages.spec.ts',
  'tests/hotseat.spec.ts',
  'tests/online.spec.ts',
  'tests/online-two-browsers.spec.ts',
];

const FULL_FILES = [
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'src/App.tsx',
  'src/main.tsx',
  'src/styles.css',
  'src/types.ts',
  'src/game/types.ts',
];
const FULL_DIRS = ['.github/', 'scripts/'];

const RULES = [
  // config.ts also feeds the HUD, menu, result screen and stored settings.
  { files: ['src/game/sky.ts'], unit: ['tests/unit/sky.test.ts'], e2e: ['tests/menu.spec.ts'] },
  { dirs: ['src/content/'], unit: ['tests/unit/content.test.ts'], e2e: [] },
  { files: ['src/game/config.ts'], unit: GAME_UNIT, e2e: UI_E2E },
  { dirs: ['src/game/'], unit: GAME_UNIT, e2e: GAME_E2E },
  {
    files: ['src/ui/GameView.tsx'],
    unit: [],
    e2e: ['tests/combat.spec.ts', 'tests/fullscreen.spec.ts', 'tests/jump.spec.ts', 'tests/landscape-gate.spec.ts', 'tests/mobile-hud.spec.ts', 'tests/hud-layout.spec.ts', 'tests/data.spec.ts', 'tests/rope.spec.ts', 'tests/settings.spec.ts', 'tests/bug-report.spec.ts', 'tests/bug-report-real-capture.spec.ts', 'tests/online.spec.ts', 'tests/online-two-browsers.spec.ts'],
  },
  {
    files: ['src/ui/Hud.tsx', 'src/ui/hudTeams.ts'],
    unit: ['tests/unit/hud.test.ts'],
    e2e: ['tests/combat.spec.ts', 'tests/jump.spec.ts', 'tests/mobile-hud.spec.ts', 'tests/hud-layout.spec.ts', 'tests/rope.spec.ts'],
  },
  {
    files: ['src/ui/fullscreen.ts'],
    unit: ['tests/unit/fullscreen.test.ts', 'tests/unit/manifest.test.ts'],
    e2e: ['tests/fullscreen.spec.ts', 'tests/pwa.spec.ts'],
  },
  { files: ['src/ui/MainMenu.tsx'], unit: [], e2e: ['tests/data.spec.ts', 'tests/fullscreen.spec.ts', 'tests/menu.spec.ts'] },
  // Every gameplay spec starts by clicking Start Game on this screen.
  { files: ['src/ui/NewGameMenu.tsx'], unit: [], e2e: UI_E2E },
  { files: ['src/ui/OptionsPanel.tsx'], unit: [], e2e: ['tests/menu.spec.ts', 'tests/settings.spec.ts'] },
  {
    files: ['src/ui/Leaderboard.tsx', 'src/ui/MatchHistory.tsx', 'src/ui/ResultScreen.tsx', 'src/ui/resultLines.ts'],
    unit: ['tests/unit/resultLines.test.ts'],
    e2e: ['tests/data.spec.ts', 'tests/menu.spec.ts'],
  },
  {
    files: ['src/state/bindings.ts', 'src/state/storage.ts'],
    unit: ['tests/unit/bindings.test.ts', 'tests/unit/storage.test.ts', 'tests/unit/profile.test.ts'],
    e2e: ['tests/settings.spec.ts', 'tests/menu.spec.ts'],
  },
  {
    files: ['src/state/stages.ts'],
    unit: ['tests/unit/stages.test.ts', 'tests/unit/profile.test.ts'],
    e2e: ['tests/stages.spec.ts'],
  },
  {
    files: ['src/state/profile.ts'],
    unit: ['tests/unit/profile.test.ts'],
    e2e: ['tests/stages.spec.ts'],
  },
  {
    dirs: ['src/api/', 'src/mocks/', 'src/state/'],
    unit: ['tests/unit/auth.test.ts', 'tests/unit/authoritativeInputs.test.ts', 'tests/unit/mockServer.test.ts', 'tests/unit/onlineMatch.test.ts', 'tests/unit/lambdaReplay.test.ts', 'tests/unit/bugReport.test.ts', 'tests/unit/validationParity.test.ts', 'tests/unit/matchesCursor.test.ts'],
    e2e: ['tests/data.spec.ts', 'tests/menu.spec.ts', 'tests/online.spec.ts', 'tests/online-two-browsers.spec.ts', 'tests/pwa-offline.spec.ts'],
  },
  {
    files: ['src/pwa.ts', 'public/sw.js', 'public/manifest.webmanifest', 'vercel.json'],
    unit: ['tests/unit/manifest.test.ts'],
    e2e: ['tests/pwa-offline.spec.ts', 'tests/pwa.spec.ts'],
  },
  { dirs: ['infra/'], unit: ['tests/unit/lambdaReplay.test.ts', 'tests/unit/validationParity.test.ts'], e2e: [], infra: true },
  // A new screen or component still runs every spec: over-selecting is cheap.
  { dirs: ['src/ui/'], unit: [], e2e: UI_E2E },
  { dirs: ['docs/'], unit: [], e2e: [] },
  { files: ['LICENSE'], unit: [], e2e: [] },
];

const NO_TEST_EXTENSIONS = ['.md', '.png', '.jpg', '.svg'];

// Vitest and Playwright both discover tests recursively, so the reachability
// check must too.
function listTestsIn(root, dir, pattern) {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map((file) => `${dir}/${file.replace(/\\/g, '/')}`)
    .filter((file) => pattern.test(file))
    .sort();
}

export function listTests(root = ROOT) {
  return {
    specs: listTestsIn(root, 'tests', /\.spec\.ts$/).filter((file) => !file.startsWith('tests/unit/')),
    units: listTestsIn(root, 'tests/unit', /\.test\.ts$/),
  };
}

function fullResult(reason) {
  return { full: true, unit: [], e2e: [], infra: true, reason };
}

function isFull(file) {
  return FULL_FILES.includes(file) || FULL_DIRS.some((dir) => file.startsWith(dir));
}

function selectFor(file) {
  if (isFull(file)) return fullResult(`full trigger: ${file}`);
  if (NO_TEST_EXTENSIONS.some((ext) => file.endsWith(ext))) return { unit: [], e2e: [], infra: false };
  if (file.startsWith('tests/unit/')) {
    return { unit: file.endsWith('.test.ts') ? [file] : listTests().units, e2e: [], infra: false };
  }
  if (file.startsWith('tests/') && file.endsWith('.spec.ts')) return { unit: [], e2e: [file], infra: false };

  const rule = RULES.find(
    (candidate) => (candidate.files ?? []).includes(file) || (candidate.dirs ?? []).some((dir) => file.startsWith(dir)),
  );
  if (!rule) return fullResult(`unmapped path: ${file}`);
  return { unit: rule.unit, e2e: rule.e2e, infra: Boolean(rule.infra) };
}

export function selectTests({ changed, labels = [] }) {
  if (labels.includes('ci:full')) return fullResult('ci:full label');
  if (changed.length === 0) return { full: false, unit: [], e2e: [], infra: false, reason: 'no changed files' };

  const unit = new Set();
  const e2e = new Set();
  let infra = false;
  for (const file of changed) {
    const selection = selectFor(file);
    if (selection.full) return selection;
    selection.unit.forEach((test) => unit.add(test));
    selection.e2e.forEach((test) => e2e.add(test));
    infra ||= selection.infra;
  }

  const existing = (files) => [...files].filter((file) => existsSync(join(ROOT, file))).sort();
  return { full: false, unit: existing(unit), e2e: existing(e2e), infra, reason: `${changed.length} changed file(s)` };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultBase() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: ROOT, stdio: 'ignore' });
    return 'origin/main';
  } catch {
    return null;
  }
}

// Union of the branch diff and the local worktree, so the pre-push hook sees
// uncommitted and untracked files too. In CI the worktree is clean.
// Deletions and the old side of a rename still need the tests for that area,
// so include D and turn rename detection off.
function changedFiles(base) {
  const files = new Set();
  const add = (args) => git(args).forEach((file) => files.add(file));
  add(['diff', '--name-only', '--no-renames', '--diff-filter=ACDMRT', `${base}...HEAD`]);
  add(['diff', '--name-only', '--no-renames', '--diff-filter=ACDMRT']);
  add(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACDMRT']);
  add(['ls-files', '--others', '--exclude-standard']);
  return [...files];
}

function report(selection, plan) {
  const scope = plan.unit || plan.infra || plan.e2e ? (selection.full ? 'full' : 'selective') : 'none';
  console.log(`scope: ${scope} (${selection.reason})`);
  console.log(`unit: ${plan.unit ? (selection.full ? 'all' : selection.unit.join(' ') || '-') : '-'}`);
  console.log(`infra: ${plan.infra ? 'npm --prefix infra test' : '-'}`);
  const e2e = plan.e2e ? [selection.full ? 'all' : null, ...plan.e2eArgs].filter(Boolean).join(' ') : '-';
  console.log(`e2e: ${e2e}`);

  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(
    output,
    [
      `run_unit=${plan.unit}`,
      `unit_args=${plan.unitArgs.join(' ')}`,
      `run_infra=${plan.infra}`,
      `run_e2e=${plan.e2e}`,
      `e2e_args=${plan.e2eArgs.join(' ')}`,
      `scope=${scope}`,
    ].join('\n') + '\n',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let selection;
  if (args.full) {
    selection = fullResult('--full');
  } else {
    const base = args.base ?? defaultBase();
    if (!base) {
      selection = fullResult('no base ref');
    } else {
      try {
        selection = selectTests({ changed: changedFiles(base), labels: args.labels });
      } catch (error) {
        selection = fullResult(`git diff failed: ${error.message}`);
      }
    }
  }
  const plan = planRuns(selection, args);
  report(selection, plan);
  if (args.run && !args.dryRun) runSelected(plan);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
