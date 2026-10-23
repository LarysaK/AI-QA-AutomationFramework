import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import { composed } from './handoff.test';
import { canonicalJson } from './history';
import {
  type ApiData,
  auditHistoryLog,
  eligibility,
  exitCode,
  fetchApiData,
  markdown,
  PUBLISHER_IDENTITY,
  reconcile,
} from './reconcile';

/**
 * CI history reconciliation (read-only). The run listings, artifact listings and records are
 * SYNTHETIC, derived from run #2's public API data (fixtures/github); histories are real local git
 * repositories built by the tests. Nothing here writes to any remote.
 */

const REPO = resolve('.');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const FIXTURES = join(__dirname, 'fixtures');
const REPOSITORY = 'LarysaK/AI-QA-AutomationFramework';
const RUN_ID = 39144953322;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temporary = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------- synthetic API data

/** A listed CI run (run #2's public data plus head_repository), with changes. */
function run(change: Record<string, unknown> = {}): Record<string, unknown> {
  const base = JSON.parse(
    readFileSync(join(FIXTURES, 'github/run-39144953322.json'), 'utf8'),
  ) as Record<string, unknown>;
  const id = (change['id'] as number | undefined) ?? RUN_ID;
  return {
    ...base,
    head_repository: { full_name: REPOSITORY },
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${String(id)}`,
    ...change,
  };
}

const artifact = (name: string, expired = false): Record<string, unknown> => ({
  id: 1,
  name,
  expired,
  expires_at: '2026-10-29T13:03:27Z',
});

let recordText: string | undefined;
async function record(
  change: (r: Record<string, Record<string, unknown>>) => void = () => undefined,
): Promise<string> {
  recordText ??= (await composed()).text;
  const value = JSON.parse(recordText) as Record<string, Record<string, unknown>>;
  change(value);
  return canonicalJson(value);
}

const api = (
  runs: unknown[],
  artifacts: [number, unknown[] | null][] = [],
  extra: Partial<ApiData> = {},
): ApiData => ({
  runs,
  runsComplete: true,
  artifacts: new Map(artifacts),
  problems: [],
  artifactProblems: [],
  ...extra,
});

const report = (
  tree: Map<string, string>,
  data: ApiData,
  options: { historyProblems?: string[]; immutability?: string[] | null } = {},
) =>
  reconcile({
    repository: REPOSITORY,
    tree,
    historyProblems: options.historyProblems ?? [],
    historyCommit: 'a'.repeat(40),
    immutabilityProblems: options.immutability === undefined ? [] : options.immutability,
    api: data,
  });

const path = (id: number, attempt: number): string =>
  `v1/runs/${String(id)}-${String(attempt)}.json`;

// ---------------------------------------------------------------- classification

describe('reconcile: eligible run attempts (synthetic API data)', () => {
  test('a normal history: the listed run has a matching record', async () => {
    const r = report(new Map([[path(RUN_ID, 1), await record()]]), api([run()]));
    assert.deepEqual(r.attempts, [
      { runId: RUN_ID, attempt: 1, runNumber: 2, status: 'published', path: path(RUN_ID, 1) },
    ]);
    assert.equal(r.summary.published, 1);
    assert.equal(r.api.complete, true);
    assert.deepEqual(r.verdict, {
      integrity: 'verified',
      coverage: 'complete',
      missingAttempts: 0,
    });
    assert.equal(exitCode(r), 0);
  });

  const missing: [string, unknown[] | null, string, Record<string, unknown>][] = [
    [
      'raw artifacts retained',
      [artifact('ci-snapshot-attempt-1.json'), artifact('ci-suite-results-attempt-1.json')],
      'unpublished-artifacts-retained',
      { artifactsExpireAt: '2026-10-29T13:03:27Z' },
    ],
    [
      'raw artifacts expired',
      [artifact('ci-snapshot-attempt-1.json', true)],
      'unpublished-artifacts-expired',
      {},
    ],
    [
      'only legacy archive artifacts',
      [artifact('ci-snapshot-attempt-1'), artifact('ci-suite-results-attempt-1')],
      'unpublished-legacy-artifacts',
      {},
    ],
    ['no artifacts listed', [], 'unpublished-no-artifacts', {}],
    [
      'suite results only (no snapshot)',
      [artifact('ci-suite-results-attempt-1.json')],
      'unpublished-no-artifacts',
      {},
    ],
    ['an artifact listing that could not be read', null, 'metadata-unavailable', {}],
  ];
  for (const [name, listing, status, extra] of missing) {
    test(`a missing record with ${name}: ${status}`, () => {
      const r = report(new Map(), api([run()], [[RUN_ID, listing]]));
      assert.deepEqual(r.attempts, [
        { runId: RUN_ID, attempt: 1, runNumber: 2, status, path: path(RUN_ID, 1), ...extra },
      ]);
      // A known missing record is a coverage gap (exit 2), whatever the artifacts say.
      assert.deepEqual(r.verdict, { integrity: 'verified', coverage: 'gaps', missingAttempts: 1 });
      assert.equal(exitCode(r), 2);
    });
  }

  test('a missing artifact listing is never read as "no artifacts"', () => {
    const r = report(new Map(), api([run()]));
    assert.equal(r.attempts[0]?.status, 'metadata-unavailable');
  });

  test('rerun attempts: every attempt up to the latest is reconciled on its own', async () => {
    const records = new Map([
      [path(RUN_ID, 1), await record()],
      [
        path(RUN_ID, 3),
        await record((v) => {
          (v['run'] as Record<string, unknown>)['attempt'] = 3;
        }),
      ],
    ]);
    const r = report(
      records,
      api([run({ run_attempt: 3 })], [[RUN_ID, [artifact('ci-snapshot-attempt-2.json')]]]),
    );
    assert.deepEqual(
      r.attempts.map((a) => [a.attempt, a.status]),
      [
        [1, 'published'],
        [2, 'unpublished-artifacts-retained'],
        [3, 'published'],
      ],
    );
    assert.deepEqual(r.verdict, { integrity: 'verified', coverage: 'gaps', missingAttempts: 1 });
    assert.equal(exitCode(r), 2);
  });

  const inconsistencies: [
    string,
    (v: Record<string, Record<string, unknown>>) => void,
    string[],
  ][] = [
    [
      'another commit',
      (v) => {
        (v as Record<string, unknown>)['commitSha'] = 'f'.repeat(40);
      },
      ['commitSha'],
    ],
    [
      'another run number',
      (v) => {
        (v['run'] as Record<string, unknown>)['number'] = 3;
      },
      ['run.number'],
    ],
    [
      'another event',
      (v) => {
        (v['trigger'] as Record<string, unknown>)['event'] = 'workflow_dispatch';
      },
      ['trigger.event'],
    ],
    [
      'another attempt than its path',
      (v) => {
        (v['run'] as Record<string, unknown>)['attempt'] = 2;
      },
      ['run.attempt'],
    ],
  ];
  for (const [name, change, mismatches] of inconsistencies) {
    test(`a record with ${name} is inconsistent (exit 1)`, async () => {
      const r = report(new Map([[path(RUN_ID, 1), await record(change)]]), api([run()]));
      assert.deepEqual(r.attempts[0], {
        runId: RUN_ID,
        attempt: 1,
        runNumber: 2,
        status: 'inconsistent',
        path: path(RUN_ID, 1),
        mismatches,
      });
      assert.equal(exitCode(r), 1);
    });
  }

  test('a record that is not JSON is inconsistent, never published', () => {
    const r = report(new Map([[path(RUN_ID, 1), '{']]), api([run()]));
    assert.equal(r.attempts[0]?.status, 'inconsistent');
  });
});

describe('reconcile: runs that are not eligible and records without a listed run', () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ['a pull request run', { event: 'pull_request' }, 'ineligible', 'event not recorded'],
    ['a scheduled run', { event: 'schedule' }, 'ineligible', 'event not recorded'],
    ['a fork', { head_repository: { full_name: 'someone/fork' } }, 'ineligible', 'fork'],
    ['another branch', { head_branch: 'feature' }, 'ineligible', 'not main'],
    ['another workflow name', { name: 'Other' }, 'ineligible', 'other workflow'],
    [
      'another repository',
      { repository: { full_name: 'someone/else' } },
      'ineligible',
      'other repository',
    ],
    ['a run in progress', { status: 'in_progress', conclusion: null }, 'pending', 'not completed'],
    ['a queued run', { status: 'queued', conclusion: null }, 'pending', 'not completed'],
  ];
  for (const [name, change, status, reason] of cases) {
    test(`${name}: ${status} (${reason}), no attempts`, () => {
      const r = report(new Map(), api([run(change)]));
      assert.deepEqual(r.runs, [{ runId: RUN_ID, runNumber: 2, status, reason }]);
      assert.deepEqual(r.attempts, []);
      assert.equal(eligibility(REPOSITORY, run(change)).eligible, false);
      assert.equal(exitCode(r), 0);
    });
  }

  test('a record whose run is not listed is reported as unlisted, not judged', async () => {
    const r = report(new Map([[path(RUN_ID, 1), await record()]]), api([]));
    assert.deepEqual(r.unlistedRecords, [path(RUN_ID, 1)]);
    assert.equal(r.summary['unlisted-record'], 1);
    assert.equal(exitCode(r), 0);
  });

  test('a record of an ineligible run is unlisted, never counted as published', async () => {
    const r = report(
      new Map([[path(RUN_ID, 1), await record()]]),
      api([run({ event: 'pull_request' })]),
    );
    assert.equal(r.summary.published, 0);
    assert.deepEqual(r.unlistedRecords, [path(RUN_ID, 1)]);
  });
});

describe('reconcile: incomplete or malformed inputs', () => {
  test('a partial runs listing with no known gap: coverage undetermined (exit 2)', async () => {
    const r = report(
      new Map([[path(RUN_ID, 1), await record()]]),
      api([run()], [], { runsComplete: false, problems: ['1 of 2 runs were listed'] }),
    );
    assert.equal(r.api.complete, false);
    assert.deepEqual(r.api.problems, ['1 of 2 runs were listed']);
    assert.deepEqual(r.verdict, {
      integrity: 'verified',
      coverage: 'undetermined',
      missingAttempts: 0,
    });
    assert.equal(exitCode(r), 2);
  });

  test('a partial runs listing with a known gap: coverage gaps (exit 2), never "complete"', () => {
    const r = report(
      new Map(),
      api([run()], [[RUN_ID, []]], { runsComplete: false, problems: ['1 of 2 runs were listed'] }),
    );
    assert.deepEqual(r.verdict, { integrity: 'verified', coverage: 'gaps', missingAttempts: 1 });
    assert.equal(exitCode(r), 2);
  });

  test('an unreadable artifact listing of a fully published run changes nothing (exit 0)', async () => {
    const r = report(
      new Map([[path(RUN_ID, 1), await record()]]),
      api([run()], [[RUN_ID, null]], {
        artifactProblems: [`artifacts of run ${String(RUN_ID)} could not be read in full`],
      }),
    );
    assert.equal(r.api.complete, true);
    assert.deepEqual(r.api.artifactProblems, [
      `artifacts of run ${String(RUN_ID)} could not be read in full`,
    ]);
    assert.deepEqual(r.verdict, {
      integrity: 'verified',
      coverage: 'complete',
      missingAttempts: 0,
    });
    assert.equal(exitCode(r), 0);
  });

  test('integrity failure wins over gaps and incomplete data (exit 1)', async () => {
    const inconsistent = await record((v) => {
      (v as Record<string, unknown>)['commitSha'] = 'f'.repeat(40);
    });
    const r = report(
      new Map([[path(RUN_ID, 1), inconsistent]]),
      api([run({ run_attempt: 2 })], [[RUN_ID, []]], { runsComplete: false }),
      { immutability: null },
    );
    assert.deepEqual(r.verdict, { integrity: 'failed', coverage: 'gaps', missingAttempts: 1 });
    assert.equal(exitCode(r), 1);
  });

  test('pending and ineligible runs and unlisted records change neither verdict (exit 0)', async () => {
    const r = report(
      new Map([[path(39144953999, 1), await record()]]),
      api([
        run({ status: 'in_progress', conclusion: null }),
        run({ id: 39144953401, event: 'pull_request' }),
      ]),
    );
    assert.deepEqual(r.verdict, {
      integrity: 'verified',
      coverage: 'complete',
      missingAttempts: 0,
    });
    assert.equal(r.summary.pending + r.summary.ineligible + r.summary['unlisted-record'], 3);
    assert.equal(exitCode(r), 0);
  });

  test('a run listed twice or without an ID is a problem, counted once', () => {
    const r = report(new Map(), api([run(), run(), { id: 'x' }], [[RUN_ID, []]]));
    assert.equal(r.attempts.length, 1);
    assert.deepEqual(r.api.problems, [
      `run ${String(RUN_ID)} is listed twice`,
      'a listed run has no valid ID',
    ]);
    assert.equal(exitCode(r), 2);
  });

  test('a malformed history is invalid (exit 1), and wins over incomplete data', () => {
    const r = report(new Map(), api([], [], { runsComplete: false }), {
      historyProblems: [
        'v1/index.json: does not match the records (stale, edited or out of order)',
      ],
    });
    assert.equal(r.history.valid, false);
    assert.equal(exitCode(r), 1);
  });

  test('immutability: violated is exit 1, not checked is exit 2', () => {
    assert.equal(
      exitCode(report(new Map(), api([]), { immutability: ['x: v1/runs/1-1.json was modified'] })),
      1,
    );
    const notChecked = report(new Map(), api([]), { immutability: null });
    assert.equal(notChecked.history.immutability, 'not-checked');
    assert.equal(exitCode(notChecked), 2);
  });

  test('the report is deterministic: input order does not matter', async () => {
    const other = 39144953400;
    const tree = new Map([[path(RUN_ID, 1), await record()]]);
    const runs = [
      run({ id: other, run_number: 3 }),
      run(),
      run({ id: 39144953500, run_number: 4, event: 'pull_request' }),
    ];
    const listings: [number, unknown[]][] = [
      [RUN_ID, []],
      [other, []],
    ];
    const a = canonicalJson(report(tree, api(runs, listings)));
    const b = canonicalJson(report(tree, api([...runs].reverse(), [...listings].reverse())));
    assert.equal(a, b);
    assert.deepEqual(
      (JSON.parse(a) as { attempts: { runId: number }[] }).attempts.map((x) => x.runId),
      [RUN_ID, other],
    );
  });

  test('the Markdown summary states that a missing artifact is not proof of absence', () => {
    const text = markdown(report(new Map(), api([run()], [[RUN_ID, []]])));
    assert.match(text, /^## CI history reconciliation \(read-only\)/);
    assert.match(text, /\| unpublished-no-artifacts \| 1 \|/);
    assert.match(
      text,
      /it is not evidence that the run attempt did not happen\. This report changes nothing\./,
    );
  });
});

// ---------------------------------------------------------------- git audit

describe('reconcile: immutability audit of the branch history', () => {
  const sha = (n: number): string => String(n).repeat(40).slice(0, 40);
  const commit = (n: number, parents: string, author: string, changes: string[]): string =>
    `\0${sha(n)}\t${parents}\t${author}\n\n${changes.join('\n')}\n`;
  const root = commit(1, '', 'Larysa Karahieorhii <92583129+LarysaK@users.noreply.github.com>', [
    'A\tREADME.md',
  ]);
  const add = (n: number, record: string, index = 'M', author = PUBLISHER_IDENTITY): string =>
    commit(n, sha(n - 1), author, [`${index}\tv1/index.json`, `A\t${record}`]);

  test('a branch of publisher additions passes', () => {
    assert.deepEqual(
      auditHistoryLog(root + add(2, 'v1/runs/1-1.json', 'A') + add(3, 'v1/runs/1-2.json')),
      [],
    );
  });

  const violations: [string, string, RegExp][] = [
    [
      'a modified record',
      root +
        add(2, 'v1/runs/1-1.json', 'A') +
        commit(3, sha(2), PUBLISHER_IDENTITY, ['M\tv1/index.json', 'M\tv1/runs/1-1.json']),
      /v1\/runs\/1-1\.json was modified/,
    ],
    [
      'a deleted record',
      root +
        add(2, 'v1/runs/1-1.json', 'A') +
        commit(3, sha(2), PUBLISHER_IDENTITY, ['M\tv1/index.json', 'D\tv1/runs/1-1.json']),
      /v1\/runs\/1-1\.json was deleted/,
    ],
    [
      'a record added twice',
      root + add(2, 'v1/runs/1-1.json', 'A') + add(3, 'v1/runs/1-1.json'),
      /v1\/runs\/1-1\.json added again/,
    ],
    [
      'another file',
      root +
        commit(2, sha(1), PUBLISHER_IDENTITY, [
          'A\tv1/index.json',
          'A\tv1/runs/1-1.json',
          'A\tnotes.txt',
        ]),
      /changes notes\.txt/,
    ],
    [
      'two records in one commit',
      root +
        commit(2, sha(1), PUBLISHER_IDENTITY, [
          'A\tv1/index.json',
          'A\tv1/runs/1-1.json',
          'A\tv1/runs/1-2.json',
        ]),
      /adds 2 records; each commit adds exactly one/,
    ],
    [
      'a commit without a record',
      root + commit(2, sha(1), PUBLISHER_IDENTITY, ['M\tREADME.md']),
      /adds 0 records/,
    ],
    [
      'an addition by someone else',
      root + add(2, 'v1/runs/1-1.json', 'A', 'someone <someone@example.invalid>'),
      /not authored by the publisher/,
    ],
    [
      'a deleted index',
      root +
        add(2, 'v1/runs/1-1.json', 'A') +
        commit(3, sha(2), PUBLISHER_IDENTITY, ['D\tv1/index.json', 'A\tv1/runs/1-2.json']),
      /v1\/index\.json was deleted/,
    ],
    [
      'a merge commit',
      root +
        commit(2, `${sha(1)} ${sha(9)}`, PUBLISHER_IDENTITY, [
          'A\tv1/index.json',
          'A\tv1/runs/1-1.json',
        ]),
      /has 2 parents/,
    ],
    [
      'a root commit with more than the README',
      commit(1, '', 'x <x@example.invalid>', ['A\tREADME.md', 'A\tsrc.ts']),
      /the root commit adds src\.ts/,
    ],
    [
      'a first commit that is not a root',
      commit(1, sha(0), PUBLISHER_IDENTITY, ['A\tREADME.md']),
      /not a root commit/,
    ],
    ['an empty log', '', /the branch has no commits/],
  ];
  for (const [name, log, reason] of violations) {
    test(`detects ${name}`, () => {
      assert.match(auditHistoryLog(log).join('\n'), reason);
    });
  }
});

// ---------------------------------------------------------------- API reader

describe('reconcile: reading the Actions API (fake transport)', () => {
  type Reply = { status: number; body: unknown };
  const transport = (routes: (path: string) => Reply) => {
    const calls: { url: string; headers: Record<string, string>; redirect: string }[] = [];
    return {
      calls,
      fetch: (url: string, init: { headers: Record<string, string>; redirect: 'error' }) => {
        calls.push({ url, headers: init.headers, redirect: init.redirect });
        const { status, body } = routes(new URL(url).pathname + new URL(url).search);
        return Promise.resolve({
          status,
          text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        });
      },
    };
  };
  const page = (runs: unknown[], total: number): Reply => ({
    status: 200,
    body: { total_count: total, workflow_runs: runs },
  });
  /** The page number of a runs-list request (exact query parameter); undefined otherwise. */
  const pageOf = (p: string): number | undefined => {
    if (!p.includes('/runs?')) return undefined;
    const value = new URLSearchParams(p.slice(p.indexOf('?') + 1)).get('page');
    return value === null ? undefined : Number(value);
  };
  const listing = (items: unknown[]): Reply => ({
    status: 200,
    body: { total_count: items.length, artifacts: items },
  });

  test('reads every page of runs on main, then artifacts only for eligible runs', async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      run({ id: RUN_ID + i, run_number: i + 1, event: i === 0 ? 'push' : 'pull_request' }),
    );
    const t = transport((p) =>
      pageOf(p) === 1
        ? page(many.slice(0, 100), 150)
        : pageOf(p) === 2
          ? page(many.slice(100), 150)
          : listing([]),
    );
    const data = await fetchApiData(REPOSITORY, '', t.fetch);
    assert.equal(data.runs.length, 150);
    assert.equal(data.runsComplete, true);
    assert.deepEqual(data.problems, []);
    assert.deepEqual(
      t.calls.map((c) => c.url.replace('https://api.github.com', '')),
      [
        `/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&per_page=100&page=1`,
        `/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&per_page=100&page=2`,
        `/repos/${REPOSITORY}/actions/runs/${String(RUN_ID)}/artifacts?per_page=100`,
      ],
    );
    for (const call of t.calls) {
      assert.equal(call.redirect, 'error');
      assert.equal(
        call.headers['Authorization'],
        undefined,
        'unauthenticated unless a token is given',
      );
    }
  });

  test('sends a token only when one is given', async () => {
    const t = transport(() => page([], 0));
    await fetchApiData(REPOSITORY, 'ghs_example', t.fetch);
    assert.equal(t.calls[0]?.headers['Authorization'], 'Bearer ghs_example');
  });

  const partial: [string, (p: string) => Reply, RegExp][] = [
    [
      'a failed second page',
      (p) =>
        pageOf(p) === 1
          ? page([run()], 2)
          : pageOf(p) === 2
            ? { status: 500, body: {} }
            : listing([]),
      /runs page 2 could not be read/,
    ],
    [
      'a page that is not JSON',
      () => ({ status: 200, body: '<html>' }),
      /runs page 1 could not be read/,
    ],
    [
      'fewer runs than total_count',
      (p) => (pageOf(p) === 1 ? page([run()], 2) : pageOf(p) === 2 ? page([], 2) : listing([])),
      /1 of 2 runs were listed/,
    ],
    [
      'an artifact listing with a wrong total',
      (p) =>
        p.includes('/runs?')
          ? page([run()], 1)
          : { status: 200, body: { total_count: 5, artifacts: [] } },
      new RegExp(`artifacts of run ${String(RUN_ID)} could not be read in full`),
    ],
    [
      'a failed artifact listing',
      (p) => (p.includes('/runs?') ? page([run()], 1) : { status: 403, body: {} }),
      new RegExp(`artifacts of run ${String(RUN_ID)} could not be read in full`),
    ],
  ];
  for (const [name, routes, reason] of partial) {
    test(`${name}: reported, never guessed`, async () => {
      const data = await fetchApiData(REPOSITORY, '', transport(routes).fetch);
      assert.match([...data.problems, ...data.artifactProblems].join('\n'), reason);
      const r = report(new Map(), data);
      assert.notEqual(r.verdict.coverage, 'complete');
      assert.equal(exitCode(r), 2);
    });
  }

  test('artifact listing failures are kept apart from the runs listing', async () => {
    const data = await fetchApiData(
      REPOSITORY,
      '',
      transport((p) => (pageOf(p) !== undefined ? page([run()], 1) : { status: 403, body: {} }))
        .fetch,
    );
    assert.deepEqual(data.problems, []);
    assert.equal(data.runsComplete, true);
    assert.deepEqual(data.artifactProblems, [
      `artifacts of run ${String(RUN_ID)} could not be read in full`,
    ]);
  });

  test('stops after the page limit and reports the remainder as incomplete', async () => {
    const data = await fetchApiData(
      REPOSITORY,
      '',
      transport((p) =>
        p.includes('/runs?') ? page([run({ event: 'pull_request' })], 5000) : listing([]),
      ).fetch,
    );
    assert.equal(data.runsComplete, false);
    assert.match(data.problems.join('\n'), /10 of 5000 runs were listed/);
  });
});

// ---------------------------------------------------------------- CLI end to end

const GIT_ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Larysa Karahieorhii',
  GIT_AUTHOR_EMAIL: '92583129+LarysaK@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Larysa Karahieorhii',
  GIT_COMMITTER_EMAIL: '92583129+LarysaK@users.noreply.github.com',
};
const BOT_ENV = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};
function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A local ci-history like the real one: a README root commit, then one publisher commit. */
async function history(): Promise<string> {
  const dir = join(temporary('ci-reconcile-history-'), 'ci-history');
  git(tmpdir(), {}, 'init', '-q', '-b', 'ci-history', dir);
  writeFileSync(join(dir, 'README.md'), '# CI history\n');
  git(dir, {}, 'add', '--', 'README.md');
  git(dir, {}, 'commit', '-q', '-m', 'ci-history: initialize history branch');
  const recordFile = join(temporary('ci-reconcile-record-'), 'record.json');
  writeFileSync(recordFile, await record());
  const added = spawnSync(
    TSX,
    [join(__dirname, 'history-cli.ts'), 'add', '--history', dir, '--record', recordFile],
    { cwd: REPO, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
  );
  assert.equal(added.status, 0, added.stderr);
  git(dir, BOT_ENV, 'add', '--', 'v1');
  git(dir, BOT_ENV, 'commit', '-q', '-m', `ci-history: add run ${String(RUN_ID)} attempt 1`);
  return dir;
}

/** Saved API responses: run #2 (published) and one more eligible run with retained artifacts. */
function apiDir(change: (files: Record<string, unknown>) => void = () => undefined): string {
  const dir = temporary('ci-reconcile-api-');
  const files: Record<string, unknown> = {
    'runs-page-1.json': {
      total_count: 2,
      workflow_runs: [run(), run({ id: 39144953400, run_number: 3 })],
    },
    [`artifacts-${String(RUN_ID)}.json`]: { total_count: 0, artifacts: [] },
    'artifacts-39144953400.json': {
      total_count: 1,
      artifacts: [artifact('ci-snapshot-attempt-1.json')],
    },
  };
  change(files);
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
}

function cli(historyDir: string, api: string, format = 'json') {
  return spawnSync(
    TSX,
    [
      join(__dirname, 'reconcile-cli.ts'),
      '--history',
      historyDir,
      '--api',
      api,
      '--format',
      format,
    ],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    },
  );
}

/** Every entry under `dir`, including .git, with a content hash. */
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string, rel: string): void => {
    for (const name of readdirSync(p).sort()) {
      const abs = join(p, name);
      if (lstatSync(abs).isDirectory()) walk(abs, `${rel}${name}/`);
      else
        out.push(`${rel}${name} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}

describe('reconcile CLI (local git history, saved synthetic API responses)', () => {
  test('every eligible attempt published: exit 0 (integrity verified, coverage complete)', async () => {
    const onlyPublished = apiDir((f) => {
      f['runs-page-1.json'] = { total_count: 1, workflow_runs: [run()] };
      delete f['artifacts-39144953400.json'];
    });
    const result = cli(await history(), onlyPublished);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((JSON.parse(result.stdout) as { verdict: unknown }).verdict, {
      integrity: 'verified',
      coverage: 'complete',
      missingAttempts: 0,
    });
  });

  test('a valid history with an unpublished eligible attempt: exit 2 (coverage gaps), deterministic, nothing changed', async () => {
    const dir = await history();
    const before = fingerprint(dir);
    const first = cli(dir, apiDir());
    assert.equal(first.status, 2, first.stderr);
    const parsed = JSON.parse(first.stdout) as {
      history: Record<string, unknown>;
      summary: Record<string, number>;
      attempts: { status: string }[];
      verdict: unknown;
    };
    assert.deepEqual(parsed.verdict, {
      integrity: 'verified',
      coverage: 'gaps',
      missingAttempts: 1,
    });
    assert.equal(parsed.history['valid'], true);
    assert.equal(parsed.history['immutability'], 'verified');
    assert.equal(parsed.history['commit'], git(dir, {}, 'rev-parse', 'HEAD').trim());
    assert.equal(parsed.summary['published'], 1);
    assert.equal(parsed.summary['unpublished-artifacts-retained'], 1);
    assert.equal(cli(dir, apiDir()).stdout, first.stdout, 'the same inputs give the same bytes');
    assert.deepEqual(
      fingerprint(dir),
      before,
      'the history checkout, including .git, is unchanged',
    );
    const text = cli(dir, apiDir(), 'markdown').stdout;
    assert.match(
      text,
      /\| 39144953400 \| 1 \| 3 \| unpublished-artifacts-retained \| artifacts expire 2026-10-29T13:03:27Z \|/,
    );
    assert.match(
      text,
      /\*\*Integrity: verified\. Coverage: gaps \(1 eligible run attempt\(s\) without a record\)\. Exit 2\.\*\*/,
    );
    assert.match(
      text,
      /Exit 0: integrity verified and coverage complete\. Exit 1: integrity failed/,
    );
  });

  test('a record changed after publication: immutability violated and the index stale (exit 1)', async () => {
    const dir = await history();
    const file = join(dir, path(RUN_ID, 1));
    writeFileSync(file, readFileSync(file, 'utf8').replace('"success"', '"failure"'));
    git(dir, BOT_ENV, 'commit', '-q', '-am', 'edit');
    const result = cli(dir, apiDir());
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout) as {
      history: {
        valid: boolean;
        immutability: string;
        immutabilityProblems: string[];
        problems: string[];
      };
    };
    assert.equal(parsed.history.immutability, 'violated');
    assert.match(
      parsed.history.immutabilityProblems.join('\n'),
      /v1\/runs\/39144953322-1\.json was modified/,
    );
    assert.equal(parsed.history.valid, false);
    assert.match(parsed.history.problems.join('\n'), /v1\/index\.json: does not match the records/);
  });

  test('a copy that is not a git checkout: the audit is not checked (exit 2)', async () => {
    const copy = join(temporary('ci-reconcile-copy-'), 'copy');
    cpSync(await history(), copy, {
      recursive: true,
      filter: (src) => !src.split('/').includes('.git'),
    });
    const result = cli(copy, apiDir());
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout) as {
      history: { immutability: string };
      verdict: { integrity: string };
    };
    assert.equal(parsed.history.immutability, 'not-checked');
    assert.equal(parsed.verdict.integrity, 'unverified');
  });

  test('local changes in the checkout are an audit problem (exit 1)', async () => {
    const dir = await history();
    mkdirSync(join(dir, 'v1', 'runs'), { recursive: true });
    writeFileSync(join(dir, 'stray.txt'), 'x');
    const result = cli(dir, apiDir());
    assert.equal(result.status, 1);
    assert.match(result.stdout, /the checkout has local changes/);
  });

  test('missing saved API pages: incomplete (exit 2), and no run is guessed', async () => {
    const result = cli(
      await history(),
      apiDir((f) => delete f['runs-page-1.json']),
    );
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stdout) as {
      api: { complete: boolean; problems: string[] };
      summary: Record<string, number>;
      unlistedRecords: string[];
    };
    assert.equal(parsed.api.complete, false);
    assert.deepEqual(parsed.api.problems, ['runs page 1 could not be read']);
    assert.equal(parsed.summary['published'], 0);
    assert.deepEqual(parsed.unlistedRecords, [path(RUN_ID, 1)]);
    assert.deepEqual((parsed as unknown as { verdict: unknown }).verdict, {
      integrity: 'verified',
      coverage: 'undetermined',
      missingAttempts: 0,
    });
  });

  test('the reconciliation code never writes, pushes or calls a non-GET API (source check)', () => {
    for (const file of ['reconcile.ts', 'reconcile-cli.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      assert.doesNotMatch(
        source,
        /writeFileSync|appendFileSync|renameSync|rmSync|mkdirSync|unlinkSync|method:/,
        file,
      );
    }
    // The CLI is the only file that runs git: read-only subcommands only.
    const cliSource = readFileSync(join(__dirname, 'reconcile-cli.ts'), 'utf8');
    const verbs = [...cliSource.matchAll(/git\(\s*'([a-z-]+)'/g)].map((m) => m[1] ?? '');
    assert.deepEqual([...new Set(verbs)].sort(), ['log', 'rev-parse', 'status']);
  });
});
