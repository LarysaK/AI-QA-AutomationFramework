import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import type { ListResult, ListRunner } from '../../agents/orchestrator/validation/discovery-guard';
import { buildSnapshot, serializeSnapshot, validateSnapshot } from './build';
import { discoverInventory, type GitProbe, gitProbe, uncommittedFromStatus } from './inventory';
import { publicSafetyFindings } from './sanitize';
import { gitBlobSha, SnapshotError } from './spec-source';

const REPO = resolve('.');

// ---------------------------------------------------------------- fixtures

const REQUIREMENTS = `# Demo — Requirements v1

# Requirements

## REQ-001 — Create a thing

Users create things.

---

## REQ-002 — Delete a thing

Users delete things.
`;

const TEST_PLAN = `# Demo — Test Plan v1

| Item  | Value             |
| ----- | ----------------- |
| Scope | REQ-001 – REQ-002 |

This plan is a fixture.

---

## 1. Strategy

Test through the API.

## 2. Test inventory

Test case IDs use the form \`TC-NNN-NN\`.

### REQ-001 — Create a thing

| ID        | Scenario                 | Level | Type     | Automation | Priority |
| --------- | ------------------------ | ----- | -------- | ---------- | -------- |
| TC-001-01 | Create a thing → \`201\` | API   | Positive | Yes        | P0       |
| TC-001-02 | Create a thing in the UI | UI    | Positive | No         | P1       |

A note about REQ-001.

### REQ-002 — Delete a thing

| ID        | Scenario                 | Level | Type     | Automation | Priority |
| --------- | ------------------------ | ----- | -------- | ---------- | -------- |
| TC-002-01 | Delete a thing → \`204\` | E2E   | Negative | Yes        | P2       |

## 3. Canonical automation candidates

These are reference tests.

| ID      | Title  | Level | Covers    |
| ------- | ------ | ----- | --------- |
| CAN-001 | Create | API   | TC-001-01 |

### CAN-001 — Create (API)

**Purpose:** reference creation.
`;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixtureRepo(requirements = REQUIREMENTS, plan: string | null = TEST_PLAN): string {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-data-'));
  roots.push(root);
  mkdirSync(join(root, 'specs', 'demo'), { recursive: true });
  writeFileSync(join(root, 'specs', 'demo', 'requirements.md'), requirements);
  if (plan !== null) writeFileSync(join(root, 'specs', 'demo', 'test-plan.md'), plan);
  return root;
}

interface Spec {
  id: string;
  title: string;
  file: string;
  line: number;
  tags: string[];
  [extra: string]: unknown;
}

function spec(id: string, tags: string[], file = 'demo/a.spec.ts', line = 5): Spec {
  return {
    id,
    title: `test ${id}`,
    file,
    line,
    tags,
    column: 3,
    tests: [
      {
        projectName: 'chromium',
        annotations: [{ type: 'note', description: '/Users/someone/notes' }],
        results: [{ stdout: ['/Users/someone/leak'], stderr: ['ANTHROPIC_API_KEY=x'] }],
      },
    ],
  };
}

const DEFAULT_SPECS = [
  spec('aaaa1111-bbbb0001', ['@REQ-001', '@TC-001-01', '@CAN-001', '@smoke']),
  spec('aaaa1111-bbbb0002', ['@REQ-002', '@TC-002-01'], 'demo/b.spec.ts', 9),
];

/** A `--list` JSON report as Playwright writes it, including fields that must never be copied. */
function listReport(root: string, specs: Spec[] = DEFAULT_SPECS, rootDir = join(root, 'tests')) {
  const files = [...new Set(specs.map((s) => s.file))].sort();
  return {
    config: {
      rootDir,
      version: '1.63.0',
      argv: ['/Users/someone/.nvm/node', join(root, 'node_modules/.bin/playwright')],
      configFile: join(root, 'playwright.config.ts'),
      webServer: { env: { REQUESTFLOW_TEST_HOOKS: '1', SECRET_TOKEN: 'sk-ant-api03-abcdefghij' } },
    },
    suites: files.map((file) => ({
      title: file,
      file,
      specs: [],
      suites: [
        {
          title: `Describe ${file}`,
          file,
          specs: specs.filter((s) => s.file === file),
          suites: [],
        },
      ],
    })),
    errors: [],
  };
}

function runner(
  report: unknown,
  overrides: Partial<ListResult> = {},
): ListRunner & { calls: number } {
  const state = { calls: 0 };
  const run: ListRunner = () => {
    state.calls += 1;
    return {
      exitCode: 0,
      stdout: JSON.stringify(report),
      stderr: '/Users/someone/stderr-leak',
      timedOut: false,
      ...overrides,
    };
  };
  return Object.defineProperty(run, 'calls', { get: () => state.calls }) as ListRunner & {
    calls: number;
  };
}

function fakeGit(
  tracked: string[] = [
    'specs/demo/requirements.md',
    'specs/demo/test-plan.md',
    'tests/demo/a.spec.ts',
    'tests/demo/b.spec.ts',
  ],
  uncommitted: Record<string, string[]> = {},
): GitProbe {
  return {
    trackedFiles: (dir) => new Set(tracked.filter((path) => path.startsWith(`${dir}/`))),
    uncommittedPaths: (paths) => paths.flatMap((path) => uncommitted[path] ?? []),
    head: () => 'c'.repeat(40),
  };
}

function build(
  root: string,
  options: { git?: GitProbe; runList?: ListRunner; specs?: Spec[] } = {},
): Record<string, unknown> {
  return buildSnapshot(root, {
    app: 'demo',
    git: options.git ?? fakeGit(),
    runList: options.runList ?? runner(listReport(root, options.specs)),
    safety: { forbiddenLiterals: [root] },
  }) as Record<string, unknown>;
}

function problemsOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SnapshotError, `expected a SnapshotError, got ${String(error)}`);
    return error.problems.join('\n');
  }
  assert.fail('expected the build to fail');
}

// ---------------------------------------------------------------- the real repository

describe('dashboard data: the approved RequestFlow documents and committed tests', () => {
  interface Real {
    source: { commit: string; documents: { path: string; gitBlobSha: string }[] };
    summary: Record<string, unknown>;
    testCases: { id: string; requirementId: string; automationLinkage: { status: string } }[];
    testInstances: unknown[];
    execution: unknown;
  }
  // Built inside the tests, so a refused build fails them by name instead of the whole file.
  let built: Real | undefined;
  const first = (): Real => (built ??= buildSnapshot(REPO) as Real);

  test('matches the approved plan counts and the current committed tests', () => {
    assert.deepEqual(first().summary, {
      requirements: 10,
      testCases: 96,
      testCasesByLevel: { API: 82, UI: 11, E2E: 3 },
      testCasesByPriority: { P0: 38, P1: 50, P2: 8 },
      testCasesByAutomationIntent: { Yes: 94, No: 2 },
      canonicals: 5,
      testInstances: 30,
      linkedTestCases: 21,
      linkedTestCasesWithIntentYes: 21,
    });
    const perRequirement: Record<string, number> = {};
    for (const tc of first().testCases) {
      if (tc.automationLinkage.status === 'linked') {
        perRequirement[tc.requirementId] = (perRequirement[tc.requirementId] ?? 0) + 1;
      }
    }
    assert.deepEqual(perRequirement, {
      'REQ-001': 12,
      'REQ-002': 3,
      'REQ-003': 1,
      'REQ-004': 1,
      'REQ-005': 1,
      'REQ-006': 2,
      'REQ-008': 1,
    });
  });

  test('is schema-valid, public-safe and byte-identical when rebuilt', () => {
    assert.deepEqual(validateSnapshot(first()), []);
    const text = serializeSnapshot(first());
    assert.equal(serializeSnapshot(buildSnapshot(REPO)), text);
    assert.ok(!text.includes(REPO), 'no absolute repository path');
    assert.ok(
      !text.includes('artifacts/'),
      'nothing from artifacts/ (results, reports, proposals)',
    );
  });

  test('records the exact source documents and commit', () => {
    for (const document of first().source.documents) {
      const sha = execFileSync('git', ['hash-object', document.path], { encoding: 'utf8' }).trim();
      assert.equal(document.gitBlobSha, sha, document.path);
    }
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(first().source.commit, head);
  });

  test('states that no CI runs exist and local results are not used', () => {
    assert.deepEqual(first().execution, {
      ci: { status: 'no-ci-runs', runs: [] },
      localResults: 'not-used',
    });
  });
});

// ---------------------------------------------------------------- fixture builds

describe('dashboard data: fixture build', () => {
  test('keeps intent, linkage and (absent) execution separate, and scenarios verbatim', () => {
    const snapshot = build(fixtureRepo()) as {
      testCases: Record<string, unknown>[];
      summary: Record<string, unknown>;
    };
    assert.deepEqual(validateSnapshot(snapshot), []);
    assert.deepEqual(snapshot.testCases[1], {
      id: 'TC-001-02',
      requirementId: 'REQ-001',
      scenario: 'Create a thing in the UI',
      level: 'UI',
      type: 'Positive',
      priority: 'P1',
      automationIntent: 'No',
      automationLinkage: { status: 'not-linked', testInstanceIds: [] },
    });
    const [linked] = snapshot.testCases;
    assert.ok(linked);
    assert.equal(linked['scenario'], 'Create a thing → `201`');
    assert.deepEqual(linked['automationLinkage'], {
      status: 'linked',
      testInstanceIds: ['aaaa1111-bbbb0001'],
    });
    assert.equal(snapshot.summary['linkedTestCases'], 2);
    assert.equal(snapshot.summary['linkedTestCasesWithIntentYes'], 2);
  });

  test('is deterministic regardless of discovery order and tag order', () => {
    const root = fixtureRepo();
    const a = build(root);
    const reversed = [...DEFAULT_SPECS]
      .reverse()
      .map((s) => ({ ...s, tags: [...s.tags].reverse() }));
    const b = build(root, { specs: reversed });
    assert.equal(serializeSnapshot(b), serializeSnapshot(a));
  });

  test('requirement sections are copied verbatim, without the trailing separator', () => {
    const snapshot = build(fixtureRepo()) as { requirements: { id: string; markdown: string }[] };
    assert.deepEqual(
      snapshot.requirements.map((r) => [r.id, r.markdown]),
      [
        ['REQ-001', 'Users create things.'],
        ['REQ-002', 'Users delete things.'],
      ],
    );
  });

  test('gitBlobSha equals git hash-object', () => {
    assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

// ---------------------------------------------------------------- specification contract

describe('dashboard data: specification contract failures fail closed', () => {
  const cases: [string, string, string, RegExp][] = [
    [
      'a TC row outside a REQ section',
      REQUIREMENTS,
      `${TEST_PLAN}\n## 9. Notes\n\n| ID | Scenario | Level | Type | Automation | Priority |\n| - | - | - | - | - | - |\n| TC-001-09 | x | API | Positive | Yes | P1 |\n`,
      /TC-001-09 is outside any "### REQ-NNN" section/,
    ],
    [
      'unexpected table columns',
      REQUIREMENTS,
      TEST_PLAN.replace('| Type     | Automation |', '| Kind     | Automation |'),
      /table columns are .*Kind/,
    ],
    [
      'an invalid Level value',
      REQUIREMENTS,
      TEST_PLAN.replace(
        '| TC-001-02 | Create a thing in the UI | UI ',
        '| TC-001-02 | Create a thing in the UI | GUI',
      ),
      /TC-001-02: Level "GUI" is not one of API, UI, E2E/,
    ],
    [
      'an invalid Automation value',
      REQUIREMENTS,
      TEST_PLAN.replace('| Positive | No         |', '| Positive | Maybe      |'),
      /Automation "Maybe" is not one of Yes, No/,
    ],
    [
      'an empty scenario',
      REQUIREMENTS,
      TEST_PLAN.replace('Create a thing in the UI', '                        '),
      /TC-001-02: empty Scenario/,
    ],
    [
      'a test case under a requirement that does not exist',
      REQUIREMENTS.replace(/## REQ-002[\s\S]*$/, ''),
      TEST_PLAN,
      /REQ-002/,
    ],
    [
      'a malformed requirement heading',
      REQUIREMENTS.replace('## REQ-002 — Delete a thing', '## REQ-002 Delete a thing'),
      TEST_PLAN,
      /malformed requirement heading/,
    ],
    [
      'a TC ID owned by another requirement',
      REQUIREMENTS,
      TEST_PLAN.replace('| TC-002-01 |', '| TC-001-03 |'),
      /TC-001-03 is listed under REQ-002, but its ID belongs to REQ-001/,
    ],
  ];
  for (const [name, requirements, plan, expected] of cases) {
    test(name, () => {
      assert.match(
        problemsOf(() => build(fixtureRepo(requirements, plan))),
        expected,
      );
    });
  }

  test('a missing test plan', () => {
    assert.match(
      problemsOf(() => build(fixtureRepo(REQUIREMENTS, null))),
      /must both exist/,
    );
  });

  test('uncommitted or untracked spec documents', () => {
    const root = fixtureRepo();
    assert.match(
      problemsOf(() =>
        build(root, { git: fakeGit(undefined, { 'specs/demo': ['specs/demo/test-plan.md'] }) }),
      ),
      /uncommitted changes under specs\/demo\//,
    );
    assert.match(
      problemsOf(() =>
        build(root, { git: fakeGit(['tests/demo/a.spec.ts', 'tests/demo/b.spec.ts']) }),
      ),
      /requirements\.md is not tracked by git/,
    );
  });
});

describe('dashboard data: test plan content (schema 1.1)', () => {
  test('plan prose is copied verbatim; structured tables are not repeated', () => {
    const snapshot = build(fixtureRepo()) as {
      schemaVersion: string;
      testPlan: unknown;
      canonicals: { id: string; heading: string; markdown: string }[];
    };
    assert.equal(snapshot.schemaVersion, '1.1');
    assert.deepEqual(snapshot.testPlan, {
      title: 'Demo — Test Plan v1',
      metadata: [{ item: 'Scope', value: 'REQ-001 – REQ-002' }],
      preamble: 'This plan is a fixture.',
      sections: [
        { kind: 'text', heading: '1. Strategy', markdown: 'Test through the API.' },
        {
          kind: 'inventory',
          heading: '2. Test inventory',
          markdown: 'Test case IDs use the form `TC-NNN-NN`.',
          requirementNotes: [{ requirementId: 'REQ-001', markdown: 'A note about REQ-001.' }],
        },
        {
          kind: 'canonicals',
          heading: '3. Canonical automation candidates',
          markdown: 'These are reference tests.',
        },
      ],
    });
    assert.deepEqual(
      snapshot.canonicals.map((can) => [can.id, can.heading, can.markdown]),
      [['CAN-001', 'CAN-001 — Create (API)', '**Purpose:** reference creation.']],
    );
  });

  const failures: [string, string, RegExp][] = [
    [
      'a canonical without its subsection',
      TEST_PLAN.replace('### CAN-001 — Create (API)\n\n**Purpose:** reference creation.\n', ''),
      /CAN-001 has no "### CAN-001 — …" subsection/,
    ],
    [
      'a canonical subsection without a table row',
      `${TEST_PLAN}\n### CAN-009 — Orphan (API)\n\nText.\n`,
      /subsection CAN-009 has no row in the canonical table/,
    ],
    [
      'a non-requirement subsection in the inventory',
      TEST_PLAN.replace('A note about REQ-001.', 'A note.\n\n### Notes\n\nMore.'),
      /"### Notes" in "2\. Test inventory" is not a requirement subsection/,
    ],
    [
      'a malformed metadata table',
      TEST_PLAN.replace('| Item  | Value             |', '| Key   | Value             |'),
      /metadata table must have the columns "Item \| Value"/,
    ],
    [
      'an empty text section',
      TEST_PLAN.replace('Test through the API.', ''),
      /section "1\. Strategy" is empty/,
    ],
    [
      'a second inventory section',
      `${TEST_PLAN}\n## 9. More\n\n### REQ-002 — Delete a thing\n\nExtra.\n`,
      /expected exactly one test inventory section, found 2/,
    ],
  ];
  for (const [name, plan, expected] of failures) {
    test(`${name} fails the build`, () => {
      assert.match(
        problemsOf(() => build(fixtureRepo(REQUIREMENTS, plan))),
        expected,
      );
    });
  }
});

// ---------------------------------------------------------------- inventory

describe('dashboard data: committed test inventory', () => {
  const tagCases: [string, string, RegExp][] = [
    ['an unknown TC tag', '@TC-009-01', /unknown TC tag "@TC-009-01"/],
    ['an unknown REQ tag', '@REQ-099', /unknown REQ tag "@REQ-099"/],
    ['an unknown CAN tag', '@CAN-042', /unknown CAN tag "@CAN-042"/],
    ['a malformed TC tag', '@TC-1-1', /malformed TC tag "@TC-1-1"/],
    ['a lower-case ID tag', '@tc-001-01', /malformed TC tag "@tc-001-01"/],
  ];
  for (const [name, tag, expected] of tagCases) {
    test(`${name} fails the build`, () => {
      const specs = [spec('aaaa1111-bbbb0003', ['@REQ-001', tag])];
      assert.match(
        problemsOf(() => build(fixtureRepo(), { specs })),
        expected,
      );
    });
  }

  test('tags that are not traceability IDs are not copied', () => {
    const snapshot = build(fixtureRepo()) as { testInstances: { tags: unknown }[] };
    assert.deepEqual(snapshot.testInstances[0]?.tags, {
      requirements: ['REQ-001'],
      testCases: ['TC-001-01'],
      canonicals: ['CAN-001'],
    });
  });

  test('uncommitted files under tests/ stop the build before anything is discovered', () => {
    const root = fixtureRepo();
    const run = runner(listReport(root));
    assert.match(
      problemsOf(() =>
        build(root, {
          git: fakeGit(undefined, { tests: ['tests/demo/proposed.spec.ts'] }),
          runList: run,
        }),
      ),
      /uncommitted changes in discovery inputs .*nothing was discovered.*proposed\.spec\.ts/,
    );
    assert.equal(run.calls, 0, 'Playwright discovery was not started');
  });

  test('a discovered file that git does not track fails the build', () => {
    const root = fixtureRepo();
    assert.match(
      problemsOf(() =>
        build(root, {
          git: fakeGit([
            'specs/demo/requirements.md',
            'specs/demo/test-plan.md',
            'tests/demo/a.spec.ts',
          ]),
        }),
      ),
      /tests\/demo\/b\.spec\.ts:9: not tracked by git/,
    );
  });

  test('discovery outside the repository tests/ directory fails the build', () => {
    const root = fixtureRepo();
    for (const rootDir of [join(root, 'artifacts', 'proposals'), root, join(tmpdir(), 'tests')]) {
      assert.match(
        problemsOf(() =>
          build(root, { runList: runner(listReport(root, DEFAULT_SPECS, rootDir)) }),
        ),
        /outside the repository's tests\/ directory/,
      );
    }
  });

  test('a spec outside tests/ or not a test file fails the build', () => {
    const specs = [spec('aaaa1111-bbbb0004', ['@REQ-001'], '../artifacts/proposals/x/x.spec.ts')];
    assert.match(
      problemsOf(() => build(fixtureRepo(), { specs })),
      /not a test file under tests\//,
    );
  });

  test('a failed or broken listing fails without echoing its output', () => {
    const root = fixtureRepo();
    for (const run of [
      runner(listReport(root), { exitCode: 1 }),
      runner({ ...listReport(root), errors: [{ message: `Error in ${root}/tests/x.spec.ts` }] }),
      runner(null, { stdout: 'not json /Users/someone' }),
      runner(null, { timedOut: true }),
      runner(null, { error: 'spawn npx ENOENT' }),
    ]) {
      const problems = problemsOf(() => build(root, { runList: run }));
      assert.match(problems, /playwright test --list/);
      assert.ok(!problems.includes('/Users/someone') && !problems.includes(root), problems);
    }
  });

  test('duplicate spec IDs fail the build', () => {
    const specs = [
      spec('aaaa1111-bbbb0005', ['@REQ-001']),
      spec('aaaa1111-bbbb0005', ['@REQ-002'], 'demo/b.spec.ts'),
    ];
    assert.match(
      problemsOf(() => build(fixtureRepo(), { specs })),
      /duplicate spec IDs/,
    );
  });
});

describe('dashboard data: git probe', () => {
  test('reports modified, untracked and ignored loadable files; ignores ignored non-code files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-git-'));
    roots.push(root);
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: root,
        stdio: 'ignore',
      });
    };
    mkdirSync(join(root, 'tests', 'demo'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '*.local.ts\n.DS_Store\n');
    writeFileSync(join(root, 'tests', 'demo', 'a.spec.ts'), 'a\n');
    writeFileSync(join(root, 'tests', 'demo', 'b.spec.ts'), 'b\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'fixture');

    const probe = gitProbe(root);
    assert.deepEqual([...probe.trackedFiles('tests')].sort(), [
      'tests/demo/a.spec.ts',
      'tests/demo/b.spec.ts',
    ]);
    assert.deepEqual(probe.uncommittedPaths(['tests']), []);
    assert.match(probe.head(), /^[0-9a-f]{40}$/);

    writeFileSync(join(root, 'tests', 'demo', 'a.spec.ts'), 'changed\n');
    writeFileSync(join(root, 'tests', 'demo', 'proposed.spec.ts'), 'p\n');
    writeFileSync(join(root, 'tests', 'demo', 'helper.local.ts'), 'h\n');
    writeFileSync(join(root, 'tests', '.DS_Store'), '');
    assert.deepEqual(probe.uncommittedPaths(['tests']), [
      'tests/demo/a.spec.ts',
      'tests/demo/helper.local.ts',
      'tests/demo/proposed.spec.ts',
    ]);
  });
});

describe('dashboard data: discovery cleanliness gate', () => {
  test('git status parsing: type changes, renames and ignored files; unknown entries fail closed', () => {
    const z = (...entries: string[]): string => `${entries.join('\0')}\0`;
    assert.deepEqual(uncommittedFromStatus(''), []);
    assert.deepEqual(uncommittedFromStatus(z(' T tests/a.spec.ts', 'T  tests/b.spec.ts')), [
      'tests/a.spec.ts',
      'tests/b.spec.ts',
    ]);
    assert.deepEqual(uncommittedFromStatus(z('R  tests/new.spec.ts', 'tests/old.spec.ts')), [
      'tests/new.spec.ts',
      'tests/old.spec.ts',
    ]);
    assert.deepEqual(
      uncommittedFromStatus(
        z('!! tests/.DS_Store', '!! apps/x/data/local.json', '?? apps/x/new.ts'),
      ),
      ['apps/x/data/local.json', 'apps/x/new.ts'],
    );
    for (const output of [
      z('ZZ tests/a.spec.ts'),
      z('tests/a.spec.ts'),
      z('M'),
      z('R  tests/new.spec.ts'),
    ]) {
      assert.throws(() => uncommittedFromStatus(output), SnapshotError, JSON.stringify(output));
    }
  });

  /** A committed git repository with a tests/ file, a support module and the config files. */
  function committedRepo(): { root: string; run: ListRunner & { calls: number } } {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-gate-'));
    roots.push(root);
    const files: Record<string, string> = {
      '.gitignore': '*.local.json\n',
      'tests/demo/a.spec.ts': 'export {};\n',
      'apps/demo/pages/home.page.ts': 'export const home = 1;\n',
      'framework/.gitkeep': '',
      'playwright.config.ts': 'export default {};\n',
      'tsconfig.json': '{}\n',
      'package.json': '{}\n',
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: root,
        stdio: 'ignore',
      });
    };
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'fixture');
    return { root, run: runner(listReport(root)) };
  }

  const approved = {
    requirements: new Set<string>(),
    testCases: new Set<string>(),
    canonicals: new Set<string>(),
  };

  function blocked(root: string, run: ListRunner & { calls: number }): string {
    const problems = problemsOf(() => discoverInventory(root, approved, gitProbe(root), run));
    assert.equal(run.calls, 0, 'Playwright discovery was not started');
    return problems;
  }

  test('a tracked test file replaced by a symlink blocks discovery before Playwright starts', () => {
    const { root, run } = committedRepo();
    const target = join(root, 'outside.ts');
    writeFileSync(target, 'export {};\n');
    unlinkSync(join(root, 'tests', 'demo', 'a.spec.ts'));
    symlinkSync(target, join(root, 'tests', 'demo', 'a.spec.ts'));
    assert.match(blocked(root, run), /nothing was discovered.*tests\/demo\/a\.spec\.ts/);
  });

  test('a modified file under apps/ blocks discovery before Playwright starts', () => {
    const { root, run } = committedRepo();
    writeFileSync(join(root, 'apps', 'demo', 'pages', 'home.page.ts'), 'export const home = 2;\n');
    assert.match(blocked(root, run), /nothing was discovered.*apps\/demo\/pages\/home\.page\.ts/);
  });

  test('untracked, ignored-loadable and modified configuration inputs also block discovery', () => {
    const changes: [string, string][] = [
      ['framework/core/helper.ts', 'export {};\n'],
      ['apps/demo/data/users.local.json', '{}\n'],
      ['playwright.config.ts', 'export default { testDir: "artifacts" };\n'],
      ['tsconfig.json', '{ "compilerOptions": {} }\n'],
      ['package.json', '{ "type": "module" }\n'],
    ];
    for (const [path, content] of changes) {
      const { root, run } = committedRepo();
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
      const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      assert.match(blocked(root, run), new RegExp(`nothing was discovered.*${escaped}`), path);
    }
  });

  test('a clean repository passes the gate and discovery starts', () => {
    const { root, run } = committedRepo();
    writeFileSync(join(root, 'notes.md'), 'not a discovery input\n');
    assert.match(
      problemsOf(() => discoverInventory(root, approved, gitProbe(root), run)),
      /not tracked by git|no tests|unknown/,
    );
    assert.equal(run.calls, 1);
  });
});

// ---------------------------------------------------------------- sanitization

describe('dashboard data: sanitization', () => {
  test('only allowlisted fields are copied from the Playwright report', () => {
    const root = fixtureRepo();
    const snapshot = build(root) as { testInstances: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(snapshot.testInstances[0] ?? {}).sort(), [
      'describePath',
      'file',
      'id',
      'line',
      'projects',
      'tags',
      'title',
    ]);
    const text = serializeSnapshot(snapshot);
    for (const leaked of [
      '/Users/someone',
      root,
      'argv',
      'configFile',
      'webServer',
      'stdout',
      'stderr',
      'annotations',
      'sk-ant-',
      'SECRET_TOKEN',
      'REQUESTFLOW_TEST_HOOKS',
    ]) {
      assert.ok(!text.includes(leaked), `snapshot contains "${leaked}"`);
    }
    assert.equal(
      snapshot.testInstances[0]?.['file'],
      'tests/demo/a.spec.ts',
      'repository-relative',
    );
  });

  test('unsafe content in an approved document stops the build, naming the location only', () => {
    const plan = TEST_PLAN.replace('Create a thing in the UI', 'Open /Users/alex/x.txt   ');
    const problems = problemsOf(() => build(fixtureRepo(REQUIREMENTS, plan)));
    assert.match(problems, /not public-safe: \/testCases\/1\/scenario: absolute path/);
    assert.ok(!problems.includes('/Users/alex'), problems);
  });

  test('each unsafe category is detected', () => {
    const samples: [string, string][] = [
      ['/home/runner/work/repo', 'absolute path'],
      ['see /private/var/folders/x', 'absolute path'],
      ['C:\\Users\\alex', 'absolute path'],
      ['\\\\server\\share', 'absolute path'],
      ['~/projects', 'home-relative path'],
      ['file:///etc/passwd', 'file URL'],
      ['sk-ant-api03-AbCdEf123456', 'credential'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'credential'],
      ['AKIAABCDEFGHIJKLMNOP', 'credential'],
      ['-----BEGIN RSA PRIVATE KEY-----', 'credential'],
      ['Authorization: Bearer abcdefghijklmnopqrstuv', 'credential'],
      ['ANTHROPIC_API_KEY', 'environment variable'],
      ['NODE_OPTIONS=--require x', 'environment variable'],
      ['someone@example.com', 'e-mail address'],
      ['Error: x\n    at foo (bar.ts:1:2)', 'stack trace'],
      ['/repo/root/x', 'local path'],
    ];
    for (const [sample, category] of samples) {
      const findings = publicSafetyFindings(
        { value: sample },
        { forbiddenLiterals: ['/repo/root'] },
      );
      assert.ok(
        findings.some((finding) => finding.endsWith(category)),
        `${sample}: ${findings.join('; ')}`,
      );
      assert.ok(
        findings.every((finding) => !finding.includes(sample)),
        'values are not echoed',
      );
    }
    assert.deepEqual(publicSafetyFindings({ ['/Users/x']: 1 }, { forbiddenLiterals: [] }), [
      '/~1Users~1x (key): absolute path',
    ]);
  });

  test('ordinary specification text is not flagged', () => {
    for (const sample of [
      '`GET /api/requests/:id` → `404 NOT_FOUND`',
      'http://127.0.0.1:3100/health',
      'tests/requestflow/api/x.spec.ts',
      'Alex logs in → New request @TC-001-01',
      '`PATCH …/:id/approve`',
      'Amount `0.01`, `100000` and `10.12`',
    ]) {
      assert.deepEqual(publicSafetyFindings([sample], { forbiddenLiterals: [] }), [], sample);
    }
  });
});

// ---------------------------------------------------------------- schema

describe('dashboard data: schema', () => {
  const valid = build(fixtureRepo());

  test('a built snapshot is valid', () => {
    assert.deepEqual(validateSnapshot(valid), []);
  });

  // [name, JSON pointer, new value, expected error]
  const mutations: [string, string, unknown, RegExp][] = [
    ['an unknown top-level field', '/generatedAt', 'now', /must NOT have additional properties/],
    ['a CI run in schema 1.0', '/execution/ci/runs/0', { id: 1 }, /execution\/ci\/runs/],
    ['local results presented as used', '/execution/localResults', 'used', /localResults/],
    ['an invalid TC ID', '/testCases/0/id', 'TC-1-1', /testCases\/0\/id/],
    ['an unknown automation intent', '/testCases/0/automationIntent', 'Maybe', /automationIntent/],
    [
      'linkage "linked" without test instances',
      '/testCases/1/automationLinkage/status',
      'linked',
      /automationLinkage/,
    ],
    [
      'an absolute test file path',
      '/testInstances/0/file',
      '/Users/x/tests/a.spec.ts',
      /testInstances\/0\/file/,
    ],
    ['an extra field on a test instance', '/testInstances/0/stdout', 'x', /testInstances\/0/],
    ['a short commit SHA', '/source/commit', 'abc123', /source\/commit/],
    ['the previous schema version', '/schemaVersion', '1.0', /schemaVersion/],
    ['an unknown plan section kind', '/testPlan/sections/0/kind', 'html', /testPlan\/sections\/0/],
    [
      'a canonical without its Purpose/Flow',
      '/canonicals/0/markdown',
      '',
      /canonicals\/0\/markdown/,
    ],
  ];
  for (const [name, pointer, value, expected] of mutations) {
    test(`rejects ${name}`, () => {
      const copy = structuredClone(valid);
      setAt(copy, pointer, value);
      const errors = validateSnapshot(copy);
      assert.ok(
        errors.some((error) => expected.test(error)),
        errors.join('\n'),
      );
    });
  }
});

function setAt(root: unknown, pointer: string, value: unknown): void {
  const keys = pointer.split('/').slice(1);
  const last = keys.pop() ?? '';
  let node = root as Record<string, unknown>;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  node[last] = value;
}
