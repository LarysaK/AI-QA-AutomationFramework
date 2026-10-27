import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import type { ListRunner } from './discovery-guard';
import {
  allocateFreePort,
  checkRun,
  isLocalPortOpen,
  PORT_HELPER_MARKER,
  portHelperEnvironment,
  type RunDependencies,
  runPlaywrightTests,
  runPortHelper,
  type RunResult,
  type TestRunner,
} from './run-guard';
import type { ScriptRunner } from './static-guard';
import type { TraceArtifact } from './trace-guard';
import type { GuardResult } from './types';
import { ENVELOPE_SCHEMA_PATH, outcomeOf, validateArtifact } from './validate';

/**
 * G-RUN tests. Real cases run `playwright test` with the AUT on a temporary copy of this
 * repository, which is only read. Stub cases cover the instance comparison and failure modes.
 */

const REPO = resolve('.');
const PROPOSED = 'tests/requestflow/api/run-fixture.spec.ts';

type Trace = { requirements: string[]; testCases: string[] };
type Change = TraceArtifact['proposedChanges'][number];

function proposal(...changes: Change[]): TraceArtifact {
  const requirements = [...new Set(changes.flatMap((change) => change.traceability.requirements))];
  const testCases = [...new Set(changes.flatMap((change) => change.traceability.testCases))];
  return {
    artifactType: 'test-proposal',
    agent: { name: 'generator' },
    traceability: { requirements, testCases },
    sourceReferences: [],
    proposedChanges: changes,
  };
}

const testChange = (content: string, traceability: Trace, path = PROPOSED): Change => ({
  path,
  changeKind: 'test-change',
  operation: 'create',
  content,
  traceability,
});

const supportChange = (path: string, content: string): Change => ({
  path,
  changeKind: 'support-change',
  operation: 'modify',
  content,
  traceability: { requirements: [], testCases: [] },
});

const spec = (...lines: string[]): string =>
  [
    "import { expect, test } from '@playwright/test';",
    '',
    "import { RequestFlowApi } from '../../../apps/requestflow/api/requestflow-api.client';",
    "import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';",
    '',
    ...lines,
    '',
  ].join('\n');

const REVIEWER_CREATE = (status: number, title = 'Reviewer cannot create a request'): string[] => [
  `test('${title}', { tag: ['@REQ-001', '@TC-001-15'] }, async ({ request }) => {`,
  '  const api = new RequestFlowApi(request);',
  '  await api.loginAs(DEMO_USERS.jordan);',
  "  const response = await api.createRequest({ title: 'x', description: 'y', amount: 1 });",
  `  expect(response.status()).toBe(${String(status)});`,
  '});',
];
const TC_001_15: Trace = { requirements: ['REQ-001'], testCases: ['TC-001-15'] };

interface Recorded {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
  readonly result: RunResult;
  readonly tempEntries: readonly string[];
}

/** The real runner, recording each call (and what it left in the copy's .tmp before cleanup). */
function recordingRunner(): { runTests: TestRunner; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runTests: TestRunner = (cwd, env, args) => {
    const result = runPlaywrightTests(cwd, env, args);
    calls.push({ cwd, env, args, result, tempEntries: readdirSync(join(cwd, '.tmp')) });
    return result;
  };
  return { runTests, calls };
}

/** Repository paths of the instances in a run report. */
function executedPaths(result: RunResult): string[] {
  const report = JSON.parse(result.stdout) as {
    suites: { specs?: { file: string }[]; suites?: unknown[] }[];
  };
  const paths: string[] = [];
  const walk = (suite: { specs?: { file: string }[]; suites?: unknown[] }): void => {
    for (const s of suite.specs ?? []) paths.push(`tests/${s.file}`);
    for (const child of suite.suites ?? []) walk(child as typeof suite);
  };
  report.suites.forEach(walk);
  return paths;
}

function assertFails(result: GuardResult, ruleId: string, reason: RegExp): void {
  assert.equal(result.status, 'failed', JSON.stringify(result, null, 2));
  assert.ok(
    result.failures.some(
      (failure) => failure.ruleIds.includes(ruleId) && reason.test(failure.reason),
    ),
    `expected ${ruleId} matching ${String(reason)}:\n${JSON.stringify(result.failures, null, 2)}`,
  );
}

function fingerprint(root: string): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const hash = createHash('sha256');
  hash.update(git('status', '--porcelain=v1', '-uall'));
  hash.update(git('ls-files', '-s'));
  for (const path of git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(
    '\0',
  )) {
    if (path !== '' && existsSync(join(root, path)))
      hash.update(path).update(readFileSync(join(root, path)));
  }
  return hash.digest('hex');
}

const repoBefore = fingerprint(REPO);
const allCalls: Recorded[] = [];

function realRun(
  document: TraceArtifact,
  deps: Partial<RunDependencies> = {},
): { result: GuardResult; call: Recorded } {
  const { runTests, calls } = recordingRunner();
  const result = checkRun(document, REPO, { runTests, ...deps });
  allCalls.push(...calls);
  const call = calls[0];
  assert.ok(call, `expected one Playwright run:\n${JSON.stringify(result, null, 2)}`);
  return { result, call };
}

/**
 * A process that listens on a free local port until stopped. Same clean environment and marker
 * protocol as the port helpers; rejects instead of hanging if it exits or stays silent.
 */
async function startBlocker(): Promise<{ port: number; stop: () => void }> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const s=require('net').createServer(c=>c.end());" +
        "s.on('error',e=>{console.error(e.message);process.exit(2)});" +
        `s.listen(0,'127.0.0.1',()=>console.log('${PORT_HELPER_MARKER}='+s.address().port))`,
    ],
    { env: portHelperEnvironment() },
  );
  const stop = (): void => {
    child.kill();
  };
  try {
    const port = await new Promise<number>((done, fail) => {
      let output = '';
      const timer = setTimeout(() => {
        fail(new Error('blocker did not report its port within 10 s'));
      }, 10_000);
      child.stdout.on('data', (data: Buffer) => {
        output += String(data);
        const match = new RegExp(`^${PORT_HELPER_MARKER}=(\\d+)$`, 'm').exec(output);
        if (match) {
          clearTimeout(timer);
          done(Number(match[1]));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`blocker exited with ${String(code)} before reporting its port`));
      });
    });
    return { port, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

// ---------------------------------------------------------------- real runs (AUT started)

describe('G-RUN: real runs with the AUT', () => {
  test('targeted run of one valid proposed test', () => {
    const { result, call } = realRun(
      proposal(testChange(spec(...REVIEWER_CREATE(403)), TC_001_15)),
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
    assert.deepEqual(executedPaths(call.result), [PROPOSED]);
    assert.ok(call.args.includes('--grep'));
  });

  test('targeted run of several TC IDs in one file', () => {
    const content = spec(
      "test.describe('Submit authorization', { tag: ['@REQ-003'] }, () => {",
      "  test('unauthenticated submit is rejected', { tag: ['@TC-003-04'] }, async ({ request }) => {",
      "    const response = await new RequestFlowApi(request).submitRequest('req-0001');",
      '    expect(response.status()).toBe(401);',
      '  });',
      "  test('Reviewer cannot submit', { tag: ['@TC-003-05'] }, async ({ request }) => {",
      '    const api = new RequestFlowApi(request);',
      '    await api.loginAs(DEMO_USERS.jordan);',
      "    expect((await api.submitRequest('req-0001')).status()).toBe(403);",
      '  });',
      '});',
    );
    const { result, call } = realRun(
      proposal(
        testChange(content, { requirements: ['REQ-003'], testCases: ['TC-003-04', 'TC-003-05'] }),
      ),
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
    assert.deepEqual(executedPaths(call.result), [PROPOSED, PROPOSED]);
  });

  test('a TC shared with an existing canonical test runs only the proposed file', () => {
    // TC-001-17 is also carried by CAN-001 (tests/requestflow/ui/create-request.spec.ts).
    const content = spec(
      "test('shared TC', { tag: ['@REQ-001', '@TC-001-17'] }, () => {",
      '  expect(1).toBe(1);',
      '});',
    );
    const { result, call } = realRun(
      proposal(testChange(content, { requirements: ['REQ-001'], testCases: ['TC-001-17'] })),
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
    assert.deepEqual(executedPaths(call.result), [PROPOSED]);
  });

  test('a failing proposed test fails G-RUN with its file, title and error', () => {
    const { result } = realRun(proposal(testChange(spec(...REVIEWER_CREATE(200)), TC_001_15)));
    assertFails(
      result,
      'STD-TST-001',
      /proposed test failed: .*run-fixture\.spec\.ts › Reviewer cannot create a request:\nError: expect\(received\)/,
    );
    assert.doesNotMatch(JSON.stringify(result.failures), /\\u001b/);
  });

  test('a skipped proposed test fails G-RUN', () => {
    const content = spec(
      "test.skip('skipped', { tag: ['@REQ-001', '@TC-001-15'] }, () => {",
      '  expect(1).toBe(1);',
      '});',
    );
    assertFails(
      realRun(proposal(testChange(content, TC_001_15))).result,
      'STD-TST-001',
      /proposed test was skipped/,
    );
  });

  test('a support change runs the full suite, including every canonical test', () => {
    const path = 'apps/requestflow/data/demo-users.ts';
    const extended = `${readFileSync(join(REPO, path), 'utf8')}\nexport const RUN_GUARD_MARKER = 'marker';\n`;
    const { result, call } = realRun(proposal(supportChange(path, extended)));
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
    assert.deepEqual(call.args, []);
    const paths = executedPaths(call.result);
    for (const canonical of [
      'tests/requestflow/ui/create-request.spec.ts',
      'tests/requestflow/api/create-request-validation.spec.ts',
      'tests/requestflow/api/edit-draft-request.spec.ts',
      'tests/requestflow/e2e/approve-request.spec.ts',
      'tests/requestflow/e2e/reject-request.spec.ts',
    ]) {
      assert.ok(paths.includes(canonical), `${canonical} should run`);
    }
    assert.equal(paths.length, 55);
  });

  test('a support change that breaks an unchanged canonical test at runtime fails G-RUN', () => {
    const path = 'apps/requestflow/pages/request-details.page.ts';
    const original = readFileSync(join(REPO, path), 'utf8');
    const approve = 'await this.approveButton.click();';
    assert.ok(original.includes(approve), 'fixture precondition');
    // Still type-checks and lints: approve() now clicks Reject, so CAN-004 never reaches APPROVED.
    const { result } = realRun(
      proposal(supportChange(path, original.replace(approve, 'await this.rejectButton.click();'))),
    );
    assertFails(
      result,
      'STD-ART-002',
      /unchanged test failed: tests\/requestflow\/e2e\/approve-request\.spec\.ts/,
    );
  });

  test('the AUT runs on a private port and is stopped after the run', () => {
    const { result, call } = realRun(
      proposal(testChange(spec(...REVIEWER_CREATE(403)), TC_001_15)),
    );
    assert.equal(result.status, 'passed');
    const port = Number(new URL(call.env['BASE_URL'] ?? '').port);
    assert.ok(port > 0 && port !== 3100, `private port, got ${String(port)}`);
    assert.equal(isLocalPortOpen(port), false, 'AUT must be stopped');
  });

  test('a port collision is a validation failure, never a reused server', async () => {
    const blocker = await startBlocker();
    try {
      const { port } = blocker;
      const { runTests, calls } = recordingRunner();
      const result = checkRun(
        proposal(testChange(spec(...REVIEWER_CREATE(403)), TC_001_15)),
        REPO,
        {
          runTests,
          allocatePort: () => port,
        },
      );
      allCalls.push(...calls);
      assertFails(
        result,
        'STD-TST-001',
        /private AUT port collision: port \d+ was taken by another process before the run/,
      );
      assert.equal(calls.length, 0, 'Playwright is not started on a taken port');
    } finally {
      blocker.stop();
    }
  });

  test('caches and reports stay in the copy; the approved repository is unchanged; copies are removed', () => {
    assert.ok(allCalls.length >= 8, 'every real test recorded its run');
    for (const call of allCalls) {
      assert.ok(call.env['TMPDIR']?.startsWith(call.cwd), 'TMPDIR inside the copy');
      assert.ok(call.env['npm_config_cache']?.startsWith(call.cwd), 'npm cache inside the copy');
      assert.equal(existsSync(call.cwd), false, `${call.cwd} should be removed`);
    }
    assert.ok(
      allCalls.some((call) => call.tempEntries.length > 0),
      'tool caches were written inside the copy',
    );
    assert.equal(fingerprint(REPO), repoBefore);
  });
});

// ---------------------------------------------------------------- port helpers

describe('G-RUN: port helpers', () => {
  test('ignore a NODE_OPTIONS preload that writes to stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-port-preload-'));
    const saved = process.env['NODE_OPTIONS'];
    const blocker = await startBlocker();
    try {
      writeFileSync(join(dir, 'noisy.cjs'), 'console.log("[preload] noise on stdout 12345");\n');
      process.env['NODE_OPTIONS'] = `--require ${join(dir, 'noisy.cjs')}`;
      // Precondition: a child that inherits the environment really is noisy.
      const inherited = spawnSync(process.execPath, ['-e', 'console.log(1)'], { encoding: 'utf8' });
      assert.match(inherited.stdout, /\[preload\] noise/);

      const port = allocateFreePort();
      assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, String(port));
      assert.equal(isLocalPortOpen(port), false, 'a freshly allocated port is free');
      assert.equal(isLocalPortOpen(blocker.port), true, 'a listening port is reported open');
    } finally {
      blocker.stop();
      if (saved === undefined) Reflect.deleteProperty(process.env, 'NODE_OPTIONS');
      else process.env['NODE_OPTIONS'] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the helper environment excludes NODE_OPTIONS and everything else but SystemRoot', () => {
    const parent = {
      NODE_OPTIONS: '--inspect',
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'k',
      SystemRoot: 'C:\\Windows',
    };
    assert.deepEqual(portHelperEnvironment(parent), { SystemRoot: 'C:\\Windows' });
    assert.deepEqual(portHelperEnvironment({ NODE_OPTIONS: '--inspect' }), {});
  });

  test('the marker protocol: only one exact marker line counts', () => {
    assert.equal(
      runPortHelper(
        `console.log('noise');console.log('${PORT_HELPER_MARKER}=42');console.log('more noise')`,
      ),
      '42',
    );
    assert.throws(
      () => runPortHelper("console.log('12345')"),
      /reported 0 AGENTS_PORT_HELPER lines/,
    );
    assert.throws(
      () =>
        runPortHelper(
          `console.log('${PORT_HELPER_MARKER}=1');console.log('${PORT_HELPER_MARKER}=2')`,
        ),
      /reported 2 AGENTS_PORT_HELPER lines/,
    );
    assert.throws(
      () => runPortHelper(`console.log(' ${PORT_HELPER_MARKER}=1')`),
      /reported 0/,
      'no partial-line matches',
    );
  });

  test('a failing, crashing or hanging helper throws', () => {
    assert.throws(
      () => runPortHelper("console.error('listen EPERM');process.exit(2)"),
      /exited with 2: listen EPERM/,
    );
    assert.throws(() => runPortHelper("throw new Error('boom')"), /exited with 1/);
    assert.throws(() => runPortHelper('setTimeout(()=>{},60000)', 300), /timed out after 300 ms/);
  });

  test('malformed or unknown results fail closed', () => {
    for (const value of ['abc', '0', '70000', '1.5', '-1']) {
      assert.throws(
        () => allocateFreePort(() => value),
        /could not allocate a free local port \(helper reported/,
      );
    }
    assert.throws(
      () =>
        allocateFreePort(() => {
          throw new Error('helper crashed');
        }),
      /could not allocate a free local port \(helper crashed\)/,
    );
    assert.throws(
      () => isLocalPortOpen(3100, () => 'maybe'),
      /could not determine whether port 3100 is in use/,
    );
    assert.throws(
      () =>
        isLocalPortOpen(3100, () => {
          throw new Error('helper crashed');
        }),
      /could not determine whether port 3100 is in use \(helper crashed\)/,
      'an unknown state is never reported as free',
    );
    assert.throws(() => isLocalPortOpen(Number.NaN), /not a valid TCP port/);
    assert.throws(() => isLocalPortOpen(0), /not a valid TCP port/);
  });

  test('an unknown port state stops G-RUN and the copy is still removed', () => {
    let copy = '';
    const capture: ListRunner = (cwd, env) => {
      copy = cwd;
      return listStub([A, B])(cwd, env);
    };
    assert.throws(
      () =>
        checkRun(fileProposal, REPO, {
          ...stubDeps(runStub([A, B])),
          runList: capture,
          isPortOpen: () => {
            throw new Error('could not determine whether port 45678 is in use');
          },
        }),
      /could not determine whether port 45678 is in use/,
    );
    assert.ok(copy !== '');
    assert.equal(existsSync(copy), false, 'the temporary copy is removed');
  });
});

// ---------------------------------------------------------------- stubs

interface StubInstance {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly status?: string;
  readonly result?: string;
}

const listStub =
  (instances: readonly StubInstance[]): ListRunner =>
  (cwd) => ({
    exitCode: 0,
    stdout: JSON.stringify({
      config: { rootDir: join(cwd, 'tests') },
      suites: [
        {
          specs: instances.map((i) => ({
            id: i.id,
            title: i.title,
            file: i.path.replace(/^tests\//, ''),
            tags: i.tags,
            tests: [{ projectName: 'chromium' }],
          })),
        },
      ],
      errors: [],
    }),
    stderr: '',
    timedOut: false,
  });

const runStub =
  (instances: readonly StubInstance[], overrides: Partial<RunResult> = {}): TestRunner =>
  (cwd) => ({
    exitCode: instances.every((i) => (i.status ?? 'expected') === 'expected') ? 0 : 1,
    stdout: JSON.stringify({
      config: { rootDir: join(cwd, 'tests') },
      suites: [
        {
          specs: instances.map((i) => ({
            id: i.id,
            title: i.title,
            file: i.path.replace(/^tests\//, ''),
            tests: [
              {
                projectName: 'chromium',
                status: i.status ?? 'expected',
                results: [{ status: i.result ?? 'passed' }],
              },
            ],
          })),
        },
      ],
      errors: [],
    }),
    stderr: '',
    timedOut: false,
    ...overrides,
  });

const A: StubInstance = { id: 'a', path: PROPOSED, title: 'first', tags: ['REQ-001', 'TC-001-15'] };
const B: StubInstance = {
  id: 'b',
  path: PROPOSED,
  title: 'second',
  tags: ['REQ-001', 'TC-001-15'],
};
const OTHER: StubInstance = {
  id: 'c',
  path: 'tests/requestflow/api/other.spec.ts',
  title: 'other',
  tags: ['REQ-002'],
};
const stubDeps = (
  runTests: TestRunner,
  listed: readonly StubInstance[] = [A, B, OTHER],
): Partial<RunDependencies> => ({
  runList: listStub(listed),
  runTests,
  allocatePort: () => 45678,
  isPortOpen: () => false,
});
const fileProposal = proposal(testChange(spec(...REVIEWER_CREATE(403)), TC_001_15));

describe('G-RUN: expected vs executed instances (stubs)', () => {
  test('passes when exactly the expected instances ran and passed', () => {
    assert.equal(checkRun(fileProposal, REPO, stubDeps(runStub([A, B]))).status, 'passed');
  });

  test('an expected instance that did not run fails', () => {
    assertFails(
      checkRun(fileProposal, REPO, stubDeps(runStub([A]))),
      'STD-TST-001',
      /did not run: .* › second/,
    );
  });

  test('an unrelated instance that ran fails', () => {
    assertFails(
      checkRun(fileProposal, REPO, stubDeps(runStub([A, B, OTHER]))),
      'STD-TST-001',
      /unrelated test ran: tests\/requestflow\/api\/other\.spec\.ts/,
    );
  });

  test('no matching tests: nothing ran', () => {
    const result = checkRun(fileProposal, REPO, stubDeps(runStub([], { exitCode: 1 })));
    assertFails(result, 'STD-TST-001', /the run executed no tests/);
    assertFails(result, 'STD-TST-001', /did not run/);
  });

  test('a flaky instance fails', () => {
    assertFails(
      checkRun(fileProposal, REPO, stubDeps(runStub([A, { ...B, status: 'flaky' }]))),
      'STD-TST-001',
      /is flaky/,
    );
  });

  const broken: readonly (readonly [string, Partial<RunResult>, RegExp])[] = [
    ['a timeout', { exitCode: null, timedOut: true }, /timed out after 300 s/],
    ['a malformed report', { stdout: '{ not json' }, /did not produce a JSON report/],
    ['a start failure', { exitCode: null, error: 'spawn ENOENT' }, /could not start: spawn ENOENT/],
  ];
  for (const [name, overrides, reason] of broken) {
    test(`fails on ${name}`, () => {
      assertFails(
        checkRun(fileProposal, REPO, stubDeps(runStub([A, B], overrides))),
        'STD-TST-001',
        reason,
      );
    });
  }

  test('a collision during startup (web server failed, port held elsewhere) is reported as such', () => {
    let checks = 0;
    const result = checkRun(fileProposal, REPO, {
      ...stubDeps(
        runStub([], {
          exitCode: 1,
          stderr: 'Error: Process from config.webServer was not able to start. Exit code: 1',
        }),
      ),
      isPortOpen: () => (checks += 1) > 1, // free at allocation, taken afterwards
    });
    assertFails(result, 'STD-TST-001', /private AUT port collision: .* during startup/);
    assert.equal(result.failures.length, 1);
  });

  test('an AUT still listening after the run fails', () => {
    let checks = 0;
    const result = checkRun(fileProposal, REPO, {
      ...stubDeps(runStub([A, B])),
      isPortOpen: () => (checks += 1) > 1, // free before the run, still open afterwards
    });
    assertFails(result, 'STD-TST-001', /still listening on its private port 45678/);
  });

  test('runs with the minimal environment, CI=1, a private BASE_URL and temp paths in the copy', () => {
    const saved = { secret: process.env['AGENTS_TEST_SECRET'], base: process.env['BASE_URL'] };
    process.env['AGENTS_TEST_SECRET'] = 's3cr3t';
    process.env['BASE_URL'] = 'http://example.invalid';
    try {
      let seen: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
      const capture: TestRunner = (cwd, env, args) => {
        seen = { cwd, env };
        return runStub([A, B])(cwd, env, args);
      };
      checkRun(fileProposal, REPO, stubDeps(capture));
      assert.ok(seen);
      assert.equal(seen.env['AGENTS_TEST_SECRET'], undefined);
      assert.equal(seen.env['CI'], '1');
      assert.equal(seen.env['BASE_URL'], 'http://127.0.0.1:45678');
      assert.equal(seen.env['TMPDIR'], join(seen.cwd, '.tmp'));
      assert.equal(seen.env['npm_config_cache'], join(seen.cwd, '.tmp', 'npm-cache'));
    } finally {
      for (const [name, value] of [
        ['AGENTS_TEST_SECRET', saved.secret],
        ['BASE_URL', saved.base],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });

  test('a plan-only proposal reports "no tests to run" without starting anything', () => {
    let calls = 0;
    const counting: TestRunner = (cwd, env, args) => ((calls += 1), runStub([])(cwd, env, args));
    const plan: TraceArtifact = {
      ...fileProposal,
      artifactType: 'test-plan-proposal',
      agent: { name: 'planner' },
      proposedChanges: [
        {
          path: 'specs/requestflow/test-plan.md',
          changeKind: 'plan-change',
          operation: 'modify',
          content: '',
          traceability: TC_001_15,
        },
      ],
    };
    const result = checkRun(plan, REPO, {
      ...stubDeps(counting),
      runList: () => assert.fail('no listing expected'),
    });
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.notes, [
      'no tests to run: the proposal has no test or support changes',
    ]);
    assert.equal(calls, 0);
  });
});

// ---------------------------------------------------------------- pipeline and H7

describe('G-RUN in the guard pipeline', () => {
  const AUTH_PATH = 'tests/requestflow/api/run-auth-fixture.spec.ts';
  const content = spec(...REVIEWER_CREATE(403));
  const envelope = {
    artifactType: 'test-proposal',
    schemaVersion: '2.0',
    standardVersion: '2.0',
    agent: { name: 'generator', definitionVersion: '1.0' },
    taskId: 'run-auth',
    status: 'READY',
    summary: 'Adds TC-001-15.',
    sourceReferences: [
      { path: 'specs/requestflow/test-plan.md', role: 'test-plan', ids: ['TC-001-15'] },
    ],
    traceability: { ...TC_001_15, canonicalPatterns: ['CAN-002'] },
    assumptions: [],
    findings: [],
    proposedChanges: [
      {
        path: AUTH_PATH,
        changeKind: 'test-change',
        operation: 'create',
        content,
        rationale: 'TC-001-15',
        traceability: TC_001_15,
      },
    ],
    payload: {},
  };
  const sha = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  const instance: StubInstance = {
    id: 'x',
    path: AUTH_PATH,
    title: 'Reviewer cannot create a request',
    tags: ['REQ-001', 'TC-001-15'],
  };
  const passingScripts: ScriptRunner = () => ({ exitCode: 0, output: '', timedOut: false });

  function pipeline(
    authorization: string | undefined,
    listed: readonly StubInstance[] = [instance],
  ) {
    let ran = 0;
    const runTests: TestRunner = (cwd, env, args) => (
      (ran += 1),
      runStub([instance])(cwd, env, args)
    );
    const results = validateArtifact(envelope, {
      repoRoot: REPO,
      schemaPath: resolve(ENVELOPE_SCHEMA_PATH),
      runScript: passingScripts,
      runList: listStub(listed),
      runTests,
      allocatePort: () => 45679,
      isPortOpen: () => false,
      artifactSha256: sha,
      ...(authorization === undefined ? {} : { executionAuthorization: authorization }),
    });
    const status = (guard: string): string | undefined =>
      results.find((r) => r.guard === guard)?.status;
    return { status, ran, outcome: outcomeOf(results) };
  }

  test('all seven guards pass with a matching H7 authorization', () => {
    const { status, ran, outcome } = pipeline(sha);
    assert.equal(status('G-DISCOVERY'), 'passed');
    assert.equal(status('G-RUN'), 'passed');
    assert.equal(ran, 1);
    assert.equal(outcome, 'passed');
  });

  for (const [name, authorization] of [
    ['missing', undefined],
    ['mismatched', 'e'.repeat(64)],
  ] as const) {
    test(`H7 ${name}: G-RUN is not authorized and nothing runs`, () => {
      const { status, ran, outcome } = pipeline(authorization);
      assert.equal(status('G-DISCOVERY'), 'not-authorized');
      assert.equal(status('G-RUN'), 'not-authorized');
      assert.equal(ran, 0);
      assert.equal(outcome, 'incomplete');
    });
  }

  test('a G-DISCOVERY failure prevents G-RUN', () => {
    const { status, ran, outcome } = pipeline(sha, []); // the proposed file is not discovered
    assert.equal(status('G-DISCOVERY'), 'failed');
    assert.equal(status('G-RUN'), 'skipped');
    assert.equal(ran, 0);
    assert.equal(outcome, 'failed');
  });
});
