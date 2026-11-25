import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRYPOINTS = {
  vitest: join(ROOT, 'node_modules/vitest/vitest.mjs'),
  playwright: join(ROOT, 'node_modules/@playwright/test/cli.js'),
};
const PLAYWRIGHT_PROJECTS = ['desktop', 'mobile'];
const BOOLEAN_FLAGS = {
  '--full': 'full',
  '--run': 'run',
  '--unit-only': 'unitOnly',
  '--e2e-only': 'e2eOnly',
  '--dry-run': 'dryRun',
};
const VALUE_FLAGS = {
  '--base': 'base',
  '--labels': 'labels',
  '--project': 'project',
  '--grep': 'grep',
};

function setValue(args, flag, value) {
  if (flag === '--labels') {
    args.labels = value.split(',').map((label) => label.trim()).filter(Boolean);
  } else {
    args[VALUE_FLAGS[flag]] = value;
  }
}

function validateArgs(args) {
  if (args.unitOnly && args.e2eOnly) throw new Error('--unit-only and --e2e-only cannot be combined');
  if (args.project !== null && !PLAYWRIGHT_PROJECTS.includes(args.project)) throw new Error('--project must be desktop or mobile');
  if (args.grep !== null && (!args.grep.trim() || args.grep.startsWith('--'))) throw new Error('--grep requires a non-empty title filter');
}

export function parseArgs(argv) {
  const args = {
    base: null,
    labels: [],
    full: false,
    run: false,
    unitOnly: false,
    e2eOnly: false,
    project: null,
    grep: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf('=');
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const value = separator === -1 ? undefined : arg.slice(separator + 1);
    if (value !== undefined) {
      if (!VALUE_FLAGS[flag]) throw new Error(`unknown argument: ${arg}`);
      setValue(args, flag, value);
    } else if (VALUE_FLAGS[flag]) {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      setValue(args, flag, next);
    } else if (BOOLEAN_FLAGS[flag]) {
      args[BOOLEAN_FLAGS[flag]] = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  validateArgs(args);
  return args;
}

export function planRuns(selection, args) {
  const e2eArgs = [...(selection.full ? [] : selection.e2e)];
  if (args.project) e2eArgs.push(`--project=${args.project}`);
  if (args.grep) e2eArgs.push(`--grep=${args.grep}`);
  return {
    unit: !args.e2eOnly && (selection.full || selection.unit.length > 0),
    unitArgs: selection.full ? [] : selection.unit,
    infra: !args.e2eOnly && (selection.full || Boolean(selection.infra)),
    e2e: !args.unitOnly && (selection.full || selection.e2e.length > 0),
    e2eArgs,
  };
}

export function resolveCommand(tool, args, {
  platform = process.platform,
  npmExecpath = process.env.npm_execpath,
  execPath = process.execPath,
} = {}) {
  if (tool === 'npx') {
    const [name, ...rest] = args;
    return { command: execPath, args: [CLI_ENTRYPOINTS[name], ...rest] };
  }
  if (tool === 'npm' && (platform === 'win32' || npmExecpath)) {
    const npmCli = npmExecpath ?? join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js');
    return { command: execPath, args: [npmCli, ...args] };
  }
  return { command: tool, args };
}

function run(tool, args) {
  const invocation = resolveCommand(tool, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`Failed to start ${tool}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runSelected(plan) {
  if (plan.unit) run('npx', ['vitest', 'run', ...plan.unitArgs]);
  if (plan.infra) run('npm', ['--prefix', 'infra', 'test']);
  if (plan.e2e) run('npx', ['playwright', 'test', ...plan.e2eArgs]);
  if (!plan.unit && !plan.infra && !plan.e2e) console.log('No tests affected.');
}
