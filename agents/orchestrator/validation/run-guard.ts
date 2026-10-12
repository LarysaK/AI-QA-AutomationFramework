import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { type ListRunner, listTests, runPlaywrightList } from './discovery-guard';
import { TEST_CLASS_FILE } from './path-guard';
import { formatOutput, withProposedState } from './proposed-state';
import type { TraceArtifact } from './trace-guard';
import type { GuardFailure, GuardResult } from './types';

/**
 * G-RUN (STD-TST-001, STD-TRC-002, STD-ART-002): the proposed tests pass in the proposed
 * repository state, and a support change leaves the whole suite passing.
 *
 * Execution-capable (STD-AUTH-005): runs proposed test bodies, a browser and the AUT. The
 * orchestrator calls this guard only with a human execution authorization for the exact
 * artifact. The temporary copy, minimal environment, private port and timeout limit accidents;
 * they are not a security sandbox.
 *
 * - Only test changes: targeted run of the proposed files, filtered by their declared TC tags.
 * - Any support change: the full suite.
 * - Neither: nothing to run.
 *
 * The run lists the proposed state first (G-DISCOVERY's listing) and compares the listed test
 * instances with the instances in the run report by Playwright's spec ID and project name.
 *
 * Assumption: `spec.id` plus `projectName` identifies the same test instance in a `--list`
 * report and in a run report of the same state. This was verified for the current approved
 * Playwright configuration (one project, default test matching) and Playwright 1.63, including
 * across separate temporary copies. It is not guaranteed across arbitrary future configuration
 * or Playwright changes (for example new projects, repeat-each or changed test directories);
 * such changes must re-verify it. A mismatch fails G-RUN rather than passing silently.
 *
 * Playwright starts the copy's own AUT on a private port (`CI=1` forbids reusing an existing
 * server), `globalSetup` resets it once for the suite, and Playwright stops it afterwards.
 */

export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: string;
}

/** Runs `playwright test` in `cwd` with extra CLI arguments. Injectable for tests. */
export type TestRunner = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
) => RunResult;

export interface RunDependencies {
  readonly runTests: TestRunner;
  readonly runList: ListRunner;
  /** A currently free local TCP port for the AUT. */
  readonly allocatePort: () => number;
  /** Whether something still accepts connections on the port. */
  readonly isPortOpen: (port: number) => boolean;
}

export const RUN_TIMEOUT_MS = 300_000;
const MAX_REPORTED_TESTS = 5;
// eslint-disable-next-line no-control-regex -- matches ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;

/** Playwright is invoked through Node directly, so a timeout signal reaches Playwright itself. */
export const runPlaywrightTests: TestRunner = (cwd, env, args) => {
  const cli = join(cwd, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = spawnSync(
    process.execPath,
    [cli, 'test', '--reporter=json', '--retries=0', ...args],
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer: 64 * 1024 * 1024,
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

/** Port helpers run in a child Node process so the guard stays synchronous. */
export function allocateFreePort(): number {
  const script =
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})";
  const port = Number(
    spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout.trim(),
  );
  if (!Number.isInteger(port) || port <= 0) throw new Error('could not allocate a free local port');
  return port;
}

export function isLocalPortOpen(port: number): boolean {
  const script = `const c=require('net').connect(${String(port)},'127.0.0.1');c.on('connect',()=>{console.log('open');c.destroy()});c.on('error',()=>console.log('closed'))`;
  return (
    spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    }).stdout.trim() === 'open'
  );
}

const REAL: RunDependencies = {
  runTests: runPlaywrightTests,
  runList: runPlaywrightList,
  allocatePort: allocateFreePort,
  isPortOpen: isLocalPortOpen,
};

/**
 * Parent variables passed to the run: what Node, npm, Playwright and the browsers need.
 * Everything else, including credentials and the caller's CI and BASE_URL, is dropped.
 */
const ENVIRONMENT_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'PLAYWRIGHT_BROWSERS_PATH',
];

export function runEnvironment(
  copy: string,
  port: number,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const temp = join(copy, '.tmp');
  const env: NodeJS.ProcessEnv = {
    FORCE_COLOR: '0',
    // CI: never reuse an existing server; forbid test.only. Retries are disabled on the CLI.
    CI: '1',
    // The approved config derives the AUT's HOST and PORT from BASE_URL.
    BASE_URL: `http://127.0.0.1:${String(port)}`,
    // Caches and temporary files stay inside the copy and are deleted with it.
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    npm_config_cache: join(temp, 'npm-cache'),
  };
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** One test instance in a run report. */
interface ExecutedInstance {
  readonly key: string;
  readonly path: string;
  readonly title: string;
  /** Playwright outcome: expected, unexpected, flaky or skipped. */
  readonly status: string;
  readonly finalResult: string;
  readonly error: string;
}

interface RunReport {
  readonly config: { readonly rootDir: string };
  readonly suites: readonly RunSuite[];
  readonly errors: readonly { readonly message?: string }[];
}

interface RunSuite {
  readonly specs?: readonly RunSpec[];
  readonly suites?: readonly RunSuite[];
}

interface RunSpec {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly tests: readonly {
    readonly projectName?: string;
    readonly status: string;
    readonly results: readonly {
      readonly status: string;
      readonly error?: { readonly message?: string };
      readonly errors?: readonly { readonly message?: string }[];
    }[];
  }[];
}

const instanceKey = (id: string, project: string): string => `${id}|${project}`;

export function checkRun(
  artifact: TraceArtifact,
  repoRoot: string,
  dependencies: Partial<RunDependencies> = {},
): GuardResult {
  const deps: RunDependencies = { ...REAL, ...dependencies };
  const proposedFiles = artifact.proposedChanges
    .filter((change) => change.changeKind === 'test-change' && TEST_CLASS_FILE.test(change.path))
    .map((change) => change.path)
    .sort();
  const declaredTcs = [
    ...new Set(
      artifact.proposedChanges
        .filter((change) => proposedFiles.includes(change.path))
        .flatMap((change) => change.traceability.testCases),
    ),
  ].sort();
  const fullSuite = artifact.proposedChanges.some(
    (change) => change.changeKind === 'support-change',
  );

  if (!fullSuite && proposedFiles.length === 0) {
    return {
      guard: 'G-RUN',
      status: 'passed',
      failures: [],
      notes: ['no tests to run: the proposal has no test or support changes'],
    };
  }

  const outcome = withProposedState(repoRoot, artifact.proposedChanges, 'agents-run-', (copy) =>
    runInCopy(copy, deps, { fullSuite, proposedFiles, declaredTcs }),
  );
  if (!outcome.ok)
    return result(outcome.problems.map((problem) => ({ guard: 'G-RUN', ...problem })));
  return outcome.value;
}

interface Plan {
  readonly fullSuite: boolean;
  readonly proposedFiles: readonly string[];
  readonly declaredTcs: readonly string[];
}

function runInCopy(copy: string, deps: RunDependencies, plan: Plan): GuardResult {
  const failures: GuardFailure[] = [];
  const fail = (ruleIds: readonly string[], reason: string, path?: string): void => {
    failures.push({ guard: 'G-RUN', ruleIds, reason, ...(path === undefined ? {} : { path }) });
  };
  mkdirSync(join(copy, '.tmp'), { recursive: true });

  // 1. Expected instances, from the same listing G-DISCOVERY uses, in this copy.
  const listing = listTests(copy, deps.runList);
  if ('failure' in listing) return result([{ ...listing.failure, guard: 'G-RUN' }]);
  const listed = listing.tests.flatMap((test) =>
    test.projects.map((project) => ({ test, key: instanceKey(test.id, project) })),
  );
  const expected = listed.filter(({ test }) => plan.proposedFiles.includes(test.path));
  const expectedKeys = new Set((plan.fullSuite ? listed : expected).map(({ key }) => key));

  // 2. Run: the full suite, or the exact proposed files filtered by their declared TC tags.
  // A port taken between allocation and startup is a collision, never a reused server.
  const port = deps.allocatePort();
  const collision = (when: string): GuardFailure => ({
    guard: 'G-RUN',
    ruleIds: ['STD-TST-001'],
    reason: `private AUT port collision: port ${String(port)} was taken by another process ${when}; an existing server is never reused`,
  });
  if (deps.isPortOpen(port)) return result([collision('before the run')]);

  const args = plan.fullSuite
    ? []
    : [
        '--grep',
        `@(${plan.declaredTcs.map(escapeRegExp).join('|')})(?![0-9])`,
        ...plan.proposedFiles.map((path) => `${escapeRegExp(`/${path}`)}$`),
      ];
  const run = deps.runTests(copy, runEnvironment(copy, port), args);

  // 3. The AUT must be stopped after the run. If the web server never started and the port is
  // held by someone else, that is a collision rather than a lingering AUT.
  const portOpenAfter = deps.isPortOpen(port);
  const webServerFailed = /webServer|already used|EADDRINUSE/i.test(`${run.stdout}${run.stderr}`);
  if (portOpenAfter && webServerFailed) return result([collision('during startup')]);
  if (portOpenAfter) {
    fail(
      ['STD-TST-001'],
      `the AUT is still listening on its private port ${String(port)} after the run`,
    );
  }

  if (run.timedOut)
    return result([...failures, runFailure(`timed out after ${String(RUN_TIMEOUT_MS / 1000)} s`)]);
  if (run.error !== undefined)
    return result([...failures, runFailure(`could not start: ${run.error}`)]);
  let report: RunReport;
  try {
    report = JSON.parse(run.stdout) as RunReport;
  } catch {
    return result([
      ...failures,
      runFailure(
        `did not produce a JSON report (exit ${String(run.exitCode)})${formatOutput(run.stderr, copy)}`,
      ),
    ]);
  }
  if (report.errors.length > 0) {
    // Run-level errors (for example a web server that could not start) make per-test
    // comparisons meaningless; report them alone.
    const errors = report.errors.map((error) => error.message ?? '').join('\n');
    return result([...failures, runFailure(`reported errors${formatOutput(errors, copy)}`)]);
  }

  // 4. Compare executed instances with the expected ones by stable spec ID and project.
  const executed = executedInstances(report, copy);
  const executedByKey = new Map(executed.map((instance) => [instance.key, instance]));
  const describe = (path: string, title: string): string => `${path} › ${title}`;

  for (const instance of executed) {
    if (!expectedKeys.has(instance.key)) {
      fail(
        ['STD-TST-001'],
        `unrelated test ran: ${describe(instance.path, instance.title)}`,
        instance.path,
      );
    }
  }

  const problems: { readonly path: string; readonly reason: string; readonly proposed: boolean }[] =
    [];
  for (const { test, key } of plan.fullSuite ? listed : expected) {
    const instance = executedByKey.get(key);
    const proposed = plan.proposedFiles.includes(test.path);
    const where = describe(test.path, test.title);
    if (instance === undefined)
      problems.push({ path: test.path, reason: `did not run: ${where}`, proposed });
    else if (instance.status === 'skipped') {
      if (proposed)
        problems.push({ path: test.path, reason: `proposed test was skipped: ${where}`, proposed });
    } else if (instance.status !== 'expected' || instance.finalResult !== 'passed') {
      const prefix = proposed ? 'proposed test' : 'unchanged test';
      problems.push({
        path: test.path,
        reason: `${prefix} ${instance.status === 'flaky' ? 'is flaky' : 'failed'}: ${where}${instance.error}`,
        proposed,
      });
    }
  }
  for (const problem of problems.slice(0, MAX_REPORTED_TESTS)) {
    const ruleIds = problem.proposed ? ['STD-TST-001'] : ['STD-TST-001', 'STD-ART-002'];
    fail(ruleIds, problem.reason, problem.path);
  }
  if (problems.length > MAX_REPORTED_TESTS) {
    fail(['STD-TST-001'], `… ${String(problems.length - MAX_REPORTED_TESTS)} more failing tests`);
  }

  // Every proposed file and every declared TC is represented by a passing instance; reported
  // only when no failing, skipped or missing instance already explains the gap.
  const explained = new Set(
    problems.filter((problem) => problem.proposed).map((problem) => problem.path),
  );
  const passing = expected.filter(({ key }) => {
    const instance = executedByKey.get(key);
    return instance?.status === 'expected' && instance.finalResult === 'passed';
  });
  for (const path of plan.proposedFiles) {
    if (!explained.has(path) && !passing.some(({ test }) => test.path === path)) {
      fail(['STD-TST-001'], 'no proposed test in this file ran and passed', path);
    }
  }
  for (const tc of plan.declaredTcs) {
    const carriers = expected.filter(({ test }) => test.tags.includes(tc));
    const unexplained = carriers.every(({ test }) => !explained.has(test.path));
    if (unexplained && !passing.some(({ test }) => test.tags.includes(tc))) {
      fail(['STD-TRC-002'], `declared ${tc} is not carried by any passing test`);
    }
  }
  if (executed.length === 0) fail(['STD-TST-001'], 'the run executed no tests');
  if (failures.length === 0 && run.exitCode !== 0) {
    fail(
      ['STD-TST-001'],
      `playwright test exited with ${String(run.exitCode)}${formatOutput(run.stderr, copy)}`,
    );
  }

  const mode = plan.fullSuite ? 'full suite (support change present)' : 'targeted run';
  return {
    ...result(failures),
    ...(failures.length === 0
      ? { notes: [`${mode}: ${String(executed.length)} test instance(s) ran and passed`] }
      : {}),
  };
}

function executedInstances(report: RunReport, copy: string): ExecutedInstance[] {
  const out: ExecutedInstance[] = [];
  const walk = (suite: RunSuite): void => {
    for (const spec of suite.specs ?? []) {
      // Same path computation as the discovery listing.
      const path = relative(copy, resolve(report.config.rootDir, spec.file)).split(sep).join('/');
      for (const test of spec.tests) {
        const last = test.results[test.results.length - 1];
        // Playwright keeps expect()'s colouring in JSON error messages; strip it.
        const message = (last?.error?.message ?? last?.errors?.[0]?.message ?? '').replace(
          ANSI,
          '',
        );
        out.push({
          key: instanceKey(spec.id, test.projectName ?? ''),
          path,
          title: spec.title,
          status: test.status,
          finalResult: last?.status ?? 'not run',
          error:
            message === '' ? '' : formatOutput(message.split('\n').slice(0, 3).join('\n'), copy),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return out;
}

function runFailure(reason: string): GuardFailure {
  return { guard: 'G-RUN', ruleIds: ['STD-TST-001'], reason: `playwright test ${reason}` };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function result(failures: GuardFailure[]): GuardResult {
  return { guard: 'G-RUN', status: failures.length === 0 ? 'passed' : 'failed', failures };
}
