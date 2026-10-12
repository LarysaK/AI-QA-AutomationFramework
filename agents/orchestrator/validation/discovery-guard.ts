import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

import type { ApprovedIdsResult } from './approved-ids';
import { formatOutput, withProposedState } from './proposed-state';
import type { TraceArtifact } from './trace-guard';
import type { GuardFailure, GuardResult } from './types';

/**
 * G-DISCOVERY (STD-TST-001, STD-TRC-002, STD-TRC-003): Playwright discovers every proposed
 * test file in the proposed repository state, and the runtime tags of its tests match the
 * declared traceability.
 *
 * Execution-capable (STD-AUTH-005): `playwright test --list` loads the approved configuration
 * and imports every test module, including the proposed ones, so their top-level code runs.
 * Test bodies are not run, global setup does not run and the AUT is not started. The
 * orchestrator calls this guard only with a human execution authorization for the exact
 * artifact. The temporary copy, minimal environment and timeout limit accidents; they are not
 * a security sandbox.
 */

/** One `playwright test --list` run. */
export interface ListResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when Playwright could not be started. */
  readonly error?: string;
}

/** Runs the Playwright listing in `cwd` with `env`. Injectable so tests can replace it. */
export type ListRunner = (cwd: string, env: NodeJS.ProcessEnv) => ListResult;

export const LIST_TIMEOUT_MS = 120_000;

export const runPlaywrightList: ListRunner = (cwd, env) => {
  const result = spawnSync(
    'npx',
    ['--no-install', 'playwright', 'test', '--list', '--reporter=json'],
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // npx is a .cmd shim on Windows and cannot be spawned without a shell there.
      shell: process.platform === 'win32',
    },
  );
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut,
    ...(result.error && !timedOut ? { error: result.error.message } : {}),
  };
};

/**
 * The only parent variables passed to discovery: what Node, npx and Playwright need to start.
 * Everything else, including credentials, CI and BASE_URL, is dropped.
 */
const ENVIRONMENT_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
];

export function discoveryEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: '0' };
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** A discovered test instance: one Playwright spec, counted once regardless of projects. */
export interface DiscoveredTest {
  /** Playwright's spec ID: stable across copies, and equal in `--list` and run reports. */
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  /** Projects the spec runs in; one test instance per (id, project). */
  readonly projects: readonly string[];
}

interface ListedSpec {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly tags?: readonly string[];
  readonly tests?: readonly { readonly projectName?: string }[];
}

interface ListedSuite {
  readonly specs?: readonly ListedSpec[];
  readonly suites?: readonly ListedSuite[];
}

interface ListReport {
  readonly config: { readonly rootDir: string };
  readonly suites: readonly ListedSuite[];
  readonly errors: readonly { readonly message?: string }[];
}

/** Playwright's default test file pattern, as used by G-TRACE. */
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const ID_PREFIX = /^(REQ|TC|CAN)-/;

export function checkDiscovery(
  artifact: TraceArtifact,
  approved: ApprovedIdsResult,
  repoRoot: string,
  runList: ListRunner = runPlaywrightList,
): GuardResult {
  const outcome = withProposedState(
    repoRoot,
    artifact.proposedChanges,
    'agents-discovery-',
    (copy) => listTests(copy, runList),
  );
  if (!outcome.ok)
    return result(outcome.problems.map((problem) => ({ guard: 'G-DISCOVERY', ...problem })));
  if ('failure' in outcome.value) return result([outcome.value.failure]);

  const failures: GuardFailure[] = [];
  const fail = (ruleIds: readonly string[], path: string, reason: string): void => {
    failures.push({ guard: 'G-DISCOVERY', ruleIds, path, reason });
  };

  for (const change of artifact.proposedChanges) {
    if (change.changeKind !== 'test-change' || !TEST_FILE.test(change.path)) continue;
    const { path, traceability } = change;
    const declared = new Set([...traceability.requirements, ...traceability.testCases]);
    // Exact repository path: tests in other files are never attributed to this proposal.
    const tests = outcome.value.tests.filter((test) => test.path === path);

    // D1: the proposed file is discovered.
    if (tests.length === 0) {
      fail(
        ['STD-TST-001', 'STD-TRC-002'],
        path,
        'not discovered: Playwright lists no tests for this file',
      );
      continue;
    }

    for (const test of tests) {
      const ids = test.tags.filter((tag) => ID_PREFIX.test(tag));
      const at = `test "${test.title}"`;

      // D5: no canonical tag at runtime.
      for (const tag of ids.filter((id) => id.startsWith('CAN-'))) {
        fail(
          ['STD-TRC-003'],
          path,
          `${at} has the canonical tag @${tag}; only humans designate canonical tests`,
        );
      }
      // D4: every traceability tag is declared.
      for (const tag of ids.filter((id) => !id.startsWith('CAN-') && !declared.has(id))) {
        fail(['STD-TRC-002'], path, `${at} has the undeclared tag @${tag}`);
      }
      // D2: every test carries a declared test case.
      const testCases = ids.filter((id) => traceability.testCases.includes(id));
      if (testCases.length === 0) fail(['STD-TRC-002'], path, `${at} has no declared @TC- tag`);
      // D3: each test case is tagged together with the requirement that owns it.
      for (const tc of testCases) {
        const owner = approved.ids.testCases.get(tc);
        if (owner !== undefined && !ids.includes(owner)) {
          fail(['STD-TRC-002'], path, `${at} has @${tc} without its requirement tag @${owner}`);
        }
      }
    }

    // D6: every declared ID appears on at least one discovered test.
    const tagged = new Set(tests.flatMap((test) => test.tags));
    for (const id of declared) {
      if (!tagged.has(id))
        fail(['STD-TRC-002'], path, `declared ${id} is not tagged on any discovered test`);
    }
  }

  return result(failures);
}

/** Runs the listing in the copy and maps its JSON report to discovered tests. */
/** Lists the tests of the proposed state in `copy`; shared by G-DISCOVERY and G-RUN. */
export function listTests(
  copy: string,
  runList: ListRunner,
): { readonly tests: readonly DiscoveredTest[] } | { readonly failure: GuardFailure } {
  const listingFailed = (reason: string): { failure: GuardFailure } => ({
    failure: {
      guard: 'G-DISCOVERY',
      ruleIds: ['STD-TST-001'],
      reason: `playwright test --list ${reason}`,
    },
  });

  const run = runList(copy, discoveryEnvironment());
  if (run.timedOut) return listingFailed(`timed out after ${String(LIST_TIMEOUT_MS / 1000)} s`);
  if (run.error !== undefined) return listingFailed(`could not start: ${run.error}`);

  let report: ListReport;
  try {
    report = JSON.parse(run.stdout) as ListReport;
  } catch {
    return listingFailed(
      `did not produce a JSON report (exit ${String(run.exitCode)})${formatOutput(run.stderr, copy)}`,
    );
  }
  const errors = report.errors.map((error) => error.message ?? '').join('\n');
  if (run.exitCode !== 0 || report.errors.length > 0) {
    return listingFailed(
      `failed (exit ${String(run.exitCode)})${formatOutput(errors || run.stderr, copy)}`,
    );
  }

  const tests: DiscoveredTest[] = [];
  const walk = (suite: ListedSuite): void => {
    for (const spec of suite.specs ?? []) {
      const absolute = resolve(report.config.rootDir, spec.file);
      tests.push({
        id: spec.id,
        path: relative(copy, absolute).split(sep).join('/'),
        title: spec.title,
        tags: spec.tags ?? [],
        projects: (spec.tests ?? []).map((test) => test.projectName ?? ''),
      });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return { tests };
}

function result(failures: GuardFailure[]): GuardResult {
  return { guard: 'G-DISCOVERY', status: failures.length === 0 ? 'passed' : 'failed', failures };
}
