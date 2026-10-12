import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { loadApprovedIds } from './approved-ids';
import {
  checkDiscovery,
  discoveryEnvironment,
  type ListResult,
  type ListRunner,
  runPlaywrightList,
} from './discovery-guard';
import type { ScriptRunner } from './static-guard';
import type { TraceArtifact } from './trace-guard';
import type { GuardResult } from './types';
import { ENVELOPE_SCHEMA_PATH, outcomeOf, validateArtifact } from './validate';

/**
 * G-DISCOVERY and execution-authorization tests. Real cases run `playwright test --list` on a
 * temporary copy of this repository, which is only read.
 */

const REPO = resolve('.');
const APPROVED = loadApprovedIds(REPO);
const PROPOSED = 'tests/requestflow/api/discovery-fixture.spec.ts';

type Trace = { requirements: string[]; testCases: string[] };

function proposal(content: string, traceability: Trace, path = PROPOSED): TraceArtifact {
  return {
    artifactType: 'test-proposal',
    agent: { name: 'generator' },
    traceability,
    sourceReferences: [],
    proposedChanges: [
      { path, changeKind: 'test-change', operation: 'create', content, traceability },
    ],
  };
}

const REQ3_TC5: Trace = { requirements: ['REQ-003'], testCases: ['TC-003-05'] };
const REQ3_TC45: Trace = { requirements: ['REQ-003'], testCases: ['TC-003-04', 'TC-003-05'] };

const file = (...lines: string[]): string =>
  ["import { test } from '@playwright/test';", '', ...lines, ''].join('\n');

/** The real runner, recording each temporary copy it is run in. */
const realCopies = new Set<string>();
const real: ListRunner = (cwd, env) => {
  realCopies.add(cwd);
  return runPlaywrightList(cwd, env);
};

function discover(document: TraceArtifact, runList: ListRunner = real): GuardResult {
  return checkDiscovery(document, APPROVED, REPO, runList);
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

// ---------------------------------------------------------------- real Playwright listings

describe('G-DISCOVERY: real Playwright listing', () => {
  test('a valid test with matching runtime REQ and TC tags passes', () => {
    const result = discover(
      proposal(file("test('single', { tag: ['@REQ-003', '@TC-003-05'] }, () => {});"), REQ3_TC5),
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
  });

  test('several tests in one file, REQ inherited from describe', () => {
    const content = file(
      "test.describe('submit', { tag: ['@REQ-003'] }, () => {",
      "  test('first', { tag: ['@TC-003-04'] }, () => {});",
      "  test('second', { tag: ['@TC-003-05'] }, () => {});",
      '});',
    );
    const result = discover(proposal(content, REQ3_TC45));
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
  });

  test('CAN-002-style data-driven tests: each instance carries its own TC tag', () => {
    const content = file(
      "const ROWS = [{ tc: 'TC-003-04' }, { tc: 'TC-003-05' }];",
      '',
      "test.describe('rows', { tag: ['@REQ-003'] }, () => {",
      '  for (const { tc } of ROWS) {',
      '    test(`row ${tc}`, { tag: `@${tc}` }, () => {});',
      '  }',
      '});',
    );
    const result = discover(proposal(content, REQ3_TC45));
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
  });

  test('missing runtime REQ tag: the REQ only appears in a title', () => {
    const result = discover(
      proposal(file("test('REQ-003 submit', { tag: ['@TC-003-05'] }, () => {});"), REQ3_TC5),
    );
    assertFails(result, 'STD-TRC-002', /@TC-003-05 without its requirement tag @REQ-003/);
    assertFails(result, 'STD-TRC-002', /declared REQ-003 is not tagged on any discovered test/);
  });

  test('missing runtime TC tag: the template reads the wrong field', () => {
    const content = file(
      "const ROWS = [{ tc: 'TC-003-05', name: 'row-a' }];",
      '',
      "test.describe('rows', { tag: ['@REQ-003'] }, () => {",
      '  for (const { name } of ROWS) {',
      '    test(`row ${name}`, { tag: `@${name}` }, () => {});',
      '  }',
      '});',
    );
    const result = discover(proposal(content, REQ3_TC5));
    assertFails(result, 'STD-TRC-002', /test "row row-a" has no declared @TC- tag/);
    assertFails(result, 'STD-TRC-002', /declared TC-003-05 is not tagged/);
  });

  test('incorrect runtime tag: a dynamically built, undeclared TC', () => {
    const content = file(
      'const n = 7;',
      "test('built', { tag: ['@REQ-003', `@TC-003-0${String(n)}`] }, () => {});",
    );
    assertFails(discover(proposal(content, REQ3_TC5)), 'STD-TRC-002', /undeclared tag @TC-003-07/);
  });

  test('runtime @CAN tag built dynamically', () => {
    const content = file(
      "test('canonical?', { tag: ['@REQ-003', '@TC-003-05', `@${'CAN'}-006`] }, () => {});",
    );
    assertFails(discover(proposal(content, REQ3_TC5)), 'STD-TRC-003', /canonical tag @CAN-006/);
  });

  test('an untagged extra test in a multi-test file', () => {
    const content = file(
      "test.describe('submit', { tag: ['@REQ-003'] }, () => {",
      "  test('tagged', { tag: ['@TC-003-05'] }, () => {});",
      "  test('untagged', () => {});",
      '});',
    );
    assertFails(
      discover(proposal(content, REQ3_TC5)),
      'STD-TRC-002',
      /test "untagged" has no declared @TC- tag/,
    );
  });

  test('a proposed test file that Playwright does not discover', () => {
    const result = discover(proposal(file("test.describe('empty', () => {});"), REQ3_TC5));
    assertFails(result, 'STD-TRC-002', /not discovered/);
    assert.deepEqual(result.failures[0]?.ruleIds, ['STD-TST-001', 'STD-TRC-002']);
  });

  test('existing canonical tests (with @CAN tags) are not attributed to the proposal', () => {
    // The listing also contains CAN-001 – CAN-005; only the proposed path is evaluated.
    const result = discover(
      proposal(file("test('single', { tag: ['@REQ-003', '@TC-003-05'] }, () => {});"), REQ3_TC5),
    );
    assert.equal(result.status, 'passed');
  });

  test('a module that fails to load fails the whole listing', () => {
    const content = file(
      "throw new Error('module failed during discovery');",
      "test('never listed', { tag: ['@REQ-003', '@TC-003-05'] }, () => {});",
    );
    assertFails(
      discover(proposal(content, REQ3_TC5)),
      'STD-TST-001',
      /playwright test --list failed.*\n.*module failed during discovery/,
    );
  });

  test('the approved repository is unchanged and every temporary copy is removed', () => {
    assert.equal(fingerprint(REPO), repoBefore);
    assert.ok(realCopies.size >= 11, 'every real test ran in a temporary copy');
    for (const copy of realCopies)
      assert.equal(existsSync(copy), false, `${copy} should be removed`);
  });
});

// ---------------------------------------------------------------- stubbed listings

/** A stub listing: `specs` maps repository paths to tagged test titles. */
function listing(
  specs: Record<string, { title: string; tags: string[] }[]>,
  overrides: Partial<ListResult> = {},
): ListRunner {
  return (cwd) => ({
    exitCode: 0,
    stdout: JSON.stringify({
      config: { rootDir: join(cwd, 'tests') },
      suites: Object.entries(specs).map(([path, tests]) => ({
        specs: tests.map((test) => ({
          ...test,
          id: `${path}#${test.title}`,
          file: path.replace(/^tests\//, ''),
          tests: [{ projectName: 'chromium' }],
        })),
      })),
      errors: [],
    }),
    stderr: '',
    timedOut: false,
    ...overrides,
  });
}

const VALID_FILE = file("test('single', { tag: ['@REQ-003', '@TC-003-05'] }, () => {});");

describe('G-DISCOVERY: stubbed listings', () => {
  test('other files with untraced tests are ignored; only the exact proposed path counts', () => {
    const runList = listing({
      [PROPOSED]: [{ title: 'single', tags: ['REQ-003', 'TC-003-05'] }],
      'tests/requestflow/api/other.spec.ts': [{ title: 'other', tags: ['CAN-009'] }],
      'tests/requestflow/api/discovery-fixture.spec.ts.bak': [{ title: 'near miss', tags: [] }],
    });
    assert.equal(discover(proposal(VALID_FILE, REQ3_TC5), runList).status, 'passed');
  });

  const broken: readonly (readonly [string, Partial<ListResult>, RegExp])[] = [
    ['a non-zero exit', { exitCode: 1 }, /failed \(exit 1\)/],
    ['invalid JSON', { stdout: 'not json' }, /did not produce a JSON report/],
    ['a timeout', { exitCode: null, timedOut: true }, /timed out after 120 s/],
    [
      'a start failure',
      { exitCode: null, error: 'spawn npx ENOENT' },
      /could not start: spawn npx ENOENT/,
    ],
  ];
  for (const [name, overrides, reason] of broken) {
    test(`fails on ${name}`, () => {
      const runList = listing(
        { [PROPOSED]: [{ title: 'single', tags: ['REQ-003', 'TC-003-05'] }] },
        overrides,
      );
      assertFails(discover(proposal(VALID_FILE, REQ3_TC5), runList), 'STD-TST-001', reason);
    });
  }

  test('fails on listing errors reported in the JSON', () => {
    const runList: ListRunner = (cwd) => ({
      exitCode: 0,
      stdout: JSON.stringify({
        config: { rootDir: join(cwd, 'tests') },
        suites: [],
        errors: [{ message: 'Error: boom' }],
      }),
      stderr: '',
      timedOut: false,
    });
    assertFails(discover(proposal(VALID_FILE, REQ3_TC5), runList), 'STD-TST-001', /Error: boom/);
  });

  test('runs with the minimal environment only', () => {
    const saved = {
      secret: process.env['AGENTS_TEST_SECRET'],
      ci: process.env['CI'],
      base: process.env['BASE_URL'],
    };
    process.env['AGENTS_TEST_SECRET'] = 's3cr3t';
    process.env['CI'] = '1';
    process.env['BASE_URL'] = 'http://example.invalid';
    try {
      let seen: NodeJS.ProcessEnv = {};
      const capture: ListRunner = (cwd, env) => {
        seen = env;
        return listing({ [PROPOSED]: [{ title: 'single', tags: ['REQ-003', 'TC-003-05'] }] })(
          cwd,
          env,
        );
      };
      discover(proposal(VALID_FILE, REQ3_TC5), capture);
      assert.equal(seen['AGENTS_TEST_SECRET'], undefined);
      assert.equal(seen['CI'], undefined);
      assert.equal(seen['BASE_URL'], undefined);
      assert.equal(seen['PATH'], process.env['PATH']);
      assert.equal(seen['FORCE_COLOR'], '0');
      assert.ok(
        Object.keys(seen).every(
          (name) =>
            name in discoveryEnvironment({ PATH: '', HOME: '', TMPDIR: '' }) ||
            ['USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT'].includes(name),
        ),
      );
    } finally {
      for (const [name, value] of [
        ['AGENTS_TEST_SECRET', saved.secret],
        ['CI', saved.ci],
        ['BASE_URL', saved.base],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });
});

// ---------------------------------------------------------------- execution authorization

describe('execution authorization (gate H7)', () => {
  const AUTH_PATH = 'tests/requestflow/api/discovery-auth-fixture.spec.ts';
  const envelope = {
    artifactType: 'test-proposal',
    schemaVersion: '1.0',
    standardVersion: '1.2',
    agent: { name: 'generator', definitionVersion: '1.0' },
    taskId: 'discovery-auth',
    status: 'READY',
    summary: 'Adds TC-003-05.',
    sourceReferences: [
      { path: 'specs/requestflow/test-plan.md', role: 'test-plan', ids: ['TC-003-05'] },
    ],
    traceability: { ...REQ3_TC5, canonicalPatterns: ['CAN-003'] },
    assumptions: [],
    findings: [],
    proposedChanges: [
      {
        path: AUTH_PATH,
        changeKind: 'test-change',
        operation: 'create',
        content: VALID_FILE,
        rationale: 'Implements TC-003-05.',
        traceability: REQ3_TC5,
      },
    ],
    payload: {},
  };
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2));
  const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
  const passingScripts: ScriptRunner = () => ({ exitCode: 0, output: '', timedOut: false });

  function run(options: {
    authorization?: string;
    artifactSha256?: string;
    runScript?: ScriptRunner;
    document?: unknown;
  }) {
    let listed = 0;
    const runList: ListRunner = (cwd, env) => {
      listed += 1;
      return listing({ [AUTH_PATH]: [{ title: 'single', tags: ['REQ-003', 'TC-003-05'] }] })(
        cwd,
        env,
      );
    };
    const results = validateArtifact(options.document ?? envelope, {
      repoRoot: REPO,
      schemaPath: resolve(ENVELOPE_SCHEMA_PATH),
      runScript: options.runScript ?? passingScripts,
      runList,
      // G-RUN (when authorized): the listed test runs and passes; no real AUT is started.
      runTests: (cwd) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          config: { rootDir: join(cwd, 'tests') },
          suites: [
            {
              specs: [
                {
                  id: `${AUTH_PATH}#single`,
                  title: 'single',
                  file: AUTH_PATH.replace(/^tests\//, ''),
                  tests: [
                    {
                      projectName: 'chromium',
                      status: 'expected',
                      results: [{ status: 'passed' }],
                    },
                  ],
                },
              ],
            },
          ],
          errors: [],
        }),
        stderr: '',
        timedOut: false,
      }),
      allocatePort: () => 45680,
      isPortOpen: () => false,
      ...(options.artifactSha256 === undefined ? {} : { artifactSha256: options.artifactSha256 }),
      ...(options.authorization === undefined
        ? {}
        : { executionAuthorization: options.authorization }),
    });
    const discovery = results.find((result) => result.guard === 'G-DISCOVERY');
    return { results, discovery, listed, outcome: outcomeOf(results) };
  }

  test('without authorization G-DISCOVERY is not run and the outcome is incomplete', () => {
    const { discovery, listed, outcome } = run({ artifactSha256: sha(bytes) });
    assert.equal(discovery?.status, 'not-authorized');
    assert.deepEqual(discovery.failures[0]?.ruleIds, ['STD-AUTH-005']);
    assert.equal(listed, 0);
    assert.equal(outcome, 'incomplete');
  });

  test('a matching authorization runs G-DISCOVERY', () => {
    const { discovery, listed, outcome } = run({
      artifactSha256: sha(bytes),
      authorization: sha(bytes),
    });
    assert.equal(discovery?.status, 'passed');
    assert.equal(listed, 2); // G-DISCOVERY's listing, then G-RUN's listing in its own copy
    assert.equal(outcome, 'passed');
  });

  test('a mismatched authorization does not run G-DISCOVERY', () => {
    const { discovery, listed, outcome } = run({
      artifactSha256: sha(bytes),
      authorization: 'f'.repeat(64),
    });
    assert.equal(discovery?.status, 'not-authorized');
    assert.match(discovery.failures[0]?.reason ?? '', /does not match this artifact/);
    assert.equal(listed, 0);
    assert.equal(outcome, 'incomplete');
  });

  test('changing the artifact by one byte invalidates an earlier authorization', () => {
    const changed = Buffer.concat([bytes, Buffer.from(' ')]);
    const { discovery, listed } = run({ artifactSha256: sha(changed), authorization: sha(bytes) });
    assert.equal(discovery?.status, 'not-authorized');
    assert.equal(listed, 0);
  });

  test('an authorization without the artifact digest is not accepted', () => {
    const { discovery, listed } = run({ authorization: sha(bytes) });
    assert.equal(discovery?.status, 'not-authorized');
    assert.equal(listed, 0);
  });

  test('an authorization embedded in the artifact is rejected by G-SCHEMA', () => {
    const embedded = { ...envelope, executionAuthorization: sha(bytes) };
    const { results, discovery, listed } = run({ document: embedded, artifactSha256: sha(bytes) });
    assert.equal(results[0]?.status, 'failed');
    assert.match(
      results[0].failures[0]?.reason ?? '',
      /unexpected property "executionAuthorization"/,
    );
    assert.equal(discovery?.status, 'skipped');
    assert.equal(listed, 0);
  });

  test('a G-STATIC failure prevents discovery even with a matching authorization', () => {
    const failing: ScriptRunner = () => ({ exitCode: 1, output: 'broken', timedOut: false });
    const { discovery, listed, outcome } = run({
      artifactSha256: sha(bytes),
      authorization: sha(bytes),
      runScript: failing,
    });
    assert.equal(discovery?.status, 'skipped');
    assert.equal(listed, 0);
    assert.equal(outcome, 'failed');
  });
});
