import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  CollectError,
  collectSuites,
  composeRecord,
  REPORT_FILES,
  type ReportInput,
  serializeRecord,
  snapshotReference,
  type StepConclusion,
  SUITE_IDS,
  SUITE_STEPS,
  suiteFor,
  type SuiteId,
  validateRecord,
} from './collect';
import {
  type CompleteReport,
  type ParsedReport,
  parseNodeTap,
  parsePlaywrightJson,
  parseVitestJson,
} from './reports';

/**
 * Offline tests. Fixtures are real tool output (reporting/ci/fixtures, see its README) and the
 * real public Actions API responses of CI run #2; every variant below is derived from them in
 * the test and says so. Assertions compare against fixture contents, not repository totals.
 */

const REPO = resolve('.');
const FIXTURES = join(__dirname, 'fixtures');
const read = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8');
const json = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;
const RUNNER_REPO = '/home/runner/work/AI-QA-AutomationFramework/AI-QA-AutomationFramework';
const SAFETY = { forbiddenLiterals: [RUNNER_REPO, '/home/runner/work/fixture-src'] };

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function complete(report: ParsedReport): CompleteReport {
  if (!report.ok) assert.fail(`expected a complete report, got: ${report.reason}`);
  return report;
}

function rejected(report: ParsedReport, reason: RegExp): void {
  if (report.ok) assert.fail('expected the report to be rejected');
  assert.match(report.reason, reason);
}

function problemsOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CollectError, `expected a CollectError, got ${String(error)}`);
    return error.problems.join('\n');
  }
  return assert.fail('expected a CollectError');
}

// ---------------------------------------------------------------- Playwright JSON

describe('Playwright JSON', () => {
  test('mixed run: flaky is counted separately, never as a pass', () => {
    const report = complete(parsePlaywrightJson(read('playwright/mixed.json')));
    assert.deepEqual(report.counts, {
      passed: 1,
      failed: 1,
      flaky: 1,
      skipped: 1,
      todo: null,
      cancelled: null,
      total: 4,
    });
    assert.equal(report.toolFailed, true);
    const pw = report.playwright;
    assert.ok(pw);
    assert.deepEqual(pw.results.map((r) => [r.status, r.attempts]).sort(), [
      ['failed', 2],
      ['flaky', 2],
      ['passed', 1],
      ['skipped', 1],
    ]);
    assert.equal(pw.failOnFlakyTests, false);
    assert.equal(pw.version, '1.63.0');
  });

  test('a file that fails to load: zero tests, global errors, and a failed suite', () => {
    const report = complete(parsePlaywrightJson(read('playwright/import-error.json')));
    assert.equal(report.counts.total, 0);
    assert.equal(report.playwright?.globalErrors, 2);
    assert.equal(report.toolFailed, true, 'zero tests with errors is never a pass');
  });

  test('the repository suite: every committed instance has a result', () => {
    const report = complete(parsePlaywrightJson(read('playwright/repository-pass.json')));
    const snapshot = snapshotReference(json('snapshot/dashboard-data.json'));
    assert.equal(report.toolFailed, false);
    assert.equal(report.counts.total, report.counts.passed);
    assert.equal(report.playwright?.results.length, snapshot.instances.size);
  });

  test('flaky with failOnFlakyTests set counts as a tool failure (derived)', () => {
    const derived = json('playwright/mixed.json');
    (derived['config'] as Record<string, unknown>)['failOnFlakyTests'] = true;
    const withoutFailures = dropTests(derived, ['unexpected']);
    const report = complete(parsePlaywrightJson(JSON.stringify(withoutFailures)));
    assert.equal(report.counts.failed, 0);
    assert.equal(report.counts.flaky, 1);
    assert.equal(report.toolFailed, true);
  });

  const variants: [string, (r: Record<string, unknown>) => void, RegExp][] = [
    [
      'stats that disagree with the tests',
      (r) => ((r['stats'] as Record<string, number>)['expected'] = 9),
      /inconsistent/,
    ],
    [
      'an interrupted attempt',
      (r) =>
        (firstTest(r)['results'] as Record<string, unknown>[]).push({
          status: 'interrupted',
          retry: 2,
        }),
      /interrupted/,
    ],
    [
      'an expected failure (test.fail)',
      (r) => (firstTest(r)['expectedStatus'] = 'failed'),
      /unsupported expected status/,
    ],
    [
      'a duplicate test',
      (r) => firstSpec(r)['tests'] && (firstSpec(r)['tests'] as unknown[]).push(firstTest(r)),
      /duplicate/,
    ],
    [
      'a missing version',
      (r) => delete (r['config'] as Record<string, unknown>)['version'],
      /config.version/,
    ],
  ];
  for (const [name, mutate, reason] of variants) {
    test(`rejects ${name} (derived)`, () => {
      const derived = json('playwright/mixed.json');
      mutate(derived);
      rejected(parsePlaywrightJson(JSON.stringify(derived)), reason);
    });
  }

  test('rejects truncated JSON', () => {
    const text = read('playwright/mixed.json');
    rejected(parsePlaywrightJson(text.slice(0, text.length / 2)), /not valid JSON/);
  });
});

function firstSpec(report: Record<string, unknown>): Record<string, unknown> {
  const walk = (suite: Record<string, unknown>): Record<string, unknown> | undefined => {
    const specs = suite['specs'] as Record<string, unknown>[] | undefined;
    if (specs && specs.length > 0) return specs[0];
    for (const child of (suite['suites'] as Record<string, unknown>[] | undefined) ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  const spec = (report['suites'] as Record<string, unknown>[]).map(walk).find(Boolean);
  assert.ok(spec);
  return spec;
}

function firstTest(report: Record<string, unknown>): Record<string, unknown> {
  const tests = firstSpec(report)['tests'] as Record<string, unknown>[];
  assert.ok(tests[0]);
  return tests[0];
}

/** Removes tests with the given statuses and adjusts stats accordingly. */
function dropTests(report: Record<string, unknown>, statuses: string[]): Record<string, unknown> {
  const stats = report['stats'] as Record<string, number>;
  const prune = (suite: Record<string, unknown>): void => {
    for (const spec of (suite['specs'] as Record<string, unknown>[] | undefined) ?? []) {
      const tests = spec['tests'] as Record<string, unknown>[];
      for (const t of tests.filter((x) => statuses.includes(String(x['status'])))) {
        stats[String(t['status'])] = (stats[String(t['status'])] ?? 0) - 1;
      }
      spec['tests'] = tests.filter((x) => !statuses.includes(String(x['status'])));
    }
    for (const child of (suite['suites'] as Record<string, unknown>[] | undefined) ?? [])
      prune(child);
  };
  for (const suite of report['suites'] as Record<string, unknown>[]) prune(suite);
  return report;
}

// ---------------------------------------------------------------- Node TAP

describe('Node TAP', () => {
  test('mixed run: only the authoritative top-level summary is counted', () => {
    const text = read('tap/mixed.tap');
    const report = complete(parseNodeTap(text));
    assert.deepEqual(report.counts, {
      passed: 3,
      failed: 1,
      flaky: null,
      skipped: 1,
      todo: 1,
      cancelled: 2,
      total: 8,
    });
    assert.equal(report.toolFailed, true);
    const allResultLines = text
      .split('\n')
      .filter((line) => /^\s*(not )?ok \d+ /.test(line)).length;
    assert.notEqual(allResultLines, report.counts.total, 'nested result lines are not counted');
  });

  test("a test's own output that looks like a summary is escaped and ignored", () => {
    const text = read('tap/mixed.tap');
    assert.match(text, /^# \\# tests 999$/m);
    assert.equal(complete(parseNodeTap(text)).counts.total, 8);
  });

  test('the repository suite', () => {
    const report = complete(parseNodeTap(read('tap/repository-pass.tap')));
    assert.equal(report.toolFailed, false);
    assert.equal(report.counts.passed, report.counts.total);
  });

  test('indented summary-like lines in nested output do not change the result (derived)', () => {
    const lines = read('tap/repository-pass.tap').split('\n');
    lines.splice(2, 0, '    # tests 999', '    # pass 999');
    const original = complete(parseNodeTap(read('tap/repository-pass.tap')));
    assert.deepEqual(complete(parseNodeTap(lines.join('\n'))).counts, original.counts);
  });

  const summaryIndex = (lines: string[]): number => lines.findIndex((l) => /^# tests \d+$/.test(l));
  const variants: [string, (lines: string[]) => string[], RegExp][] = [
    [
      'a truncated stream (no summary)',
      (l) => l.slice(0, summaryIndex(l)),
      /summary missing|truncated/,
    ],
    ['a stream cut before the plan', (l) => l.slice(0, summaryIndex(l) - 1), /no top-level plan/],
    [
      'a duplicate summary block',
      (l) => [...l, ...l.slice(summaryIndex(l))],
      /truncated or followed|summary line/,
    ],
    [
      'a summary-like line before the plan',
      (l) => {
        const copy = [...l];
        copy.splice(2, 0, '# tests 5');
        return copy;
      },
      /ambiguous/,
    ],
    [
      'two top-level plans',
      (l) => [...l.slice(0, summaryIndex(l) - 1), '1..1', ...l.slice(summaryIndex(l) - 1)],
      /more than one top-level plan/,
    ],
    [
      'inconsistent arithmetic',
      (l) => l.map((x) => (x === '# pass 3' ? '# pass 4' : x)),
      /inconsistent summary/,
    ],
    ['output after the summary', (l) => [...l, 'extra'], /followed by other output/],
    ['a missing TAP header', (l) => l.slice(1), /not a TAP version 13 stream/],
    [
      'a missing top-level result',
      (l) => l.filter((x) => !x.startsWith('ok 2 ')),
      /do not match the plan/,
    ],
  ];
  for (const [name, mutate, reason] of variants) {
    test(`rejects ${name} (derived)`, () => {
      rejected(parseNodeTap(mutate(read('tap/mixed.tap').split('\n')).join('\n')), reason);
    });
  }
});

// ---------------------------------------------------------------- Vitest JSON

describe('Vitest JSON', () => {
  test('mixed run', () => {
    const report = complete(parseVitestJson(read('vitest/mixed.json')));
    assert.deepEqual(report.counts, {
      passed: 1,
      failed: 1,
      flaky: null,
      skipped: 1,
      todo: 1,
      cancelled: null,
      total: 4,
    });
    assert.equal(report.toolFailed, true);
  });

  test('a file that fails to load: zero tests, and a failed suite', () => {
    const report = complete(parseVitestJson(read('vitest/import-error.json')));
    assert.equal(report.counts.total, 0);
    assert.equal(report.toolFailed, true);
  });

  test('the repository suite', () => {
    const report = complete(parseVitestJson(read('vitest/repository-pass.json')));
    assert.equal(report.toolFailed, false);
    assert.equal(report.counts.passed, report.counts.total);
  });

  test('rejects inconsistent totals and success with failures (derived)', () => {
    const totals = json('vitest/mixed.json');
    totals['numTotalTests'] = 5;
    rejected(parseVitestJson(JSON.stringify(totals)), /≠ total/);
    const success = json('vitest/mixed.json');
    success['success'] = true;
    rejected(parseVitestJson(JSON.stringify(success)), /success with failed/);
    rejected(parseVitestJson('{"numTotalTests": 1}'), /missing/);
  });
});

// ---------------------------------------------------------------- suite state

describe('suite state', () => {
  const present = (path: string): ReportInput => ({ kind: 'present', text: read(path) });
  const missing: ReportInput = { kind: 'missing' };

  test('missing results: not-run when skipped, incomplete when the step ran; never zero', () => {
    assert.equal(suiteFor('agents', 'skipped', missing).suite.state, 'not-run');
    for (const outcome of ['failure', 'cancelled'] as const) {
      const { suite } = suiteFor('agents', outcome, missing);
      assert.equal(suite.state, 'incomplete');
      assert.equal(suite.counts, null);
    }
  });

  test('unreadable results: incomplete with null counts when the step failed or was cancelled', () => {
    const truncated: ReportInput = {
      kind: 'present',
      text: read('tap/mixed.tap').split('# tests')[0] ?? '',
    };
    const { suite } = suiteFor('agents', 'failure', truncated);
    assert.equal(suite.state, 'incomplete');
    assert.equal(suite.counts, null);
  });

  test('a cancelled step is incomplete even if its report looks complete', () => {
    assert.equal(
      suiteFor('playwright', 'cancelled', present('playwright/mixed.json')).suite.state,
      'incomplete',
    );
  });

  test('a completed report gives passed, flaky or failed', () => {
    assert.equal(
      suiteFor('dashboard-data', 'success', present('tap/repository-pass.tap')).suite.state,
      'passed',
    );
    assert.equal(
      suiteFor('playwright', 'failure', present('playwright/mixed.json')).suite.state,
      'failed',
    );
    const flakyOnly = dropTests(json('playwright/mixed.json'), ['unexpected']);
    const { suite } = suiteFor('playwright', 'success', {
      kind: 'present',
      text: JSON.stringify(flakyOnly),
    });
    assert.equal(suite.state, 'flaky');
    assert.ok(suite.counts);
    assert.equal(suite.counts.flaky, 1);
    assert.equal(suite.counts.passed, 1, 'the flaky test is not counted as passed');
  });

  const contradictions: [string, SuiteId, StepConclusion, ReportInput, RegExp][] = [
    ['success without a report', 'agents', 'success', missing, /wrote no report/],
    [
      'success with an unusable report',
      'agents',
      'success',
      { kind: 'present', text: 'garbage' },
      /unusable/,
    ],
    [
      'a skipped step with a report',
      'agents',
      'skipped',
      present('tap/repository-pass.tap'),
      /stale report/,
    ],
    [
      'success with failures in the report',
      'playwright',
      'success',
      present('playwright/mixed.json'),
      /succeeded but its report says the suite failed/,
    ],
    [
      'failure with a clean report',
      'dashboard-data',
      'failure',
      present('tap/repository-pass.tap'),
      /failed but its report says the suite passed/,
    ],
  ];
  for (const [name, id, outcome, report, reason] of contradictions) {
    test(`contradiction is an error: ${name}`, () => {
      assert.match(
        problemsOf(() => suiteFor(id, outcome, report)),
        reason,
      );
    });
  }

  test('partial runs keep the suites that completed', () => {
    const results = collectSuites({
      outcomes: {
        agents: 'success',
        'dashboard-data': 'failure',
        'dashboard-frontend': 'skipped',
        playwright: 'skipped',
      },
      reports: {
        agents: present('tap/repository-pass.tap'),
        'dashboard-data': missing,
        'dashboard-frontend': missing,
        playwright: missing,
      },
      node: '22.23.3',
    });
    assert.deepEqual(
      results.suites.map((s) => [s.suite.id, s.suite.state, s.suite.counts === null]),
      [
        ['agents', 'passed', false],
        ['dashboard-data', 'incomplete', true],
        ['dashboard-frontend', 'not-run', true],
        ['playwright', 'not-run', true],
      ],
    );
    assert.equal(results.playwright, null);
  });
});

// ---------------------------------------------------------------- run record

const ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'LarysaK/AI-QA-AutomationFramework',
  GITHUB_WORKFLOW: 'CI',
  GITHUB_RUN_ID: '39144953322',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_RUN_NUMBER: '2',
  GITHUB_SHA: '11f78cdab0e2b4a4b2e92de4bcace444502de158',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
};

/** Run #2's jobs, with the job window moved to enclose the locally generated fixture reports (derived). */
function jobsAroundFixtures(): Record<string, unknown> {
  const jobs = json('github/jobs-39144953322-attempt-1.json');
  const job = (jobs['jobs'] as Record<string, unknown>[])[0];
  assert.ok(job);
  job['started_at'] = '2026-10-18T20:04:00Z';
  job['completed_at'] = '2026-10-18T20:10:00Z';
  return jobs;
}

function verifyJob(jobs: Record<string, unknown>): Record<string, unknown> {
  const job = (jobs['jobs'] as Record<string, unknown>[])[0];
  assert.ok(job);
  return job;
}

function setStep(jobs: Record<string, unknown>, name: string, conclusion: string): void {
  const step = (verifyJob(jobs)['steps'] as Record<string, unknown>[]).find(
    (s) => s['name'] === name,
  );
  assert.ok(step, name);
  step['conclusion'] = conclusion;
}

function passingSuites(): unknown {
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
  return collectSuites({ outcomes, reports, node: '22.23.3' });
}

function compose(
  overrides: {
    suiteResults?: unknown;
    run?: unknown;
    jobs?: unknown;
    env?: Record<string, string | undefined>;
  } = {},
): Record<string, unknown> {
  return composeRecord({
    suiteResults: 'suiteResults' in overrides ? overrides.suiteResults : passingSuites(),
    run: overrides.run ?? json('github/run-39144953322.json'),
    jobs: overrides.jobs ?? jobsAroundFixtures(),
    env: overrides.env ?? ENV,
    snapshot: snapshotReference(json('snapshot/dashboard-data.json')),
    safety: SAFETY,
  }) as Record<string, unknown>;
}

describe('run record', () => {
  test('a successful main run: valid, cross-checked, and deterministic', () => {
    const record = compose();
    assert.deepEqual(validateRecord(record), []);
    assert.equal(record['conclusion'], 'success');
    assert.equal(record['commitSha'], ENV.GITHUB_SHA);
    assert.deepEqual(record['run'], {
      id: 39144953322,
      attempt: 1,
      number: 2,
      url: 'https://github.com/LarysaK/AI-QA-AutomationFramework/actions/runs/39144953322',
    });
    const suites = record['suites'] as { id: string; state: string }[];
    assert.deepEqual(
      suites.map((s) => s.state),
      ['passed', 'passed', 'passed', 'passed'],
    );
    const steps = record['steps'] as { name: string }[];
    for (const name of Object.values(SUITE_STEPS))
      assert.ok(
        steps.some((s) => s.name === name),
        name,
      );
    assert.ok(!steps.some((s) => s.name === 'Set up job' || s.name.startsWith('Post ')));
    assert.equal(serializeRecord(compose()), serializeRecord(record));
  });

  test('copies nothing beyond the allowlisted fields', () => {
    const text = serializeRecord(compose());
    for (const leaked of [
      'display_title',
      'Merge pull request',
      'actor',
      '/home/runner',
      'fixture-src',
      'runner-host',
      'avatar',
      'stdout',
    ]) {
      assert.ok(!text.includes(leaked), `record contains "${leaked}"`);
    }
  });

  test('a timed-out job without suite results: completed steps kept, suites incomplete or not-run', () => {
    const jobs = jobsAroundFixtures();
    verifyJob(jobs)['conclusion'] = 'timed_out';
    setStep(jobs, 'Playwright tests', 'cancelled');
    setStep(jobs, 'Dashboard tests', 'skipped');
    const record = compose({ suiteResults: null, jobs });
    assert.equal(record['conclusion'], 'timed_out');
    assert.deepEqual(
      (record['suites'] as { id: string; state: string; counts: unknown }[]).map((s) => [
        s.id,
        s.state,
        s.counts,
      ]),
      [
        ['agents', 'incomplete', null],
        ['dashboard-data', 'incomplete', null],
        ['dashboard-frontend', 'not-run', null],
        ['playwright', 'incomplete', null],
      ],
    );
    assert.equal(record['playwright'], null);
  });

  test('a failed run keeps the counts of suites that completed', () => {
    const jobs = jobsAroundFixtures();
    verifyJob(jobs)['conclusion'] = 'failure';
    setStep(jobs, 'Dashboard data tests', 'failure');
    for (const name of [
      'Install dashboard dependencies',
      'Dashboard typecheck',
      'Dashboard lint',
      'Dashboard tests',
      'Dashboard build',
      'Playwright tests',
    ]) {
      setStep(jobs, name, 'skipped');
    }
    const suiteResults = collectSuites({
      outcomes: {
        agents: 'success',
        'dashboard-data': 'failure',
        'dashboard-frontend': 'skipped',
        playwright: 'skipped',
      },
      reports: {
        agents: { kind: 'present', text: read('tap/repository-pass.tap') },
        'dashboard-data': { kind: 'missing' },
        'dashboard-frontend': { kind: 'missing' },
        playwright: { kind: 'missing' },
      },
      node: '22.23.3',
    });
    const record = compose({ suiteResults, jobs });
    const suites = record['suites'] as {
      id: string;
      state: string;
      counts: { total: number } | null;
    }[];
    const [first] = suites;
    assert.ok(first?.counts);
    assert.equal(first.state, 'passed');
    assert.ok(first.counts.total > 0);
    assert.deepEqual(
      suites.slice(1).map((s) => s.state),
      ['incomplete', 'not-run', 'not-run'],
    );
  });

  const refusals: [string, () => Record<string, unknown>, RegExp][] = [
    [
      'a job still in progress',
      () => {
        const jobs = jobsAroundFixtures();
        verifyJob(jobs)['status'] = 'in_progress';
        return compose({ jobs });
      },
      /only completed jobs are recorded/,
    ],
    [
      'a queued job',
      () => {
        const jobs = jobsAroundFixtures();
        verifyJob(jobs)['status'] = 'queued';
        return compose({ jobs });
      },
      /only completed jobs are recorded/,
    ],
    [
      'a pull request run',
      () =>
        compose({
          env: { ...ENV, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' },
        }),
      /not recorded/,
    ],
    [
      'another branch',
      () => compose({ env: { ...ENV, GITHUB_REF: 'refs/heads/feature' } }),
      /not refs\/heads\/main/,
    ],
    [
      'a commit that is not the run head',
      () => compose({ env: { ...ENV, GITHUB_SHA: 'a'.repeat(40) } }),
      /head_sha does not match/,
    ],
    [
      'another attempt',
      () => compose({ env: { ...ENV, GITHUB_RUN_ATTEMPT: '2' } }),
      /attempt does not match/,
    ],
    [
      'another run',
      () => compose({ env: { ...ENV, GITHUB_RUN_ID: '1' } }),
      /id does not match|exactly one/,
    ],
    [
      'a missing environment variable',
      () => compose({ env: { ...ENV, GITHUB_SHA: undefined } }),
      /GITHUB_SHA is not set/,
    ],
    [
      'an unknown conclusion',
      () => {
        const jobs = jobsAroundFixtures();
        verifyJob(jobs)['conclusion'] = 'neutral';
        return compose({ jobs });
      },
      /not recordable/,
    ],
    [
      'a missing suite step (workflow drift)',
      () => {
        const jobs = jobsAroundFixtures();
        const job = verifyJob(jobs);
        job['steps'] = (job['steps'] as Record<string, unknown>[]).filter(
          (s) => s['name'] !== 'Dashboard tests',
        );
        return compose({ jobs });
      },
      /"Dashboard tests" \(suite dashboard-frontend\) is not in the job/,
    ],
    [
      'suite results that disagree with the job',
      () => {
        const jobs = jobsAroundFixtures();
        setStep(jobs, 'Playwright tests', 'failure');
        verifyJob(jobs)['conclusion'] = 'failure';
        return compose({ jobs });
      },
      /outcome "success" differs from the job's step conclusion "failure"/,
    ],
    [
      'success without suite results',
      () => compose({ suiteResults: null }),
      /a suite did not pass/,
    ],
    [
      'reports from outside the job (stale)',
      () => compose({ jobs: json('github/jobs-39144953322-attempt-1.json') }),
      /started outside the job/,
    ],
    [
      'a snapshot of another commit',
      () =>
        compose({
          env: { ...ENV },
          run: { ...json('github/run-39144953322.json') },
          jobs: jobsAroundFixtures(),
          suiteResults: withSnapshotMismatch(),
        }),
      /not a committed test instance|has no result|source.commit/,
    ],
    [
      'unsafe text from the API',
      () => {
        const jobs = jobsAroundFixtures();
        (verifyJob(jobs)['steps'] as Record<string, unknown>[]).push({
          name: 'Leak /Users/someone/secret',
          status: 'completed',
          conclusion: 'success',
          number: 30,
        });
        return compose({ jobs });
      },
      /not public-safe/,
    ],
  ];
  for (const [name, fn, reason] of refusals) {
    test(`refuses ${name}`, () => {
      assert.match(problemsOf(fn), reason);
    });
  }
});

/** Suite results whose Playwright results name an instance the snapshot does not have (derived). */
function withSnapshotMismatch(): unknown {
  const results = structuredClone(passingSuites()) as {
    playwright: { results: { instanceId: string }[] };
  };
  const first = results.playwright.results[0];
  assert.ok(first);
  first.instanceId = 'deadbeef-deadbeef';
  return results;
}

// ---------------------------------------------------------------- schema

describe('schema', () => {
  const base = (): Record<string, unknown> => structuredClone(compose());
  const mutations: [string, (r: Record<string, unknown>) => void, RegExp][] = [
    [
      'counts on an incomplete suite',
      (r) =>
        ((r['suites'] as Record<string, unknown>[])[0] = {
          id: 'agents',
          state: 'incomplete',
          counts: {
            passed: 0,
            failed: 0,
            flaky: null,
            skipped: 0,
            todo: 0,
            cancelled: 0,
            total: 0,
          },
          durationMs: null,
          startedAt: null,
        }),
      /counts/,
    ],
    [
      'zero-filled counts on a not-run suite',
      (r) =>
        ((r['suites'] as Record<string, unknown>[])[0] = {
          id: 'agents',
          state: 'not-run',
          counts: { passed: 0, failed: 0, flaky: 0, skipped: 0, todo: 0, cancelled: 0, total: 0 },
          durationMs: null,
          startedAt: null,
        }),
      /counts/,
    ],
    [
      'a passed suite without counts',
      (r) =>
        ((r['suites'] as Record<string, unknown>[])[0] = {
          id: 'agents',
          state: 'passed',
          counts: null,
          durationMs: 1,
          startedAt: null,
        }),
      /counts/,
    ],
    ['an in-progress status', (r) => (r['status'] = 'in_progress'), /status/],
    [
      'a pull request trigger',
      (r) => (r['trigger'] = { event: 'pull_request', ref: 'refs/heads/main' }),
      /trigger/,
    ],
    [
      'another ref',
      (r) => (r['trigger'] = { event: 'push', ref: 'refs/heads/feature' }),
      /trigger/,
    ],
    ['an unknown field', (r) => (r['note'] = 'x'), /additional properties/],
    ['three suites', (r) => (r['suites'] as unknown[]).pop(), /suites/],
  ];
  for (const [name, mutate, reason] of mutations) {
    test(`rejects ${name}`, () => {
      const record = base();
      mutate(record);
      const errors = validateRecord(record);
      assert.ok(
        errors.some((e) => reason.test(e)),
        errors.join('\n'),
      );
    });
  }
});

// ---------------------------------------------------------------- repository wiring

describe('repository wiring', () => {
  test('the workflow has the Verify job and every suite step the collector maps', () => {
    const workflow = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    assert.match(workflow, /^ {4}name: Verify$/m);
    for (const name of Object.values(SUITE_STEPS)) {
      assert.match(workflow, new RegExp(`^ {6}- name: ${name}$`, 'm'), name);
    }
  });

  test('the root package.json exposes ci:test and ci:collect', () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    assert.ok(scripts['ci:test']?.includes('reporting/ci/ci.test.ts'));
    assert.ok(scripts['ci:collect']?.includes('reporting/ci/cli.ts'));
  });
});

// ---------------------------------------------------------------- CLI

describe('CLI', () => {
  const cli = (
    args: string[],
    env: Record<string, string>,
  ): { status: number | null; stderr: string } => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(__dirname, 'cli.ts'), ...args],
      {
        cwd: REPO,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', ...env },
      },
    );
    return { status: result.status, stderr: result.stderr };
  };

  test('suites, then record: writes a valid record; a refused record writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-collect-'));
    dirs.push(dir);
    const reports = join(dir, 'reports');
    spawnSync('mkdir', ['-p', reports]);
    const sources: Record<SuiteId, string> = {
      agents: 'tap/repository-pass.tap',
      'dashboard-data': 'tap/repository-pass.tap',
      'dashboard-frontend': 'vitest/repository-pass.json',
      playwright: 'playwright/repository-pass.json',
    };
    for (const id of SUITE_IDS) writeFileSync(join(reports, REPORT_FILES[id]), read(sources[id]));
    writeFileSync(
      join(dir, 'outcomes.json'),
      JSON.stringify(Object.fromEntries(SUITE_IDS.map((id) => [id, 'success']))),
    );
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobsAroundFixtures()));
    const suites = cli(
      [
        'suites',
        '--reports',
        reports,
        '--outcomes',
        join(dir, 'outcomes.json'),
        '--out',
        join(dir, 'suites.json'),
      ],
      {},
    );
    assert.equal(suites.status, 0, suites.stderr);

    const recordArgs = (out: string) => [
      'record',
      '--suites',
      join(dir, 'suites.json'),
      '--run',
      join(FIXTURES, 'github/run-39144953322.json'),
      '--jobs',
      join(dir, 'jobs.json'),
      '--snapshot',
      join(FIXTURES, 'snapshot/dashboard-data.json'),
      '--out',
      out,
    ];
    const record = cli(recordArgs(join(dir, 'record.json')), ENV);
    assert.equal(record.status, 0, record.stderr);
    assert.deepEqual(
      validateRecord(JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'))),
      [],
    );

    const refused = cli(recordArgs(join(dir, 'refused.json')), {
      ...ENV,
      GITHUB_EVENT_NAME: 'pull_request',
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not recorded/);
    assert.equal(existsSync(join(dir, 'refused.json')), false);
  });
});
