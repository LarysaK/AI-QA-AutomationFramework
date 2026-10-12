import { spawnSync } from 'node:child_process';

import { formatOutput, type ProposedFile, withProposedState } from './proposed-state';
import type { GuardFailure, GuardResult } from './types';

/**
 * G-STATIC (STD-TST-001, STD-TST-002): the approved static checks pass on the complete
 * proposed repository state.
 *
 * The checks run in a fresh copy of the proposed repository state (see proposed-state.ts):
 * `npm run typecheck`, `lint` and `format:check`, all three, each with a timeout.
 *
 * The checks run the approved tooling, plugins and configuration, which may execute code; the
 * root tooling configuration is protected by G-PATHS. Proposed files are parsed, not imported:
 * proposed Playwright tests are not run and the AUT is not started.
 */

export interface ScriptResult {
  /** Process exit code; null when the script did not finish. */
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  /** Set when the script could not be started. */
  readonly error?: string;
}

/** Runs one npm script in `cwd`. Injectable so tests can replace the real tooling. */
export type ScriptRunner = (script: string, cwd: string) => ScriptResult;

export const SCRIPT_TIMEOUT_MS = 120_000;

const CHECKS: readonly { readonly script: string; readonly ruleIds: readonly string[] }[] = [
  { script: 'typecheck', ruleIds: ['STD-TST-001'] },
  { script: 'lint', ruleIds: ['STD-TST-001', 'STD-TST-002'] },
  { script: 'format:check', ruleIds: ['STD-TST-001'] },
];

export const runNpmScript: ScriptRunner = (script, cwd) => {
  const result = spawnSync('npm', ['run', '--silent', script], {
    cwd,
    encoding: 'utf8',
    timeout: SCRIPT_TIMEOUT_MS,
    // npm is a .cmd shim on Windows and cannot be spawned without a shell there.
    shell: process.platform === 'win32',
  });
  const output = `${result.stdout}${result.stderr}`;
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    exitCode: result.status,
    output,
    timedOut,
    ...(result.error && !timedOut ? { error: result.error.message } : {}),
  };
};

export function checkStatic(
  artifact: { readonly proposedChanges: readonly ProposedFile[] },
  repoRoot: string,
  runScript: ScriptRunner = runNpmScript,
): GuardResult {
  const outcome = withProposedState(
    repoRoot,
    artifact.proposedChanges,
    'agents-static-',
    (copy) => {
      const failures: GuardFailure[] = [];
      for (const { script, ruleIds } of CHECKS) {
        const run = runScript(script, copy);
        if (run.exitCode === 0 && !run.timedOut && run.error === undefined) continue;
        failures.push({
          guard: 'G-STATIC',
          ruleIds,
          reason: `npm run ${script} ${describeOutcome(run)}${formatOutput(run.output, copy)}`,
        });
      }
      return failures;
    },
  );

  const failures: GuardFailure[] = outcome.ok
    ? [...outcome.value]
    : outcome.problems.map((problem) => ({ guard: 'G-STATIC', ...problem }));
  return { guard: 'G-STATIC', status: failures.length === 0 ? 'passed' : 'failed', failures };
}

function describeOutcome(outcome: ScriptResult): string {
  if (outcome.timedOut) return `timed out after ${String(SCRIPT_TIMEOUT_MS / 1000)} s`;
  if (outcome.error !== undefined) return `could not start: ${outcome.error}`;
  return `failed (exit ${String(outcome.exitCode)})`;
}
