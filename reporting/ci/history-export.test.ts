import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import { canonicalJson } from './history';
import { validateExport } from './history-export';
import { exportHistory } from './history-export-cli';
import { apiDir, BOT_ENV, git, history } from './reconcile.test';

/**
 * The dashboard's CI history export (M4) from real local git histories built by the tests, with
 * synthetic reconciliation reports produced by the real reconcile CLI from saved API responses.
 * Nothing here touches a remote.
 */

const REPO = resolve('.');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const REPOSITORY = 'LarysaK/AI-QA-AutomationFramework';
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temporary = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A reconciliation report (JSON) of `dir` against saved API responses. */
function reconciliation(dir: string, api = apiDir()): string {
  const result = spawnSync(
    TSX,
    [join(__dirname, 'reconcile-cli.ts'), '--history', dir, '--api', api],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    },
  );
  const file = join(temporary('ci-export-report-'), 'report.json');
  writeFileSync(file, result.stdout);
  return file;
}

function refusal(fn: () => unknown, reason: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, reason);
    return true;
  });
}

type Exported = {
  source: Record<string, unknown>;
  coverage: Record<string, unknown> | null;
  records: { run: { id: number; attempt: number } }[];
};

describe('CI history export (dashboard data, M4)', () => {
  test('a verified history: deterministic, provenance from its commit, no coverage without a report', async () => {
    const dir = await history();
    const first = exportHistory({ history: dir, repository: REPOSITORY });
    assert.equal(
      exportHistory({ history: dir, repository: REPOSITORY }),
      first,
      'same commit, same bytes',
    );
    const parsed = JSON.parse(first) as Exported;
    assert.equal(parsed.source['commit'], git(dir, {}, 'rev-parse', 'HEAD').trim());
    assert.equal(parsed.source['branch'], 'ci-history');
    assert.match(String(parsed.source['committedAt']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(parsed.coverage, null);
    assert.deepEqual(
      parsed.records.map((r) => r.run.id),
      [39144953322],
    );
    assert.deepEqual(validateExport(parsed), []);
    assert.equal(first, canonicalJson(parsed));
  });

  test('with a reconciliation of the same commit: the coverage of unpublished attempts', async () => {
    const dir = await history();
    const parsed = JSON.parse(
      exportHistory({ history: dir, repository: REPOSITORY, reconciliation: reconciliation(dir) }),
    ) as Exported;
    assert.ok(parsed.coverage);
    assert.equal(parsed.coverage['verdict'], 'gaps');
    assert.equal(parsed.coverage['missingAttempts'], 1);
    assert.deepEqual(parsed.coverage['unpublished'], [
      { runId: 39144953400, attempt: 1, runNumber: 3, status: 'unpublished-artifacts-retained' },
    ]);
    assert.equal((parsed.coverage['counts'] as Record<string, number>)['published'], 1);
  });

  test('records are newest first, by job completion time', async () => {
    const dir = await history();
    const record = JSON.parse(
      readFileSync(join(dir, 'v1/runs/39144953322-1.json'), 'utf8'),
    ) as Record<string, Record<string, unknown>>;
    (record['run'] as Record<string, unknown>)['attempt'] = 2;
    (record['timestamps'] as Record<string, unknown>)['jobCompletedAt'] = '2026-10-18T20:11:00Z';
    const file = join(temporary('ci-export-record-'), 'r.json');
    writeFileSync(file, canonicalJson(record));
    const added = spawnSync(
      TSX,
      [join(__dirname, 'history-cli.ts'), 'add', '--history', dir, '--record', file],
      { cwd: REPO, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
    );
    assert.equal(added.status, 0, added.stderr);
    git(dir, BOT_ENV, 'add', '--', 'v1');
    git(dir, BOT_ENV, 'commit', '-q', '-m', 'ci-history: add run 39144953322 attempt 2');
    const parsed = JSON.parse(exportHistory({ history: dir, repository: REPOSITORY })) as Exported;
    assert.deepEqual(
      parsed.records.map((r) => r.run.attempt),
      [2, 1],
    );
  });

  const refusals: [
    string,
    (dir: string) => Promise<{ reconciliation?: string; history?: string }>,
    RegExp,
  ][] = [
    [
      'a tampered record (invalid history and immutability)',
      async (dir) => {
        const file = join(dir, 'v1/runs/39144953322-1.json');
        writeFileSync(file, readFileSync(file, 'utf8').replace('"success"', '"failure"'));
        git(dir, BOT_ENV, 'commit', '-q', '-am', 'edit');
        return Promise.resolve({});
      },
      /not valid|immutability audit failed/,
    ],
    [
      'a copy that is not a git checkout',
      async (dir) => {
        const copy = join(temporary('ci-export-copy-'), 'copy');
        spawnSync('cp', ['-R', dir, copy]);
        rmSync(join(copy, '.git'), { recursive: true, force: true });
        return Promise.resolve({ history: copy });
      },
      /must be a git checkout of ci-history/,
    ],
    [
      'a reconciliation of another commit',
      async (dir) => {
        const report = reconciliation(dir);
        git(dir, BOT_ENV, 'commit', '-q', '--allow-empty', '-m', 'later');
        return Promise.resolve({ reconciliation: report });
      },
      /checked another ci-history commit|immutability audit failed/,
    ],
    [
      'a reconciliation whose integrity is not verified',
      async (dir) => {
        const file = reconciliation(dir);
        const report = JSON.parse(readFileSync(file, 'utf8')) as Record<
          string,
          Record<string, unknown>
        >;
        (report['verdict'] as Record<string, unknown>)['integrity'] = 'failed';
        writeFileSync(file, JSON.stringify(report));
        return Promise.resolve({ reconciliation: file });
      },
      /did not verify integrity/,
    ],
    [
      'a reconciliation that calls a published record unpublished',
      async (dir) => {
        const file = reconciliation(dir);
        const report = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        const attempts = report['attempts'] as Record<string, unknown>[];
        const published = attempts.find((a) => a['status'] === 'published');
        assert.ok(published);
        published['status'] = 'unpublished-no-artifacts';
        writeFileSync(file, JSON.stringify(report));
        return Promise.resolve({ reconciliation: file });
      },
      /has a record but the reconciliation calls it unpublished/,
    ],
    [
      'a reconciliation that is not JSON',
      async () => {
        const file = join(temporary('ci-export-bad-'), 'r.json');
        writeFileSync(file, '{');
        return Promise.resolve({ reconciliation: file });
      },
      /not JSON/,
    ],
  ];
  for (const [name, prepare, reason] of refusals) {
    test(`refuses ${name}, and the CLI writes nothing`, async () => {
      const dir = await history();
      const options = await prepare(dir);
      refusal(
        () =>
          exportHistory({
            history: options.history ?? dir,
            repository: REPOSITORY,
            ...(options.reconciliation === undefined
              ? {}
              : { reconciliation: options.reconciliation }),
          }),
        reason,
      );
      const out = join(temporary('ci-export-out-'), 'ci-history.json');
      const cli = spawnSync(
        TSX,
        [
          join(__dirname, 'history-export-cli.ts'),
          '--history',
          options.history ?? dir,
          '--out',
          out,
          ...(options.reconciliation === undefined
            ? []
            : ['--reconciliation', options.reconciliation]),
        ],
        { cwd: REPO, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
      );
      assert.equal(cli.status, 1);
      assert.equal(existsSync(out), false);
    });
  }

  test('the CLI writes exactly the --out file, and nothing in the history checkout', async () => {
    const dir = await history();
    const before =
      git(dir, {}, 'status', '--porcelain', '--untracked-files=all') +
      git(dir, {}, 'rev-parse', 'HEAD');
    const out = join(temporary('ci-export-cli-'), 'nested', 'ci-history.json');
    const cli = spawnSync(
      TSX,
      [join(__dirname, 'history-export-cli.ts'), '--history', dir, '--out', out],
      { cwd: REPO, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /"written":true/);
    assert.deepEqual(validateExport(JSON.parse(readFileSync(out, 'utf8'))), []);
    assert.equal(
      git(dir, {}, 'status', '--porcelain', '--untracked-files=all') +
        git(dir, {}, 'rev-parse', 'HEAD'),
      before,
    );
  });
});

/** Runs the export CLI; the parsed output file, or null when nothing was written. */
function cliExport(args: readonly string[]): {
  status: number | null;
  stderr: string;
  exported: Exported | null;
} {
  const out = join(temporary('ci-export-optional-'), 'ci-history.json');
  const cli = spawnSync(TSX, [join(__dirname, 'history-export-cli.ts'), ...args, '--out', out], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });
  return {
    status: cli.status,
    stderr: cli.stderr,
    exported: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Exported) : null,
  };
}

/** A copy of a real report with its integrity verdict replaced. */
function withIntegrity(file: string, integrity: string): string {
  const report = JSON.parse(readFileSync(file, 'utf8')) as { verdict: Record<string, unknown> };
  report.verdict['integrity'] = integrity;
  const copy = join(temporary('ci-export-integrity-'), 'report.json');
  writeFileSync(copy, JSON.stringify(report));
  return copy;
}

describe('CI history export: optional coverage for unattended builds (--coverage-if-verified)', () => {
  test('a verified report of the same commit: coverage is included, as with --reconciliation', async () => {
    const dir = await history();
    const result = cliExport(['--history', dir, '--coverage-if-verified', reconciliation(dir)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.exported?.coverage?.['verdict'], 'gaps');
    assert.equal(result.stderr, '');
  });

  const omitted: [string, (dir: string) => string, RegExp][] = [
    ['a missing report', () => join(temporary('ci-export-none-'), 'absent.json'), /missing/],
    [
      'an empty report (the reconciliation itself failed)',
      () => {
        const file = join(temporary('ci-export-empty-'), 'report.json');
        writeFileSync(file, '');
        return file;
      },
      /not JSON/,
    ],
    [
      'a report whose integrity is unverified',
      (dir) => withIntegrity(reconciliation(dir), 'unverified'),
      /did not verify/,
    ],
  ];
  for (const [name, report, reason] of omitted) {
    test(`${name}: exported without coverage, never estimated, and the omission is said`, async () => {
      const dir = await history();
      const result = cliExport(['--history', dir, '--coverage-if-verified', report(dir)]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.exported);
      assert.equal(result.exported.coverage, null);
      assert.deepEqual(validateExport(result.exported), []);
      assert.match(result.stderr, /^coverage not included: /);
      assert.match(result.stderr, reason);
    });
  }

  test('a report that found an integrity failure refuses the export', async () => {
    const dir = await history();
    const result = cliExport([
      '--history',
      dir,
      '--coverage-if-verified',
      withIntegrity(reconciliation(dir), 'failed'),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /integrity failure/);
    assert.equal(result.exported, null);
  });

  test('a verified report of another ci-history commit is still refused', async () => {
    const dir = await history();
    const report = JSON.parse(readFileSync(reconciliation(dir), 'utf8')) as {
      history: Record<string, unknown>;
    };
    report.history['commit'] = '0'.repeat(40);
    const file = join(temporary('ci-export-other-'), 'report.json');
    writeFileSync(file, JSON.stringify(report));
    const result = cliExport(['--history', dir, '--coverage-if-verified', file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the reconciliation checked another ci-history commit/);
    assert.equal(result.exported, null);
  });

  test('--reconciliation and --coverage-if-verified are mutually exclusive', async () => {
    const dir = await history();
    const report = reconciliation(dir);
    const result = cliExport([
      '--history',
      dir,
      '--reconciliation',
      report,
      '--coverage-if-verified',
      report,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mutually exclusive/);
    assert.equal(result.exported, null);
  });
});

describe('CI history export: validation the dashboard build repeats', () => {
  async function valid(): Promise<Record<string, unknown>> {
    const dir = await history();
    return JSON.parse(
      exportHistory({ history: dir, repository: REPOSITORY, reconciliation: reconciliation(dir) }),
    ) as Record<string, unknown>;
  }
  const cases: [string, (e: Record<string, unknown>) => void, RegExp][] = [
    ['an extra top-level field', (e) => (e['extra'] = 1), /unexpected or missing top-level fields/],
    ['another kind', (e) => (e['kind'] = 'x'), /not a ci-history-export 1\.0/],
    [
      'a record count that does not match',
      (e) => ((e['source'] as Record<string, unknown>)['records'] = 5),
      /source\.records does not match/,
    ],
    [
      'a commit time that is not an instant',
      (e) => ((e['source'] as Record<string, unknown>)['committedAt'] = '2026-02-30T00:00:00Z'),
      /committedAt is not an instant/,
    ],
    [
      'a duplicated record',
      (e) => (e['records'] as unknown[]).push((e['records'] as unknown[])[0]),
      /appears twice|not newest first/,
    ],
    [
      'a record URL of another repository',
      (e) =>
        ((
          (
            (e['records'] as Record<string, Record<string, unknown>>[])[0] as Record<
              string,
              Record<string, unknown>
            >
          )['run'] as Record<string, unknown>
        )['url'] = 'https://github.com/x/y/actions/runs/39144953322'),
      /run\.url is not this repository's run URL/,
    ],
    [
      'an unpublished attempt that has a record',
      (e) => {
        const coverage = e['coverage'] as Record<string, unknown>;
        coverage['unpublished'] = [
          { runId: 39144953322, attempt: 1, runNumber: 2, status: 'unpublished-no-artifacts' },
        ];
      },
      /an unpublished attempt has a record/,
    ],
    [
      'an unknown unpublished status',
      (e) => {
        const coverage = e['coverage'] as Record<string, unknown>;
        const first = (coverage['unpublished'] as Record<string, unknown>[])[0];
        assert.ok(first);
        first['status'] = 'failed';
      },
      /coverage: unknown status/,
    ],
  ];
  for (const [name, change, reason] of cases) {
    test(`rejects ${name}`, async () => {
      const exported = await valid();
      change(exported);
      assert.match(validateExport(exported).join('\n'), reason);
    });
  }

  test('the exporter only reads git and writes its output (source check)', () => {
    const source = readFileSync(join(__dirname, 'history-export-cli.ts'), 'utf8');
    const verbs = [...source.matchAll(/spawnSync\(\s*'git',\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual(verbs, ['log']);
    assert.equal(source.match(/writeFileSync\(/g)?.length, 1);
    assert.doesNotMatch(
      readFileSync(join(__dirname, 'history-export.ts'), 'utf8'),
      /writeFileSync|spawnSync|fetch\(/,
    );
  });
});
