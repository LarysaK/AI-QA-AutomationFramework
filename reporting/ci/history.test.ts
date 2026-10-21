import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  collectSuites,
  composeRecord,
  type ReportInput,
  serializeRecord,
  snapshotReference,
  type StepConclusion,
  SUITE_IDS,
  type SuiteId,
} from './collect';
import {
  buildIndex,
  canonicalJson,
  entryFor,
  HistoryError,
  type HistoryTree,
  INDEX_PATH,
  MAX_INDEX_BYTES,
  MAX_README_BYTES,
  MAX_RECORD_BYTES,
  parseInstant,
  planAddition,
  README_PATH,
  recordPath,
  sha256,
  verifyTree,
} from './history';
import { addRecord, loadTree, verifyHistory, writeAddition } from './history-cli';

/**
 * CI history preparation, offline. The base record is composed by the M2 collector from the
 * committed fixtures; every other record here is a synthetic variant of it (other run IDs,
 * attempts and completion times), built in the test.
 */

const REPO = resolve('.');
const FIXTURES = join(__dirname, 'fixtures');
const read = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8');
const json = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;
const SAFETY = {
  forbiddenLiterals: ['/home/runner/work/AI-QA-AutomationFramework/AI-QA-AutomationFramework'],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function baseRecord(): Record<string, unknown> {
  const reports: Record<SuiteId, ReportInput> = {
    agents: { kind: 'present', text: read('tap/repository-pass.tap') },
    'dashboard-data': { kind: 'present', text: read('tap/repository-pass.tap') },
    'dashboard-frontend': { kind: 'present', text: read('vitest/repository-pass.json') },
    playwright: { kind: 'present', text: read('playwright/repository-pass.json') },
  };
  const outcomes = Object.fromEntries(SUITE_IDS.map((id) => [id, 'success'])) as Record<
    SuiteId,
    StepConclusion
  >;
  const jobs = json('github/jobs-39144953322-attempt-1.json');
  const job = (jobs['jobs'] as Record<string, unknown>[])[0];
  assert.ok(job);
  job['started_at'] = '2026-10-18T20:04:00Z'; // derived: window around the local fixture reports
  job['completed_at'] = '2026-10-18T20:10:00Z';
  return composeRecord({
    suiteResults: collectSuites({ outcomes, reports, node: '22.23.3' }),
    run: json('github/run-39144953322.json'),
    jobs,
    env: {
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'LarysaK/AI-QA-AutomationFramework',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_RUN_ID: '39144953322',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_NUMBER: '2',
      GITHUB_SHA: '11f78cdab0e2b4a4b2e92de4bcace444502de158',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'push',
    },
    snapshot: snapshotReference(json('snapshot/dashboard-data.json')),
    safety: SAFETY,
  }) as Record<string, unknown>;
}

const BASE = baseRecord();

/** A synthetic record: the base record as another run, attempt or completion time (canonical bytes). */
function variant(
  change: {
    runId?: number;
    attempt?: number;
    number?: number;
    sha?: string;
    completedAt?: string;
  } = {},
): string {
  const record = structuredClone(BASE);
  const run = record['run'] as Record<string, unknown>;
  const runId = change.runId ?? (run['id'] as number);
  run['id'] = runId;
  run['attempt'] = change.attempt ?? run['attempt'];
  run['number'] = change.number ?? run['number'];
  run['url'] = `https://github.com/LarysaK/AI-QA-AutomationFramework/actions/runs/${String(runId)}`;
  if (change.sha !== undefined) record['commitSha'] = change.sha;
  if (change.completedAt !== undefined) {
    (record['timestamps'] as Record<string, unknown>)['jobCompletedAt'] = change.completedAt;
  }
  return serializeRecord(record);
}

const EMPTY: HistoryTree = new Map();

function addAll(contents: readonly string[], start: HistoryTree = EMPTY): HistoryTree {
  return contents.reduce<HistoryTree>((tree, content) => planAddition(tree, content).tree, start);
}

function problemsOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HistoryError, `expected a HistoryError, got ${String(error)}`);
    return error.problems.join('\n');
  }
  return assert.fail('expected a HistoryError');
}

describe('history: paths and canonical bytes', () => {
  test('one immutable path per run attempt', () => {
    assert.equal(recordPath(39144953322, 1), 'v1/runs/39144953322-1.json');
    assert.equal(recordPath(39144953322, 2), 'v1/runs/39144953322-2.json');
    for (const [runId, attempt] of [
      [0, 1],
      [1, 0],
      [-1, 1],
      [1.5, 1],
      [Number.NaN, 1],
    ] as const) {
      assert.match(
        problemsOf(() => recordPath(runId, attempt)),
        /positive integer/,
      );
    }
  });

  test('canonical form is the collector serialization', () => {
    assert.equal(canonicalJson(BASE), serializeRecord(BASE));
  });

  test('an index entry is derived from the record and its exact bytes', () => {
    const content = variant();
    const entry = entryFor('v1/runs/39144953322-1.json', content);
    assert.deepEqual(entry, {
      runId: 39144953322,
      attempt: 1,
      number: 2,
      commitSha: '11f78cdab0e2b4a4b2e92de4bcace444502de158',
      event: 'push',
      conclusion: 'success',
      jobCompletedAt: '2026-10-18T20:10:00Z',
      path: 'v1/runs/39144953322-1.json',
      sha256: sha256(content),
    });
  });

  test('rejects non-canonical bytes, a record at the wrong path, and non-records', () => {
    const content = variant();
    assert.match(
      problemsOf(() => entryFor('v1/runs/39144953322-1.json', JSON.stringify(JSON.parse(content)))),
      /canonical form/,
    );
    assert.match(
      problemsOf(() => entryFor('v1/runs/1-1.json', content)),
      /is for run 39144953322 attempt 1/,
    );
    assert.match(
      problemsOf(() => entryFor('v1/runs/1-1.json', '{')),
      /not valid JSON/,
    );
    assert.match(
      problemsOf(() => entryFor('v1/runs/1-1.json', '{"kind":"other"}\n')),
      /not a ci-run 1.0 record/,
    );
  });
});

describe('history: additions', () => {
  test('adding to an empty history writes the record and the index', () => {
    const content = variant();
    const addition = planAddition(EMPTY, content);
    assert.equal(addition.action, 'add');
    assert.equal(addition.path, 'v1/runs/39144953322-1.json');
    assert.deepEqual(addition.changed, ['v1/runs/39144953322-1.json', INDEX_PATH]);
    const index = JSON.parse(addition.tree.get(INDEX_PATH) ?? '') as { runs: { sha256: string }[] };
    assert.equal(index.runs.length, 1);
    assert.equal(index.runs[0]?.sha256, sha256(content));
    assert.deepEqual(verifyTree(addition.tree), []);
  });

  test('the same record again is a no-op (idempotent)', () => {
    const tree = addAll([variant()]);
    const again = planAddition(tree, variant());
    assert.equal(again.action, 'unchanged');
    assert.deepEqual(again.changed, []);
    assert.equal(again.tree, tree);
  });

  test('a different record for the same run attempt is a conflict and is never overwritten', () => {
    const tree = addAll([variant()]);
    const different = variant({ completedAt: '2026-10-18T20:11:00Z' });
    assert.match(
      problemsOf(() => planAddition(tree, different)),
      /a different record already exists/,
    );
  });

  test('reruns: every attempt is kept as its own record', () => {
    const tree = addAll([
      variant({ attempt: 1 }),
      variant({ attempt: 2, completedAt: '2026-10-18T21:00:00Z' }),
    ]);
    const index = buildIndex(tree);
    assert.deepEqual(
      index.runs.map((r) => [r.runId, r.attempt]),
      [
        [39144953322, 1],
        [39144953322, 2],
      ],
    );
  });

  test('attempts of one run must agree on commit and run number', () => {
    const tree = addAll([variant({ attempt: 1 })]);
    assert.match(
      problemsOf(() => planAddition(tree, variant({ attempt: 2, sha: 'b'.repeat(40) }))),
      /attempts disagree/,
    );
    assert.match(
      problemsOf(() => planAddition(tree, variant({ attempt: 2, number: 9 }))),
      /attempts disagree/,
    );
  });

  test('order of additions never matters: every permutation gives identical bytes', () => {
    const records = [
      variant({ runId: 300, completedAt: '2026-10-18T20:00:00Z' }),
      variant({ runId: 100, completedAt: '2026-10-18T20:00:00Z' }),
      variant({ runId: 200, completedAt: '2026-10-18T19:00:00Z' }),
      variant({ runId: 100, attempt: 2, completedAt: '2026-10-18T20:00:00Z' }),
    ];
    const permutations = (items: string[]): string[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const results = permutations(records).map((order) => {
      const tree = addAll(order);
      return [...tree.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    });
    assert.equal(results.length, 24);
    for (const result of results) assert.deepEqual(result, results[0]);
    const index = buildIndex(new Map(results[0]));
    assert.deepEqual(
      index.runs.map((r) => `${String(r.runId)}-${String(r.attempt)}`),
      ['200-1', '100-1', '100-2', '300-1'],
    );
  });

  test('ordering compares instants, not strings (fractional seconds)', () => {
    const tree = addAll([
      variant({ runId: 1, completedAt: '2026-10-18T20:00:30.5Z' }),
      variant({ runId: 2, completedAt: '2026-10-18T20:00:30Z' }),
    ]);
    assert.deepEqual(
      buildIndex(tree).runs.map((r) => r.runId),
      [2, 1],
    );
  });

  test('concurrent preparations from the same base merge to the same result in either order', () => {
    const base = addAll([variant({ runId: 1, completedAt: '2026-10-18T19:00:00Z' })]);
    const a = variant({ runId: 2, completedAt: '2026-10-18T20:00:00Z' });
    const b = variant({ runId: 3, completedAt: '2026-10-18T21:00:00Z' });
    // Writer A publishes first; writer B must redo its addition on top of A (retry after rejection).
    const aThenB = planAddition(planAddition(base, a).tree, b).tree;
    const bThenA = planAddition(planAddition(base, b).tree, a).tree;
    assert.deepEqual([...aThenB.entries()].sort(), [...bThenA.entries()].sort());
    // B's stale plan, made before A landed, does not contain A: it must never be pushed as is.
    assert.equal(planAddition(base, b).tree.has(recordPath(2, 1)), false);
  });
});

describe('history: verification', () => {
  const good = (): Map<string, string> =>
    new Map(addAll([variant({ runId: 1 }), variant({ runId: 2 })]));

  test('a consistent history has no problems; a README is allowed', () => {
    const tree = good();
    tree.set('README.md', '# CI history\n');
    assert.deepEqual(verifyTree(tree), []);
  });

  const broken: [string, (tree: Map<string, string>) => void, RegExp][] = [
    [
      'a stray file',
      (t) => t.set('v1/notes.txt', 'x'),
      /v1\/notes\.txt: not part of the history layout/,
    ],
    ['a file outside v1', (t) => t.set('raw/report.json', '{}'), /not part of the history layout/],
    ['a missing index', (t) => t.delete(INDEX_PATH), /index.json: missing/],
    [
      'an edited index',
      (t) => t.set(INDEX_PATH, (t.get(INDEX_PATH) ?? '').replace('"success"', '"failure"')),
      /does not match the records/,
    ],
    [
      'a record removed from under the index',
      (t) => t.delete(recordPath(1, 1)),
      /does not match the records/,
    ],
    [
      'a tampered record',
      (t) =>
        t.set(
          recordPath(1, 1),
          (t.get(recordPath(1, 1)) ?? '').replace('"node": "22.23.3"', '"node": "22.23.4"'),
        ),
      /does not match the records/,
    ],
    [
      'a record at the wrong path',
      (t) => {
        t.set(recordPath(9, 1), t.get(recordPath(1, 1)) ?? '');
      },
      /is for run 1 attempt 1/,
    ],
  ];
  for (const [name, damage, reason] of broken) {
    test(`detects ${name}`, () => {
      const tree = good();
      const before = [...tree.entries()].join('\n');
      damage(tree);
      assert.notEqual([...tree.entries()].join('\n'), before, 'the damage must change the tree');
      assert.match(verifyTree(tree).join('\n'), reason);
    });
  }

  test('an inconsistent history refuses further additions', () => {
    const tree = good();
    tree.set('v1/notes.txt', 'x');
    assert.match(
      problemsOf(() => planAddition(tree, variant({ runId: 3 }))),
      /existing history is not consistent/,
    );
  });

  test('full verification also applies the record schema, the public-safety scan and the index schema', () => {
    assert.deepEqual(verifyHistory(good(), SAFETY), []);
    const invalid = good();
    const record = JSON.parse(invalid.get(recordPath(1, 1)) ?? '') as Record<string, unknown>;
    record['note'] = 'x';
    invalid.set(recordPath(1, 1), canonicalJson(record));
    assert.match(
      verifyHistory(invalid, SAFETY).join('\n'),
      /schema: \/ must NOT have additional properties/,
    );
    const unsafe = good();
    const leaky = JSON.parse(unsafe.get(recordPath(1, 1)) ?? '') as { steps: { name: string }[] };
    leaky.steps.push({
      name: 'Leak /home/runner/work/AI-QA-AutomationFramework/AI-QA-AutomationFramework/x',
      conclusion: 'success',
    } as { name: string });
    unsafe.set(recordPath(1, 1), canonicalJson(leaky));
    assert.match(verifyHistory(unsafe, SAFETY).join('\n'), /not public-safe/);
  });

  test('new records are fully validated before they are added', () => {
    const notARecord = canonicalJson({ ...BASE, kind: 'other' });
    assert.match(
      problemsOf(() => addRecord(EMPTY, notARecord, SAFETY)),
      /the new record is not valid/,
    );
    const record = structuredClone(BASE);
    (record['steps'] as { name: string; conclusion: string }[]).push({
      name: 'contact someone@example.com',
      conclusion: 'success',
    });
    assert.match(
      problemsOf(() => addRecord(EMPTY, serializeRecord(record), SAFETY)),
      /not public-safe/,
    );
  });
});

describe('history: CLI and portability', () => {
  const cli = (args: string[]) =>
    spawnSync(join(REPO, 'node_modules/.bin/tsx'), [join(__dirname, 'history-cli.ts'), ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });

  test('add, add again, conflict and verify on a local directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-history-'));
    dirs.push(dir);
    const history = join(dir, 'history');
    mkdirSync(history);
    writeFileSync(join(dir, 'record.json'), variant());
    writeFileSync(join(dir, 'conflict.json'), variant({ completedAt: '2026-10-18T20:11:00Z' }));

    const first = cli(['add', '--history', history, '--record', join(dir, 'record.json')]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal((JSON.parse(first.stdout) as { action: string }).action, 'add');
    const files = (): Map<string, string> => loadTree(history);
    const after1 = [...files().entries()];

    const second = cli(['add', '--history', history, '--record', join(dir, 'record.json')]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal((JSON.parse(second.stdout) as { action: string }).action, 'unchanged');
    assert.deepEqual([...files().entries()], after1, 'an idempotent add writes nothing');

    const conflict = cli(['add', '--history', history, '--record', join(dir, 'conflict.json')]);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /a different record already exists/);
    assert.deepEqual([...files().entries()], after1, 'a conflict writes nothing');

    const verified = cli(['verify', '--history', history]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), { verified: true, records: 1 });
  });

  test('symbolic links in the history are refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-history-link-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'v1'), { recursive: true });
    symlinkSync('/etc/hosts', join(dir, 'v1', 'index.json'));
    const result = cli(['verify', '--history', dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symbolic links are not allowed/);
  });

  test('history.ts runs under plain node, without packages or a TypeScript loader', () => {
    const script = `import(${JSON.stringify(join(__dirname, 'history.ts'))}).then((m) => { const t = m.planAddition(new Map(), process.argv[1]).tree; console.log(m.verifyTree(t).length, [...t.keys()].join(',')); })`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, variant()], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '0 v1/runs/39144953322-1.json,v1/index.json');
  });

  test('history.ts and context.ts depend on nothing but node built-ins (no network, git or packages)', () => {
    for (const file of ['history.ts', 'context.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
      assert.ok(
        imports.every((name) => name === 'node:crypto'),
        `${file}: ${imports.join(', ')}`,
      );
      assert.doesNotMatch(source, /child_process|node:https?|fetch\(|node:fs/);
    }
  });
});

// ---------------------------------------------------------------- correction pass (I1, I2, O1, O2)

describe('history: strict completion instants (I2)', () => {
  test('real instants, including boundaries, leap days and offsets', () => {
    const valid: [string, string][] = [
      ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'],
      ['2026-12-31T23:59:59.999Z', '2026-12-31T23:59:59.999Z'],
      ['2024-02-29T12:00:00Z', '2024-02-29T12:00:00.000Z'],
      ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
      ['2026-10-18T20:00:30.123456789Z', '2026-10-18T20:00:30.123Z'],
      ['2026-10-18T22:00:00+02:00', '2026-10-18T20:00:00.000Z'],
      ['2026-10-18T14:30:00-05:30', '2026-10-18T20:00:00.000Z'],
      ['2026-10-18T20:00:00+14:00', '2026-10-18T06:00:00.000Z'],
      ['9999-12-31T23:59:59Z', '9999-12-31T23:59:59.000Z'],
    ];
    for (const [text, utc] of valid) {
      const ms = parseInstant(text);
      assert.ok(ms !== null, text);
      assert.equal(new Date(ms).toISOString(), utc, text);
    }
  });

  test('impossible or unsupported instants are rejected, never normalized', () => {
    for (const text of [
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-10-00T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '1900-02-29T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-10-18T24:00:00Z',
      '2026-10-18T23:60:00Z',
      '2026-12-31T23:59:60Z',
      '2026-10-18T20:00:00+15:00',
      '2026-10-18T20:00:00+14:01',
      '2026-10-18T20:00:00+02:60',
      '1969-12-31T23:59:59Z',
      '2026-10-18T20:00:00z',
      '2026-10-18T20:00:00',
      '2026-10-18 20:00:00Z',
      'NaN',
      '',
    ]) {
      assert.equal(parseInstant(text), null, text);
    }
  });

  test('a record with an impossible completion time is refused before it is indexed', () => {
    for (const completedAt of [
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-10-18T24:00:00Z',
      '2026-12-31T23:59:60Z',
    ]) {
      const content = variant({ runId: 7, completedAt });
      assert.match(
        problemsOf(() => entryFor(recordPath(7, 1), content)),
        /jobCompletedAt is not a real instant/,
        completedAt,
      );
      assert.match(
        problemsOf(() => planAddition(EMPTY, content)),
        /not a real instant/,
        completedAt,
      );
    }
  });

  test('ordering uses the absolute instant (offsets) and every permutation gives the same index', () => {
    // history.ts accepts offsets; ci-run 1.0 records themselves always use Z.
    const records = [
      variant({ runId: 1, completedAt: '2026-10-18T22:00:00+02:00' }), // 20:00Z
      variant({ runId: 2, completedAt: '2026-10-18T19:30:00Z' }),
      variant({ runId: 3, completedAt: '2026-10-18T20:00:00.001Z' }),
      variant({ runId: 4, completedAt: '2026-10-18T14:30:00-05:30' }), // 20:00Z, ties with 1
    ];
    const orders = new Set<string>();
    const permute = (items: string[], prefix: string[] = []): void => {
      if (items.length === 0) {
        orders.add(
          buildIndex(addAll(prefix))
            .runs.map((r) => r.runId)
            .join(','),
        );
        return;
      }
      items.forEach((item, i) => {
        permute([...items.slice(0, i), ...items.slice(i + 1)], [...prefix, item]);
      });
    };
    permute(records);
    assert.deepEqual([...orders], ['2,1,4,3']);
  });

  test('a history containing an impossible instant is refused in every order, never sorted', () => {
    const good = [
      variant({ runId: 1, completedAt: '2026-10-18T05:00:00Z' }),
      variant({ runId: 3, completedAt: '2026-10-18T10:00:00Z' }),
    ];
    const bad = canonicalJson({
      ...JSON.parse(variant({ runId: 2 })),
      timestamps: {
        ...(JSON.parse(variant({ runId: 2 })) as { timestamps: object }).timestamps,
        jobCompletedAt: '2026-13-01T00:00:00Z',
      },
    });
    for (const order of [
      [...good, bad],
      [bad, ...good],
      [good[0] ?? '', bad, good[1] ?? ''],
    ]) {
      const tree = new Map(
        order.map((content) => [
          recordPath((JSON.parse(content) as { run: { id: number } }).run.id, 1),
          content,
        ]),
      );
      assert.match(
        problemsOf(() => buildIndex(tree)),
        /not a real instant/,
      );
    }
  });
});

describe('history: exclusive record creation (I1)', () => {
  const temporaries = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.includes('.tmp-'))
      .map((entry) => entry.name);

  function fresh(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-history-race-'));
    dirs.push(dir);
    return dir;
  }

  test('a normal addition creates the record and the index and leaves no temporary files', () => {
    const dir = fresh();
    const addition = addRecord(loadTree(dir), variant(), SAFETY);
    assert.equal(writeAddition(dir, addition), 'add');
    assert.deepEqual(verifyHistory(loadTree(dir), SAFETY), []);
    assert.deepEqual(temporaries(dir), []);
  });

  test('a different record created by another process after the scan is never replaced', () => {
    const dir = fresh();
    const addition = addRecord(loadTree(dir), variant(), SAFETY); // planned against an empty history
    const theirs = variant({ completedAt: '2026-10-18T20:11:00Z' });
    mkdirSync(join(dir, 'v1/runs'), { recursive: true });
    writeFileSync(join(dir, addition.path), theirs); // the concurrent writer wins the race
    assert.match(
      problemsOf(() => writeAddition(dir, addition)),
      /a different record was created concurrently/,
    );
    assert.equal(
      readFileSync(join(dir, addition.path), 'utf8'),
      theirs,
      'their record is untouched',
    );
    assert.equal(
      existsSync(join(dir, INDEX_PATH)),
      false,
      'no index is written for a refused record',
    );
    assert.deepEqual(temporaries(dir), [], 'temporary files are removed');
  });

  test('the identical record created concurrently makes this addition a no-op', () => {
    const dir = fresh();
    const addition = addRecord(loadTree(dir), variant(), SAFETY);
    mkdirSync(join(dir, 'v1/runs'), { recursive: true });
    writeFileSync(join(dir, addition.path), variant());
    assert.equal(writeAddition(dir, addition), 'unchanged');
    assert.equal(
      existsSync(join(dir, INDEX_PATH)),
      false,
      'the index is left to the writer that created the record',
    );
    assert.deepEqual(temporaries(dir), []);
  });

  test('the index is replaced atomically when a second record is added', () => {
    const dir = fresh();
    writeAddition(dir, addRecord(loadTree(dir), variant({ runId: 1 }), SAFETY));
    const before = readFileSync(join(dir, INDEX_PATH), 'utf8');
    writeAddition(dir, addRecord(loadTree(dir), variant({ runId: 2 }), SAFETY));
    const after = readFileSync(join(dir, INDEX_PATH), 'utf8');
    assert.notEqual(after, before);
    assert.equal(after, canonicalJson(buildIndex(loadTree(dir))));
    assert.deepEqual(temporaries(dir), []);
  });
});

describe('history: public README (O1)', () => {
  const withReadme = (readme: string): Map<string, string> => {
    const tree = new Map(addAll([variant()]));
    tree.set(README_PATH, readme);
    return tree;
  };

  test('a plain notice passes', () => {
    assert.deepEqual(
      verifyHistory(withReadme('# CI history\n\nGenerated by CI. Do not edit.\n'), SAFETY),
      [],
    );
  });

  test('a README with local paths, e-mail addresses or credentials fails', () => {
    for (const [text, finding] of [
      ['See /Users/someone/notes\n', /README\.md: not public-safe: absolute path/],
      ['Contact someone@example.com\n', /README\.md: not public-safe: e-mail address/],
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123\n', /README\.md: not public-safe: credential/],
    ] as const) {
      assert.match(verifyHistory(withReadme(text), SAFETY).join('\n'), finding);
    }
  });

  test('a history with an unsafe README refuses additions', () => {
    assert.match(
      problemsOf(() =>
        addRecord(withReadme('See /Users/someone\n'), variant({ runId: 9 }), SAFETY),
      ),
      /README\.md: not public-safe/,
    );
  });
});

describe('history: size limits (O2)', () => {
  test('records: refused above the limit before parsing; accepted up to it', () => {
    const over = '{'.padEnd(MAX_RECORD_BYTES + 1, ' ');
    const at = '{'.padEnd(MAX_RECORD_BYTES, ' ');
    assert.match(
      problemsOf(() => entryFor(recordPath(1, 1), over)),
      /larger than 1048576 bytes/,
    );
    assert.match(
      problemsOf(() => entryFor(recordPath(1, 1), at)),
      /not valid JSON/,
      'at the limit, parsing is attempted',
    );
    assert.match(
      problemsOf(() => planAddition(EMPTY, over)),
      /the new record is larger than/,
    );
  });

  test('sizes are measured in bytes, not characters', () => {
    const tree = new Map(addAll([variant()]));
    tree.set(README_PATH, 'é'.repeat(MAX_README_BYTES / 2 + 1)); // fewer characters than the limit, more bytes
    assert.match(verifyTree(tree).join('\n'), /README\.md: larger than 65536 bytes/);
    tree.set(README_PATH, 'é'.repeat(MAX_README_BYTES / 2));
    assert.deepEqual(verifyTree(tree), []);
  });

  test('an oversized index is refused without being parsed', () => {
    const tree = new Map(addAll([variant()]));
    tree.set(INDEX_PATH, '['.padEnd(MAX_INDEX_BYTES + 1, ' '));
    const problems = verifyHistory(tree, SAFETY).join('\n');
    assert.match(problems, /index\.json: larger than 16777216 bytes/);
    assert.doesNotMatch(problems, /not valid JSON/);
  });

  test('loading refuses oversized files before reading them, and a symlinked root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-history-big-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'v1'));
    writeFileSync(join(dir, 'v1', 'index.json'), Buffer.alloc(MAX_INDEX_BYTES + 1, 0x20));
    assert.match(
      problemsOf(() => loadTree(dir)),
      /v1\/index\.json: larger than 16777216 bytes/,
    );
    const link = join(tmpdir(), `ci-history-link-root-${String(process.pid)}`);
    rmSync(link, { force: true });
    symlinkSync(dir, link);
    dirs.push(link);
    assert.match(
      problemsOf(() => loadTree(link)),
      /must be a directory, not a link/,
    );
  });
});
