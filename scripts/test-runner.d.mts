// Types for selector CLI arguments and test-process launching.
import type { TestSelection } from './affected.mjs';

export interface SelectorArgs {
  base: string | null;
  labels: string[];
  full: boolean;
  run: boolean;
  unitOnly: boolean;
  e2eOnly: boolean;
  project: string | null;
  grep: string | null;
  dryRun: boolean;
}

export interface RunPlan {
  unit: boolean;
  unitArgs: string[];
  infra: boolean;
  e2e: boolean;
  e2eArgs: string[];
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

export function parseArgs(argv: string[]): SelectorArgs;
export function planRuns(selection: TestSelection, args: SelectorArgs): RunPlan;
export function resolveCommand(
  tool: string,
  args: string[],
  options?: { platform?: NodeJS.Platform; npmExecpath?: string; execPath?: string },
): CommandInvocation;
export function runSelected(plan: RunPlan): void;
