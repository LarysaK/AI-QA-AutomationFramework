import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { loadApprovedIds, parseRequirements, parseTestPlan } from './approved-ids';
import { checkTrace, idsInStringLiterals, type TraceArtifact } from './trace-guard';
import type { GuardResult } from './types';
import { ENVELOPE_SCHEMA_PATH, validateArtifact } from './validate';

/**
 * G-TRACE tests. The real approved documents are only read; every other case uses a
 * throwaway repository in the OS temp directory.
 */

const REQUIREMENTS = [
  '# Requirements',
  '',
  'Prose may mention REQ-099 without defining it.',
  '',
  '## REQ-001 — Create a request',
  '## REQ-003 — Submit a request',
  '',
].join('\n');

const TEST_PLAN = [
  '# Test plan',
  '',
  '### REQ-001 — Create a request',
  '',
  '| ID        | Scenario |',
  '| --------- | -------- |',
  '| TC-001-04 | Title    |',
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
  '| ID      | Covers                |',
  '| ------- | --------------------- |',
  '| CAN-002 | TC-001-04 (not a def) |',
  '| CAN-003 | TC-003-01             |',
  '',
  '## 7. Traceability',
  '',
  '| REQ     | Test cases |',
  '| ------- | ---------- |',
  '| REQ-001 | TC-001-04  |',
  '',
].join('\n');

const EXISTING_TEST = 'tests/requestflow/api/submit.spec.ts';

let repoRoot: string;

function writeRepo(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

before(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'agents-trace-repo-'));
  writeRepo(repoRoot, {
    'specs/requestflow/requirements.md': REQUIREMENTS,
    'specs/requestflow/test-plan.md': TEST_PLAN,
    [EXISTING_TEST]: "test('submit', { tag: ['@REQ-003', '@TC-003-01'] }, () => {});\n",
  });
  // G-STATIC lists files through Git and links node_modules.
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  mkdirSync(join(repoRoot, 'node_modules'));
});

after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixture helpers

type Trace = { requirements: string[]; testCases: string[]; canonicalPatterns?: string[] };

const tagged = (...tags: string[]): string =>
  `test('scenario', { tag: [${tags.map((tag) => `'${tag}'`).join(', ')}] }, () => {});\n`;

function testChange(content: string, traceability: Trace, overrides: Record<string, unknown> = {}) {
  return {
    path: 'tests/requestflow/api/new.spec.ts',
    changeKind: 'test-change' as const,
    operation: 'create' as const,
    content,
    traceability,
    ...overrides,
  };
}

function artifact(overrides: Partial<Record<keyof TraceArtifact, unknown>> = {}): TraceArtifact {
  const traceability = {
    requirements: ['REQ-003'],
    testCases: ['TC-003-06'],
    canonicalPatterns: ['CAN-003'],
  };
  return {
    artifactType: 'test-proposal',
    agent: { name: 'generator' },
    traceability,
    sourceReferences: [{ path: 'specs/requestflow/test-plan.md', ids: ['REQ-003', 'TC-003-06'] }],
    proposedChanges: [testChange(tagged('@REQ-003', '@TC-003-06'), traceability)],
    ...overrides,
  } as TraceArtifact;
}

function trace(document: TraceArtifact, root = repoRoot): GuardResult {
  return checkTrace(document, loadApprovedIds(root), root);
}

/** Asserts G-TRACE failed with `ruleId` and a reason matching `reason`. */
function assertTraceFails(result: GuardResult, ruleId: string, reason: RegExp): void {
  assert.equal(result.status, 'failed', JSON.stringify(result, null, 2));
  assert.ok(
    result.failures.some(
      (failure) => failure.ruleIds.includes(ruleId) && reason.test(failure.reason),
    ),
    `expected ${ruleId} matching ${String(reason)}:\n${JSON.stringify(result.failures, null, 2)}`,
  );
}

// ---------------------------------------------------------------- approved-ID parsing

describe('approved IDs: real approved documents', () => {
  test('parse the RequestFlow requirements and test plan without errors', () => {
    const { ids, errors } = loadApprovedIds(resolve('.'));
    assert.deepEqual(errors, []);
    assert.equal(ids.requirements.size, 10);
    assert.equal(ids.testCases.size, 96);
    assert.deepEqual([...ids.canonicals].sort(), [
      'CAN-001',
      'CAN-002',
      'CAN-003',
      'CAN-004',
      'CAN-005',
    ]);
    assert.equal(ids.testCases.get('TC-004-08'), 'REQ-004');
    assert.equal(ids.testCases.get('TC-010-08'), 'REQ-010');
  });
});

describe('approved IDs: structural parsing', () => {
  test('reads REQ headings only, not prose', () => {
    assert.deepEqual(parseRequirements(REQUIREMENTS), { ids: ['REQ-001', 'REQ-003'], errors: [] });
  });

  test('reads TC ownership from sections and CAN IDs from first cells only', () => {
    const plan = parseTestPlan(TEST_PLAN);
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(
      [...plan.testCases],
      [
        ['TC-001-04', 'REQ-001'],
        ['TC-001-17', 'REQ-001'],
        ['TC-003-01', 'REQ-003'],
        ['TC-003-06', 'REQ-003'],
      ],
    );
    assert.deepEqual(plan.canonicals, ['CAN-002', 'CAN-003']);
  });

  const broken: readonly (readonly [string, string, RegExp])[] = [
    [
      'TC under the wrong REQ section',
      '### REQ-003 — Submit\n| ID | S |\n| -- | - |\n| TC-001-04 | x |',
      /belongs to REQ-001/,
    ],
    [
      'non-TC row inside a REQ section',
      '### REQ-003 — Submit\n| ID | S |\n| -- | - |\n| note | x |',
      /does not start with a TC ID/,
    ],
    [
      'duplicate TC',
      '### REQ-003 — Submit\n| TC-003-01 | a |\n| TC-003-01 | b |',
      /duplicate TC-003-01/,
    ],
    ['TC row outside any REQ section', '## Other\n| TC-003-01 | a |', /outside any/],
    [
      'malformed REQ section heading',
      '### REQ-003 Submit\n| TC-003-01 | a |',
      /malformed REQ section/,
    ],
  ];
  for (const [name, plan, expected] of broken) {
    test(`rejects ${name}`, () => {
      assert.ok(
        parseTestPlan(plan).errors.some((error) => expected.test(error)),
        JSON.stringify(parseTestPlan(plan)),
      );
    });
  }

  test('rejects a malformed requirement heading', () => {
    assert.match(parseRequirements('## REQ-003 Submit a request').errors[0] ?? '', /malformed/);
  });

  test('rejects a test case owned by a REQ the requirements do not define', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-trace-orphan-'));
    try {
      writeRepo(root, {
        'specs/a/requirements.md': '## REQ-001 — A\n',
        'specs/a/test-plan.md': '### REQ-002 — B\n| TC-002-01 | x |\n',
      });
      assert.ok(
        loadApprovedIds(root).errors.some((error) =>
          /REQ-002, which .* does not define/.test(error),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects the same REQ ID in two spec directories (IDs are not namespaced)', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-trace-dup-'));
    try {
      writeRepo(root, {
        'specs/a/requirements.md': '## REQ-001 — A\n',
        'specs/a/test-plan.md': '### REQ-001 — A\n| TC-001-01 | x |\n',
        'specs/b/requirements.md': '## REQ-001 — B\n',
        'specs/b/test-plan.md': '### REQ-001 — B\n| TC-001-02 | x |\n',
      });
      assert.ok(
        loadApprovedIds(root).errors.some((error) => /REQ-001 is also defined/.test(error)),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('IDs in proposed test content', () => {
  test('finds literal tags and data-driven IDs, ignoring comments', () => {
    const source = [
      '// covers TC-003-99 in a comment only',
      "const rows = [{ tc: 'TC-001-04' }];",
      "test.describe('REQ-001 suite', { tag: ['@REQ-001'] }, () => {",
      '  for (const { tc } of rows) test(`case ${tc}`, { tag: `@${tc}` }, () => {});',
      '});',
    ].join('\n');
    assert.deepEqual(idsInStringLiterals(source).sort(), ['REQ-001', 'TC-001-04']);
  });
});

// ---------------------------------------------------------------- G-TRACE: passing

describe('G-TRACE: passing', () => {
  test('valid REQ and TC relationship with matching tags', () => {
    assert.equal(trace(artifact()).status, 'passed');
  });

  test('several TCs belonging to the claimed REQ', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-01', 'TC-003-06'] };
    const result = trace(
      artifact({
        traceability,
        proposedChanges: [testChange(tagged('@REQ-003', '@TC-003-01', '@TC-003-06'), traceability)],
      }),
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
  });

  test('data-driven tags in the CAN-002 style', () => {
    const traceability = { requirements: ['REQ-001'], testCases: ['TC-001-04', 'TC-001-17'] };
    const content = [
      "const ROWS = [{ tc: 'TC-001-04' }, { tc: 'TC-001-17' }];",
      "test.describe('suite', { tag: ['@REQ-001'] }, () => {",
      '  for (const { tc } of ROWS) test(`row ${tc}`, { tag: `@${tc}` }, () => {});',
      '});',
    ].join('\n');
    const result = trace(
      artifact({ traceability, proposedChanges: [testChange(content, traceability)] }),
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
  });

  test('passes all guards end to end', () => {
    const results = validateArtifact(
      {
        artifactType: 'test-proposal',
        schemaVersion: '1.0',
        standardVersion: '1.0',
        agent: { name: 'generator', definitionVersion: '1.0' },
        taskId: 'trace-e2e',
        status: 'READY',
        summary: 'Adds TC-003-06.',
        sourceReferences: [
          { path: 'specs/requestflow/test-plan.md', role: 'test-plan', ids: ['TC-003-06'] },
        ],
        traceability: {
          requirements: ['REQ-003'],
          testCases: ['TC-003-06'],
          canonicalPatterns: ['CAN-003'],
        },
        assumptions: [],
        findings: [],
        proposedChanges: [
          {
            ...testChange(tagged('@REQ-003', '@TC-003-06'), {
              requirements: ['REQ-003'],
              testCases: ['TC-003-06'],
            }),
            rationale: 'Implements TC-003-06.',
          },
        ],
        payload: {},
      },
      {
        repoRoot,
        schemaPath: resolve(ENVELOPE_SCHEMA_PATH),
        runScript: () => ({ exitCode: 0, output: '', timedOut: false }),
      },
    );
    assert.deepEqual(
      results.map((result) => `${result.guard}:${result.status}`),
      [
        'G-SCHEMA:passed',
        'G-PATHS:passed',
        'G-BASE:passed',
        'G-TRACE:passed',
        'G-STATIC:passed',
        // No execution authorization is given here; G-DISCOVERY is covered in its own tests.
        'G-DISCOVERY:not-authorized',
        'G-RUN:not-authorized',
      ],
    );
  });
});

// ---------------------------------------------------------------- G-TRACE: failing

describe('G-TRACE: failing', () => {
  test('unknown requirement', () => {
    const traceability = { requirements: ['REQ-003', 'REQ-099'], testCases: ['TC-003-06'] };
    assertTraceFails(
      trace(artifact({ traceability })),
      'STD-TRC-001',
      /unknown requirement REQ-099/,
    );
  });

  test('unknown test case', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-99'] };
    assertTraceFails(
      trace(artifact({ traceability })),
      'STD-TRC-001',
      /unknown test case TC-003-99/,
    );
  });

  test('test case belongs to a different requirement', () => {
    const traceability = { requirements: ['REQ-001'], testCases: ['TC-003-06'] };
    assertTraceFails(
      trace(artifact({ traceability })),
      'STD-TRC-001',
      /TC-003-06 belongs to REQ-003/,
    );
  });

  test('envelope traceability and proposed test tags disagree', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-06'] };
    const result = trace(
      artifact({ proposedChanges: [testChange(tagged('@REQ-003', '@TC-003-01'), traceability)] }),
    );
    assertTraceFails(result, 'STD-TRC-002', /declared TC-003-06 is missing/);
    assertTraceFails(
      result,
      'STD-TRC-002',
      /references TC-003-01, which its traceability does not declare/,
    );
  });

  test('missing REQ tag', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-06'] };
    const result = trace(
      artifact({ proposedChanges: [testChange(tagged('@TC-003-06'), traceability)] }),
    );
    assertTraceFails(result, 'STD-TRC-002', /declared REQ-003 is missing/);
  });

  test('missing TC tag (an ID in a comment does not count)', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-06'] };
    const content = `// @TC-003-06\n${tagged('@REQ-003')}`;
    const result = trace(artifact({ proposedChanges: [testChange(content, traceability)] }));
    assertTraceFails(result, 'STD-TRC-002', /declared TC-003-06 is missing/);
  });

  test('proposed @CAN tag', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-06'] };
    const content = tagged('@REQ-003', '@TC-003-06', '@CAN-006');
    assertTraceFails(
      trace(artifact({ proposedChanges: [testChange(content, traceability)] })),
      'STD-TRC-003',
      /canonical \(@CAN-\) tag/,
    );
  });

  test('Generator test proposal without approved traceability', () => {
    const empty = { requirements: [], testCases: [] };
    const result = trace(
      artifact({ traceability: empty, proposedChanges: [testChange(tagged(), empty)] }),
    );
    assertTraceFails(
      result,
      'STD-TRC-001',
      /must cite at least one approved requirement and test case/,
    );
    assertTraceFails(
      result,
      'STD-TRC-001',
      /generated test must cite at least one approved test case/,
    );
  });

  test('a change citing IDs the artifact does not claim', () => {
    const changeTrace = { requirements: ['REQ-003'], testCases: ['TC-003-01'] };
    const result = trace(
      artifact({ proposedChanges: [testChange(tagged('@REQ-003', '@TC-003-01'), changeTrace)] }),
    );
    assertTraceFails(result, 'STD-TRC-001', /TC-003-01 is not in the artifact's traceability/);
  });

  test('an unknown ID in sourceReferences', () => {
    const result = trace(
      artifact({
        sourceReferences: [{ path: 'specs/requestflow/test-plan.md', ids: ['TC-003-77'] }],
      }),
    );
    assertTraceFails(result, 'STD-TRC-001', /sourceReferences: unknown ID TC-003-77/);
  });

  test('a modified test that changes its IDs', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-01', 'TC-003-06'] };
    const result = trace(
      artifact({
        artifactType: 'heal-proposal',
        agent: { name: 'healer' },
        traceability,
        proposedChanges: [
          testChange(
            tagged('@REQ-003', '@TC-003-06'),
            { requirements: ['REQ-003'], testCases: ['TC-003-06'] },
            {
              path: EXISTING_TEST,
              operation: 'modify',
            },
          ),
        ],
      }),
    );
    assertTraceFails(
      result,
      'STD-TRC-003',
      /changes its IDs from \[REQ-003, TC-003-01\] to \[REQ-003, TC-003-06\]/,
    );
  });

  test('a provisional Planner TC ID is not approved traceability', () => {
    const traceability = { requirements: ['REQ-003'], testCases: ['TC-003-09'] };
    const result = trace(
      artifact({
        artifactType: 'test-plan-proposal',
        agent: { name: 'planner' },
        traceability,
        proposedChanges: [
          {
            path: 'specs/requestflow/test-plan.md',
            changeKind: 'plan-change',
            operation: 'modify',
            content: '',
            traceability,
          },
        ],
      }),
    );
    assertTraceFails(result, 'STD-TRC-001', /unknown test case TC-003-09/);
  });

  test('fails closed when the approved documents cannot be parsed', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-trace-broken-'));
    try {
      writeRepo(root, {
        'specs/requestflow/requirements.md': REQUIREMENTS,
        'specs/requestflow/test-plan.md': '### REQ-003 — Submit\n| TC-001-04 | misplaced |\n',
      });
      assertTraceFails(trace(artifact(), root), 'STD-TRC-001', /approved sources cannot be parsed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
