import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { gitBlobSha } from './base-guard';
import { checkPaths } from './path-guard';
import type { ScriptRunner } from './static-guard';
import type { Artifact, GuardName, GuardResult } from './types';
import { PAYLOAD_SCHEMA_PATHS } from './schema-guard';
import { ENVELOPE_SCHEMA_PATH, validateArtifact } from './validate';

/**
 * Validator tests. Each run builds a small throwaway repository in the OS temp directory;
 * the real repository is only read for the envelope schema and the Healer payload schema.
 */

const SCHEMA_PATH = resolve(ENVELOPE_SCHEMA_PATH);
const HEALER_PAYLOAD_SCHEMA = PAYLOAD_SCHEMA_PATHS['heal-proposal'] ?? '';

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture" }\n',
  'specs/requestflow/requirements.md': [
    '# Requirements',
    '',
    '## REQ-001 — Create a request',
    '## REQ-003 — Submit a request',
    '',
  ].join('\n'),
  'specs/requestflow/test-plan.md': [
    '# Test plan',
    '',
    '### REQ-001 — Create a request',
    '',
    '| ID        | Scenario |',
    '| --------- | -------- |',
    '| TC-001-17 | Create   |',
    '',
    '### REQ-003 — Submit a request',
    '',
    '| ID        | Scenario |',
    '| --------- | -------- |',
    '| TC-003-01 | Submit   |',
    '| TC-003-06 | Others   |',
    '',
    '## 3. Canonical',
    '',
    '| ID      | Title  |',
    '| ------- | ------ |',
    '| CAN-001 | Create |',
    '| CAN-003 | Edit   |',
    '',
  ].join('\n'),
  'tests/requestflow/ui/create-request.spec.ts':
    "test('x', { tag: ['@REQ-001', '@CAN-001'] }, () => {});\n",
  'tests/requestflow/api/plain.spec.ts':
    "test('y', { tag: ['@REQ-003', '@TC-003-01'] }, () => {});\n",
  'apps/requestflow/app/src/main.ts': 'export {};\n',
  'apps/requestflow/pages/login.page.ts': 'export class LoginPage {}\n',
};

let repoRoot: string;
let outsideDir: string;

before(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'agents-validate-repo-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'agents-validate-outside-'));
  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), content);
  }
  // G-SCHEMA validates a heal-proposal payload against the committed Healer payload schema.
  mkdirSync(dirname(join(repoRoot, HEALER_PAYLOAD_SCHEMA)), { recursive: true });
  writeFileSync(join(repoRoot, HEALER_PAYLOAD_SCHEMA), readFileSync(HEALER_PAYLOAD_SCHEMA));
  // A directory inside tests/ that points outside the repository.
  symlinkSync(outsideDir, join(repoRoot, 'tests/escape'));
  // G-STATIC lists files through Git and links node_modules.
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  mkdirSync(join(repoRoot, 'node_modules'));
});

after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixture helpers

type Change = Record<string, unknown>;

function change(overrides: Change = {}): Change {
  return {
    path: 'tests/requestflow/api/submit-request.spec.ts',
    changeKind: 'test-change',
    operation: 'create',
    content: "test('submit', { tag: ['@REQ-003', '@TC-003-06'] }, () => {});\n",
    rationale: 'Implements TC-003-06.',
    traceability: { requirements: ['REQ-003'], testCases: ['TC-003-06'] },
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactType: 'test-proposal',
    schemaVersion: '1.0',
    standardVersion: '1.0',
    agent: { name: 'generator', definitionVersion: '1.0' },
    taskId: 'gen-tc-003-06',
    status: 'READY',
    summary: 'Adds TC-003-06.',
    sourceReferences: [
      { path: 'specs/requestflow/requirements.md', role: 'requirements', ids: ['REQ-003'] },
    ],
    traceability: {
      requirements: ['REQ-003'],
      testCases: ['TC-003-06'],
      canonicalPatterns: ['CAN-003'],
    },
    assumptions: [],
    findings: [],
    proposedChanges: [change()],
    payload: {},
    ...overrides,
  };
}

/** A schema-valid Healer envelope: these tests are about the path and base guards. */
const healer = {
  artifactType: 'heal-proposal',
  agent: { name: 'healer', definitionVersion: '1.0' },
  payload: {
    modelCall: 'offline-recorded-output',
    requestedModel: null,
    servedModel: 'recorded-output',
    effort: null,
    maxTokens: null,
    definitionVersion: '1.0',
    failure: {
      reportName: 'report.json',
      reportSha256: '0'.repeat(64),
      playwrightVersion: '1.50.0',
      specId: 'spec-1',
      testFile: 'tests/requestflow/api/plain.spec.ts',
      title: 'y',
      line: 1,
      project: 'api',
      attempts: ['failed'],
      startedAt: '2026-01-01T00:00:00.000Z',
    },
    evidence: [{ id: 'E-001', kind: 'error-message', source: 'report', sha256: '0'.repeat(64) }],
    diagnosis: {
      classification: 'test-code-issue',
      explanation: 'Fixture diagnosis.',
      evidenceRefs: ['E-001'],
      confidence: 'medium',
      alternatives: [],
      missingEvidence: [],
      recommendedInvestigation: [],
    },
    repair: {
      expectedBehaviorPreserved: 'Fixture.',
      risks: [],
      validationSteps: [],
      humanReview: 'required',
      reviewGate: 'H3',
    },
  },
};

function shaOf(path: string): string {
  return gitBlobSha(readFileSync(join(repoRoot, path)));
}

/** G-STATIC's real checks are covered in static-guard.test.ts; here every script passes. */
const passingScripts: ScriptRunner = () => ({ exitCode: 0, output: '', timedOut: false });

function validate(document: unknown): GuardResult[] {
  return validateArtifact(document, {
    repoRoot,
    schemaPath: SCHEMA_PATH,
    runScript: passingScripts,
  });
}

function statusOf(results: readonly GuardResult[], guard: GuardName): string | undefined {
  return results.find((result) => result.guard === guard)?.status;
}

/** Asserts that `guard` failed with `ruleId`, optionally for `path`, and later guards were skipped. */
function assertFailed(
  results: readonly GuardResult[],
  guard: GuardName,
  ruleId: string,
  path?: string,
): void {
  const result = results.find((entry) => entry.guard === guard);
  assert.equal(
    result?.status,
    'failed',
    `${guard} should fail:\n${JSON.stringify(results, null, 2)}`,
  );
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.ruleIds.includes(ruleId) && (path === undefined || failure.path === path),
    ),
    `${guard} should report ${ruleId}${path === undefined ? '' : ` for ${path}`}:\n${JSON.stringify(result.failures, null, 2)}`,
  );
  const order: GuardName[] = [
    'G-SCHEMA',
    'G-PATHS',
    'G-BASE',
    'G-TRACE',
    'G-STATIC',
    'G-DISCOVERY',
    'G-RUN',
  ];
  for (const later of order.slice(order.indexOf(guard) + 1)) {
    assert.equal(
      statusOf(results, later),
      'skipped',
      `${later} should be skipped after ${guard} fails`,
    );
  }
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path] = readFileSync(path, 'utf8');
    }
  }
  return files;
}

// ---------------------------------------------------------------- passing proposals

describe('passing proposals', () => {
  test('generator creates a new non-canonical test', () => {
    const results = validate(artifact());
    assert.deepEqual(
      results.map((result) => result.status),
      ['passed', 'passed', 'passed', 'passed', 'passed', 'not-authorized', 'not-authorized'],
    );
  });

  test('generator modifies a page object with the correct baseSha (support-change)', () => {
    const path = 'apps/requestflow/pages/login.page.ts';
    const results = validate(
      artifact({
        proposedChanges: [
          change({
            path,
            changeKind: 'support-change',
            operation: 'modify',
            baseSha: shaOf(path),
            impact: 'Adds a locator; existing tests using LoginPage are unaffected.',
          }),
        ],
      }),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['passed', 'passed', 'passed', 'passed', 'passed', 'not-authorized', 'not-authorized'],
    );
  });

  test('gitBlobSha matches `git hash-object`', () => {
    const file = join(repoRoot, 'apps/requestflow/pages/login.page.ts');
    const expected = execFileSync('git', ['hash-object', '--no-filters', file], {
      encoding: 'utf8',
    }).trim();
    assert.equal(gitBlobSha(readFileSync(file)), expected);
  });
});

// ---------------------------------------------------------------- G-SCHEMA

describe('G-SCHEMA', () => {
  test('rejects a schema-invalid artifact', () => {
    const invalid = artifact({ confidence: 0.9 });
    delete invalid['summary'];
    const results = validate(invalid);
    assertFailed(results, 'G-SCHEMA', 'STD-ART-001');
    const reasons = results[0]?.failures.map((failure) => failure.reason) ?? [];
    assert.ok(reasons.some((reason) => reason.includes('"summary"')));
    assert.ok(reasons.some((reason) => reason.includes('"confidence"')));
  });

  test('maps a support-change without impact to STD-ART-002', () => {
    const results = validate(
      artifact({
        proposedChanges: [
          change({ path: 'apps/requestflow/pages/new.page.ts', changeKind: 'support-change' }),
        ],
      }),
    );
    assertFailed(results, 'G-SCHEMA', 'STD-ART-002');
  });
});

// ---------------------------------------------------------------- G-PATHS

describe('G-PATHS', () => {
  test('rejects modification of the protected requirements', () => {
    const path = 'specs/requestflow/requirements.md';
    const results = validate(
      artifact({
        ...healer,
        proposedChanges: [change({ path, operation: 'modify', baseSha: shaOf(path) })],
      }),
    );
    assertFailed(results, 'G-PATHS', 'STD-AUTH-002', path);
  });

  test('rejects modification of a canonical test file (identified by @CAN tag)', () => {
    const path = 'tests/requestflow/ui/create-request.spec.ts';
    const results = validate(
      artifact({
        ...healer,
        proposedChanges: [change({ path, operation: 'modify', baseSha: shaOf(path) })],
      }),
    );
    assertFailed(results, 'G-PATHS', 'STD-CAN-001', path);
  });

  test('rejects a Generator change to the AUT source', () => {
    const path = 'apps/requestflow/app/src/main.ts';
    const results = validate(
      artifact({
        proposedChanges: [
          change({
            path,
            changeKind: 'support-change',
            operation: 'modify',
            baseSha: shaOf(path),
            impact: 'x',
          }),
        ],
      }),
    );
    assertFailed(results, 'G-PATHS', 'STD-AUTH-002', path);
    assert.match(results[1]?.failures[0]?.reason ?? '', /AUT source/);
  });

  test('rejects a changeKind that does not match the path class', () => {
    const path = 'apps/requestflow/pages/new.page.ts';
    const results = validate(
      artifact({ proposedChanges: [change({ path, changeKind: 'test-change' })] }),
    );
    assertFailed(results, 'G-PATHS', 'STD-AUTH-002', path);
    assert.match(results[1]?.failures[0]?.reason ?? '', /requires "support-change"/);
  });

  for (const path of [
    'tests/requestflow/tsconfig.json',
    'tests/requestflow/eslint.config.mjs',
    'tests/requestflow/playwright.config.ts',
    'tests/requestflow/helper.js',
    'tests/requestflow/helpers.ts',
    'tests/requestflow/api/legacy.spec.js',
  ]) {
    test(`rejects a non-test file under tests/: ${path}`, () => {
      const results = validate(artifact({ proposedChanges: [change({ path })] }));
      assertFailed(results, 'G-PATHS', 'STD-AUTH-002', path);
      assert.match(results[1]?.failures[0]?.reason ?? '', /only TypeScript Playwright test files/);
    });
  }

  test('accepts *.spec.ts and *.test.ts files under tests/', () => {
    for (const path of [
      'tests/requestflow/api/x.spec.ts',
      'tests/requestflow/deep/nested/y.test.ts',
    ]) {
      const result = checkPaths(
        {
          agent: { name: 'generator' },
          proposedChanges: [{ path, changeKind: 'test-change', operation: 'create' }],
        },
        repoRoot,
      );
      assert.equal(result.status, 'passed', `${path}: ${JSON.stringify(result.failures)}`);
    }
  });

  test('rejects paths outside every allowed class (default deny)', () => {
    const path = 'README.md';
    const results = validate(artifact({ proposedChanges: [change({ path })] }));
    assertFailed(results, 'G-PATHS', 'STD-AUTH-002', path);
    assert.match(results[1]?.failures[0]?.reason ?? '', /default deny/);
  });

  test('rejects an operation the agent is not permitted for the class', () => {
    const path = 'tests/requestflow/api/plain.spec.ts';
    const results = validate(
      artifact({ proposedChanges: [change({ path, operation: 'modify', baseSha: shaOf(path) })] }),
    );
    assertFailed(results, 'G-PATHS', 'STD-AUTH-002', path);
    assert.match(results[1]?.failures[0]?.reason ?? '', /may not "modify"/);
  });

  test('rejects a protected path written with different letter case', () => {
    const path = 'Specs/RequestFlow/Requirements.md';
    const results = validate(artifact({ proposedChanges: [change({ path })] }));
    assertFailed(results, 'G-PATHS', 'STD-AUTH-002', path);
  });

  test('rejects path traversal (schema and path guard independently)', () => {
    const path = 'tests/../agents/standard/standard.md';
    // Layer 1: the envelope schema rejects ".." segments.
    assertFailed(
      validate(artifact({ proposedChanges: [change({ path })] })),
      'G-SCHEMA',
      'STD-AUTH-002',
    );
    // Layer 2: the path guard rejects it even when called directly.
    const direct = checkPaths(
      {
        agent: { name: 'generator' },
        proposedChanges: [{ path, changeKind: 'test-change', operation: 'create' }],
      },
      repoRoot,
    );
    assert.equal(direct.status, 'failed');
    assert.match(direct.failures[0]?.reason ?? '', /segments/);
  });

  test('rejects absolute paths and symlinks that leave the repository', () => {
    const changes: Artifact['proposedChanges'] = [
      { path: '/etc/hosts', changeKind: 'test-change', operation: 'create' },
      { path: 'tests/escape/evil.spec.ts', changeKind: 'test-change', operation: 'create' },
    ];
    const result = checkPaths({ agent: { name: 'generator' }, proposedChanges: changes }, repoRoot);
    assert.equal(result.status, 'failed');
    assert.deepEqual(
      result.failures.map((failure) => failure.path),
      ['/etc/hosts', 'tests/escape/evil.spec.ts'],
    );
    assert.match(result.failures[1]?.reason ?? '', /symlink/);
  });
});

// ---------------------------------------------------------------- G-BASE

describe('G-BASE', () => {
  test('rejects create when the file already exists', () => {
    const path = 'tests/requestflow/api/plain.spec.ts';
    assertFailed(
      validate(artifact({ proposedChanges: [change({ path })] })),
      'G-BASE',
      'STD-AUTH-003',
      path,
    );
  });

  test('rejects modify when the file does not exist', () => {
    const path = 'tests/requestflow/api/missing.spec.ts';
    const results = validate(
      artifact({
        ...healer,
        proposedChanges: [change({ path, operation: 'modify', baseSha: 'a'.repeat(40) })],
      }),
    );
    assertFailed(results, 'G-BASE', 'STD-AUTH-003', path);
  });

  test('rejects a stale baseSha instead of overwriting newer work', () => {
    const path = 'tests/requestflow/api/plain.spec.ts';
    const stale = gitBlobSha(Buffer.from('an older version of the file\n'));
    const results = validate(
      artifact({
        ...healer,
        proposedChanges: [change({ path, operation: 'modify', baseSha: stale })],
      }),
    );
    assertFailed(results, 'G-BASE', 'STD-AUTH-003', path);
    assert.match(results[2]?.failures[0]?.reason ?? '', /stale proposal/);
  });
});

// ---------------------------------------------------------------- read-only

describe('read-only', () => {
  test('validation never changes the repository it checks', () => {
    const before = snapshot(repoRoot);
    const path = 'tests/requestflow/api/plain.spec.ts';
    validate(artifact());
    validate(
      artifact({
        ...healer,
        proposedChanges: [change({ path, operation: 'modify', baseSha: shaOf(path) })],
      }),
    );
    validate(
      artifact({ proposedChanges: [change({ path: 'specs/requestflow/requirements.md' })] }),
    );
    assert.deepEqual(snapshot(repoRoot), before);
  });
});
