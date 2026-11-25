import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { listTests, selectTests } from '../../scripts/affected.mjs';
import { parseArgs, planRuns, resolveCommand } from '../../scripts/test-runner.mjs';

const selection = (changed: string[], labels: string[] = []) => selectTests({ changed, labels });

test('a docs-only change runs no tests', () => {
  const result = selection(['docs/ARCHITECTURE.md', 'README.md', 'mobile-arena.png']);
  expect(result.full).toBe(false);
  expect(result.unit).toEqual([]);
  expect(result.e2e).toEqual([]);
});

test('a narrow UI change runs only the specs that can reach it', () => {
  expect(selection(['src/ui/OptionsPanel.tsx']).e2e).toEqual(['tests/menu.spec.ts', 'tests/settings.spec.ts']);
  expect(selection(['src/ui/MainMenu.tsx']).e2e).toEqual([
    'tests/data.spec.ts',
    'tests/fullscreen.spec.ts',
    'tests/menu.spec.ts',
  ]);
  // Every gameplay spec starts on the /demo landing screen.
  expect(selection(['src/ui/NewGameMenu.tsx']).e2e).toEqual(selection(['src/ui/SomeNewScreen.tsx']).e2e);
});

test('a config change runs the game units and every UI spec', () => {
  const result = selection(['src/game/config.ts']);
  expect(result.full).toBe(false);
  expect(result.unit).toContain('tests/unit/parity.test.ts');
  expect(result.e2e).toEqual(selection(['src/ui/SomeNewScreen.tsx']).e2e);
});

test('game sources run the game units and the gameplay specs', () => {
  const result = selection(['src/game/engine.ts']);
  expect(result.full).toBe(false);
  expect(result.unit).toEqual([
    'tests/unit/ai.test.ts',
    'tests/unit/debugLog.test.ts',
    'tests/unit/engine.test.ts',
    'tests/unit/jump.test.ts',
    'tests/unit/lambdaReplay.test.ts',
    'tests/unit/lootPhysics.test.ts',
    'tests/unit/mines.test.ts',
    'tests/unit/parity.test.ts',
    'tests/unit/ragdoll.test.ts',
    'tests/unit/replay.test.ts',
    'tests/unit/rope.test.ts',
    'tests/unit/wind.test.ts',
  ]);
  expect(result.e2e).toEqual(['tests/combat.spec.ts', 'tests/jump.spec.ts', 'tests/rope.spec.ts']);
});

test('a changed unit test runs itself and a shared fixture runs the unit suite', () => {
  expect(selection(['tests/unit/engine.test.ts']).unit).toEqual(['tests/unit/engine.test.ts']);
  expect(selection(['tests/unit/terrainFixture.ts']).unit).toEqual([...listTests().units].sort());
});

test('listTests finds nested specs and unit tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'wormage-affected-'));
  try {
    mkdirSync(join(root, 'tests/unit/deep'), { recursive: true });
    writeFileSync(join(root, 'tests/nested.spec.ts'), '');
    writeFileSync(join(root, 'tests/unit/deep/nested.test.ts'), '');
    expect(listTests(root)).toEqual({
      specs: ['tests/nested.spec.ts'],
      units: ['tests/unit/deep/nested.test.ts'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('game view and API changes reach the online player journey', () => {
  const gameView = selection(['src/ui/GameView.tsx']);
  expect(gameView.e2e).toEqual(expect.arrayContaining(['tests/online.spec.ts', 'tests/online-two-browsers.spec.ts']));

  for (const file of ['src/api/client.ts', 'src/api/mockServer.ts', 'src/mocks/handlers.ts']) {
    const result = selection([file]);
    expect(result.e2e).toEqual(expect.arrayContaining(['tests/data.spec.ts', 'tests/online.spec.ts', 'tests/online-two-browsers.spec.ts']));
  }
});

test('infra changes select replay coverage and the Lambda test suite', () => {
  const result = selection(['infra/lambda/index.js']);
  expect(result.full).toBe(false);
  expect(result.unit).toContain('tests/unit/lambdaReplay.test.ts');
  expect(result.e2e).toEqual([]);
  expect(result.infra).toBe(true);
});

test('selector arguments expose unit, browser, project, grep and dry-run filters', () => {
  expect(parseArgs([
    '--base',
    'origin/main',
    '--unit-only',
    '--project=mobile',
    '--grep=@smoke',
    '--dry-run',
  ])).toMatchObject({
    base: 'origin/main',
    unitOnly: true,
    project: 'mobile',
    grep: '@smoke',
    dryRun: true,
  });
  expect(() => parseArgs(['--project=tablet'])).toThrow(/desktop or mobile/);
  expect(() => parseArgs(['--project='])).toThrow(/desktop or mobile/);
  expect(() => parseArgs(['--project'])).toThrow(/requires/);
  expect(() => parseArgs(['--grep='])).toThrow(/requires/);
  expect(() => parseArgs(['--grep'])).toThrow(/requires/);
  expect(() => parseArgs(['--grep', '--dry-run', '--run'])).toThrow(/requires/);
  expect(() => parseArgs(['--unit-only', '--e2e-only'])).toThrow(/cannot/);
});

test('Windows launches Node CLIs directly instead of spawning batch shims', () => {
  const vitest = resolveCommand('npx', ['vitest', 'run'], { platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
  expect(vitest.command).toBe('C:\\nodejs\\node.exe');
  expect(vitest.args[0]).toMatch(/node_modules[\\/]vitest[\\/]vitest\.mjs$/);
  expect(vitest.args.slice(1)).toEqual(['run']);

  const npm = resolveCommand('npm', ['--prefix', 'infra', 'test'], { platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
  expect(npm.command).toBe('C:\\nodejs\\node.exe');
  expect(npm.args[0]).toMatch(/node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
  expect(npm.args.slice(1)).toEqual(['--prefix', 'infra', 'test']);
});

test('POSIX can launch npm directly when no npm entrypoint is provided', () => {
  expect(resolveCommand('npm', ['--version'], { platform: 'linux', npmExecpath: '', execPath: '/usr/bin/node' })).toEqual({
    command: 'npm',
    args: ['--version'],
  });
});

test('unit-only planning keeps Node infra tests but skips the browser suite', () => {
  const full = selection(['package.json']);
  const plan = planRuns(full, parseArgs(['--unit-only']));
  expect(plan).toMatchObject({ unit: true, infra: true, e2e: false });
  expect(plan.unitArgs).toEqual([]);
  expect(plan.e2eArgs).toEqual([]);
});

test('browser-only planning forwards project and grep without running Node suites', () => {
  const selected = selection(['tests/online.spec.ts']);
  const plan = planRuns(selected, parseArgs(['--e2e-only', '--project=mobile', '--grep=@smoke']));
  expect(plan).toMatchObject({ unit: false, infra: false, e2e: true });
  expect(plan.e2eArgs).toEqual(['tests/online.spec.ts', '--project=mobile', '--grep=@smoke']);
});

test('unmapped sources, shared files and the ci:full label fall back to the full suite', () => {
  expect(selection(['src/unknown.ts']).full).toBe(true);
  expect(selection(['package.json']).full).toBe(true);
  expect(selection(['src/styles.css']).full).toBe(true);
  expect(selection(['.github/workflows/ci.yml']).full).toBe(true);
  expect(selection(['docs/ARCHITECTURE.md'], ['ci:full']).full).toBe(true);
});

test('every test file is reachable from a source change', () => {
  const { specs, units } = listTests();
  const sources = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx|css)$/.test(file))
    .map((file) => `src/${file.replace(/\\/g, '/')}`);

  const reachedUnit = new Set<string>();
  const reachedE2e = new Set<string>();
  for (const file of sources) {
    const result = selection([file]);
    if (result.full) continue;
    result.unit.forEach((test) => reachedUnit.add(test));
    result.e2e.forEach((test) => reachedE2e.add(test));
  }

  expect(specs.filter((spec) => !reachedE2e.has(spec))).toEqual([]);
  // Selector, smoke-policy and Playwright-config tests need their own shared-file triggers.
  expect(selection(['scripts/affected.mjs']).full).toBe(true);
  expect(selection(['playwright.config.ts']).full).toBe(true);
  expect(units.filter((unit) => !reachedUnit.has(unit) && ![
    'tests/unit/affected.test.ts',
    'tests/unit/playwrightConfig.test.ts',
    'tests/unit/smoke.test.ts',
  ].includes(unit))).toEqual([]);
});
