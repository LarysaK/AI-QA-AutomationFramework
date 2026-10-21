import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  CollectError,
  collectSuites,
  composeRecord,
  OUTCOME_SUFFIXES,
  outcomesFrom,
  REPORT_FILES,
  type ReportInput,
  serializeRecord,
  snapshotReference,
  type StepConclusion,
  SUITE_IDS,
  SUITE_STEPS,
  suiteFor,
  type SuiteId,
  summarizeSuiteResults,
  validateRecord,
  validateSuiteResults,
} from './collect';
import { contextToEnvironment } from './context';
import './context.test';
import { RUN_2_CONTEXT } from './context.test';
import './handoff.test';
import './history.test';
import './workflows.test';
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

// ---------------------------------------------------------------- M3a: capture and collection

describe('suite state matrix (report × step outcome)', () => {
  const REPORTS: Record<string, ReportInput> = {
    missing: { kind: 'missing' },
    unreadable: { kind: 'present', text: read('tap/mixed.tap').split('# tests')[0] ?? '' },
    passing: { kind: 'present', text: read('tap/repository-pass.tap') },
    failing: { kind: 'present', text: read('tap/mixed.tap') },
  };
  // Expected state, or an error pattern for contradictions.
  const EXPECTED: Record<string, Record<StepConclusion, string | RegExp>> = {
    missing: {
      success: /wrote no report/,
      failure: 'incomplete',
      cancelled: 'incomplete',
      skipped: 'not-run',
    },
    unreadable: {
      success: /unusable/,
      failure: 'incomplete',
      cancelled: 'incomplete',
      skipped: /stale report/,
    },
    passing: {
      success: 'passed',
      failure: /failed but its report says the suite passed/,
      cancelled: 'incomplete',
      skipped: /stale report/,
    },
    failing: {
      success: /succeeded but its report says the suite failed/,
      failure: 'failed',
      cancelled: 'incomplete',
      skipped: /stale report/,
    },
  };
  for (const [kind, byOutcome] of Object.entries(EXPECTED)) {
    for (const [outcome, expected] of Object.entries(byOutcome) as [
      StepConclusion,
      string | RegExp,
    ][]) {
      test(`${kind} report, ${outcome} step → ${String(expected)}`, () => {
        const report = REPORTS[kind];
        assert.ok(report);
        if (expected instanceof RegExp) {
          assert.match(
            problemsOf(() => suiteFor('agents', outcome, report)),
            expected,
          );
          return;
        }
        const { suite } = suiteFor('agents', outcome, report);
        assert.equal(suite.state, expected);
        if (expected === 'incomplete' || expected === 'not-run') {
          assert.equal(suite.counts, null, 'never zero-filled');
          assert.equal(suite.durationMs, null);
        } else {
          assert.ok(suite.counts && suite.counts.total > 0, 'real counts are kept');
        }
      });
    }
  }
});

describe('step outcomes from the environment', () => {
  const env = (
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> => ({
    CI_OUTCOME_AGENTS: 'success',
    CI_OUTCOME_DASHBOARD_DATA: 'failure',
    CI_OUTCOME_DASHBOARD_FRONTEND: 'skipped',
    CI_OUTCOME_PLAYWRIGHT: 'cancelled',
    ...overrides,
  });
  const key = (id: SuiteId): string => `CI_OUTCOME_${OUTCOME_SUFFIXES[id]}`;

  test('reads one variable per suite', () => {
    assert.deepEqual(outcomesFrom(env(), key), {
      agents: 'success',
      'dashboard-data': 'failure',
      'dashboard-frontend': 'skipped',
      playwright: 'cancelled',
    });
  });

  test('missing, empty or unknown values are errors, never defaults', () => {
    assert.match(
      problemsOf(() => outcomesFrom(env({ CI_OUTCOME_AGENTS: undefined }), key)),
      /CI_OUTCOME_AGENTS is not set/,
    );
    assert.match(
      problemsOf(() => outcomesFrom(env({ CI_OUTCOME_PLAYWRIGHT: '' }), key)),
      /CI_OUTCOME_PLAYWRIGHT is not set/,
    );
    assert.match(
      problemsOf(() => outcomesFrom(env({ CI_OUTCOME_DASHBOARD_DATA: 'neutral' }), key)),
      /"neutral"/,
    );
  });
});

describe('job summary', () => {
  test('counts only, with "—" for categories that were not reported or did not run', () => {
    const results = collectSuites({
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
    const summary = summarizeSuiteResults(results);
    const agents = complete(parseNodeTap(read('tap/repository-pass.tap'))).counts;
    assert.match(summary, /^### CI suite results$/m);
    assert.ok(
      summary.includes(
        `| Agent validation and generator tests | success | passed | ${String(agents.passed)} | 0 | — | 0 | 0 | 0 | ${String(agents.total)} |`,
      ),
      summary,
    );
    assert.ok(
      summary.includes(
        '| Dashboard data tests | failure | incomplete | — | — | — | — | — | — | — |',
      ),
      summary,
    );
    assert.ok(
      summary.includes('| Playwright tests | skipped | not-run | — | — | — | — | — | — | — |'),
      summary,
    );
    assert.doesNotMatch(summary, /\/home\/|fixture-src|\.ts:|Error:/);
  });

  test('includes Playwright global errors when the report has them', () => {
    const results = collectSuites({
      outcomes: {
        agents: 'skipped',
        'dashboard-data': 'skipped',
        'dashboard-frontend': 'skipped',
        playwright: 'failure',
      },
      reports: {
        agents: { kind: 'missing' },
        'dashboard-data': { kind: 'missing' },
        'dashboard-frontend': { kind: 'missing' },
        playwright: { kind: 'present', text: read('playwright/import-error.json') },
      },
      node: '22.23.3',
    });
    assert.match(summarizeSuiteResults(results), /Playwright global errors: 2/);
  });

  test('refuses invalid suite results', () => {
    assert.match(
      problemsOf(() => summarizeSuiteResults({ kind: 'suite-results' })),
      /suite results/,
    );
  });
});

// The workflow's own run scripts, extracted from ci.yml.
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');

function stepBlock(name: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {6}(- name:|# )/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

function runScript(name: string): string {
  const block = stepBlock(name).split('\n');
  const at = block.findIndex((line) => /^ {8}run: /.test(line));
  assert.ok(at >= 0, `step "${name}" has no run`);
  const first = block[at]?.replace(/^ {8}run: /, '') ?? '';
  if (first !== '|') return first;
  return block
    .slice(at + 1)
    .filter((line) => line.startsWith('          ') || line === '')
    .map((line) => line.slice(10))
    .join('\n')
    .trim();
}

/** GitHub's `shell: bash` (bash --noprofile --norc -eo pipefail {0}) and its default shell (bash -e {0}). */
function bash(script: string, cwd: string, env: Record<string, string> = {}, defaultShell = false) {
  const args = defaultShell
    ? ['-e', '-c', script]
    : ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script];
  return spawnSync('bash', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
}

describe('workflow capture steps', () => {
  test('the suite steps have stable IDs; only the collect step may continue on error', () => {
    for (const [name, id] of [
      ['Agent validation and generator tests', 'agents'],
      ['Dashboard data tests', 'dashboard_data'],
      ['Dashboard tests', 'frontend'],
      ['Playwright tests', 'playwright'],
      ['Collect suite results', 'collect'],
    ]) {
      assert.match(stepBlock(name ?? ''), new RegExp(`^ {8}id: ${id ?? ''}$`, 'm'), name);
    }
    assert.equal(WORKFLOW.match(/continue-on-error:/g)?.length, 1);
    assert.match(stepBlock('Collect suite results'), /^ {8}continue-on-error: true$/m);
    assert.match(stepBlock('Collect suite results'), /^ {8}if: always\(\)$/m);
  });

  test('a fresh report folder is prepared before any suite runs', () => {
    assert.equal(
      runScript('Prepare CI report folder'),
      'rm -rf artifacts/ci\nmkdir -p artifacts/ci',
    );
    assert.ok(
      WORKFLOW.indexOf('- name: Prepare CI report folder') <
        WORKFLOW.indexOf('- name: Agent validation and generator tests'),
    );
  });

  test('TAP steps keep failures with pipefail, and still save the report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-capture-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'artifacts/ci'), { recursive: true });
    for (const [name, command, file] of [
      ['Agent validation and generator tests', 'npm run --silent agents:test', 'agents.tap'],
      ['Dashboard data tests', 'npm run --silent dashboard:test', 'dashboard-data.tap'],
    ] as const) {
      const script = runScript(name);
      assert.ok(script.includes(`${command} | tee artifacts/ci/${file}`), script);
      assert.match(stepBlock(name), /^ {8}shell: bash$/m);
      const failing = script.replace(
        command,
        `node -e "process.stdout.write('TAP version 13\\n'); process.exit(3)"`,
      );
      const passing = script.replace(
        command,
        `node -e "process.stdout.write('TAP version 13\\n')"`,
      );
      for (const defaultShell of [false, true]) {
        assert.notEqual(
          bash(failing, dir, {}, defaultShell).status,
          0,
          `${name} must fail when the tests fail`,
        );
        assert.equal(readFileSync(join(dir, 'artifacts/ci', file), 'utf8'), 'TAP version 13\n');
        assert.equal(bash(passing, dir, {}, defaultShell).status, 0);
      }
      // Without pipefail the same pipeline would hide the failure, which is why the step sets it.
      assert.equal(bash(failing.replace('set -o pipefail\n', ''), dir, {}, true).status, 0);
    }
  });

  test("npm's script banner would corrupt the TAP stream, so the piped steps run npm --silent", () => {
    const withBanner = `\n> ai-qa-automation@0.1.0 agents:test\n> tsx --test x.test.ts\n\n${read('tap/repository-pass.tap')}`;
    rejected(parseNodeTap(withBanner), /not a TAP version 13 stream/);
    for (const name of ['Agent validation and generator tests', 'Dashboard data tests']) {
      assert.match(runScript(name), /^npm run --silent \S+ \| tee /m, name);
    }
  });

  test('the Vitest step keeps its console reporter and writes the JSON report', () => {
    const script = runScript('Dashboard tests');
    assert.match(
      script,
      /--reporter=default --reporter=json --outputFile\.json="\$GITHUB_WORKSPACE\/artifacts\/ci\/dashboard-frontend\.vitest\.json"/,
    );
  });

  test('no expressions in scripts; outcomes arrive through env; no downloads or new permissions', () => {
    const names = WORKFLOW.split('\n').flatMap(
      (line) => /^ {6}- name: (.+)$/.exec(line)?.[1] ?? [],
    );
    const scripts = names.filter((name) => /^ {8}run: /m.test(stepBlock(name))).map(runScript);
    assert.ok(scripts.length >= 18, String(scripts.length));
    assert.ok(
      scripts.every((script) => !script.includes('${{')),
      'no ${{ }} inside run scripts',
    );
    const collect = stepBlock('Collect suite results');
    for (const [variable, id] of [
      ['CI_OUTCOME_AGENTS', 'agents'],
      ['CI_OUTCOME_DASHBOARD_DATA', 'dashboard_data'],
      ['CI_OUTCOME_DASHBOARD_FRONTEND', 'frontend'],
      ['CI_OUTCOME_PLAYWRIGHT', 'playwright'],
    ]) {
      assert.ok(
        collect.includes(`          ${variable ?? ''}: \${{ steps.${id ?? ''}.outcome }}`),
        variable,
      );
    }
    const code = WORKFLOW.split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    // The two hand-off uploads (M3c) are checked exactly in workflows.test.ts.
    assert.doesNotMatch(code, /download-artifact|secrets\.|pull_request_target|:\s*write/);
    assert.match(code, /^permissions: \{\}$/m);
    assert.match(code, /^ {4}permissions:\n {6}contents: read$/m);
  });
});

describe('workflow collect step (executed)', () => {
  const COLLECT = runScript('Collect suite results').replaceAll(
    'npm run -s ci:collect --',
    `${join(REPO, 'node_modules/.bin/tsx')} ${join(__dirname, 'cli.ts')}`,
  );
  const SOURCES: Record<SuiteId, string> = {
    agents: 'tap/repository-pass.tap',
    'dashboard-data': 'tap/repository-pass.tap',
    'dashboard-frontend': 'vitest/repository-pass.json',
    playwright: 'playwright/repository-pass.json',
  };

  function workspace(present: SuiteId[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-collect-step-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'artifacts/ci'), { recursive: true });
    for (const id of present) {
      if (id === 'playwright') {
        mkdirSync(join(dir, 'artifacts/results'), { recursive: true });
        writeFileSync(join(dir, 'artifacts/results/results.json'), read(SOURCES[id]));
      } else {
        writeFileSync(join(dir, 'artifacts/ci', REPORT_FILES[id]), read(SOURCES[id]));
      }
    }
    writeFileSync(join(dir, 'summary.md'), '');
    return dir;
  }

  const run = (dir: string, outcomes: Record<SuiteId, string>) =>
    bash(COLLECT, dir, {
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      ...Object.fromEntries(
        SUITE_IDS.map((id) => [`CI_OUTCOME_${OUTCOME_SUFFIXES[id]}`, outcomes[id]]),
      ),
    });

  test('all suites passed: copies the Playwright report, writes suite results and a summary', () => {
    const dir = workspace([...SUITE_IDS]);
    const result = run(dir, {
      agents: 'success',
      'dashboard-data': 'success',
      'dashboard-frontend': 'success',
      playwright: 'success',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(dir, 'artifacts/ci/playwright.json')));
    const results: unknown = JSON.parse(
      readFileSync(join(dir, 'artifacts/ci/suite-results.json'), 'utf8'),
    );
    assert.deepEqual(validateSuiteResults(results), []);
    assert.match(
      readFileSync(join(dir, 'summary.md'), 'utf8'),
      /\| Playwright tests \| success \| passed \|/,
    );
  });

  test('a failed suite: completed suites keep their counts, missing reports are incomplete, later suites not-run', () => {
    const dir = workspace(['agents']);
    const result = run(dir, {
      agents: 'success',
      'dashboard-data': 'failure',
      'dashboard-frontend': 'skipped',
      playwright: 'skipped',
    });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(
      readFileSync(join(dir, 'artifacts/ci/suite-results.json'), 'utf8'),
    ) as {
      suites: { suite: { id: string; state: string; counts: { total: number } | null } }[];
    };
    assert.deepEqual(
      results.suites.map((s) => [s.suite.id, s.suite.state, s.suite.counts === null]),
      [
        ['agents', 'passed', false],
        ['dashboard-data', 'incomplete', true],
        ['dashboard-frontend', 'not-run', true],
        ['playwright', 'not-run', true],
      ],
    );
    assert.ok((results.suites[0]?.suite.counts?.total ?? 0) > 0);
  });

  test('a contradiction fails only this step and says so in the summary; nothing is written', () => {
    const dir = workspace([]);
    const result = run(dir, {
      agents: 'success',
      'dashboard-data': 'success',
      'dashboard-frontend': 'success',
      playwright: 'success',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wrote no report/);
    assert.equal(existsSync(join(dir, 'artifacts/ci/suite-results.json')), false);
    assert.match(
      readFileSync(join(dir, 'summary.md'), 'utf8'),
      /Not available: the collector could not produce trustworthy suite results/,
    );
  });

  test('a missing step outcome is an error, not a default', () => {
    const dir = workspace([...SUITE_IDS]);
    const result = run(dir, {
      agents: 'success',
      'dashboard-data': 'success',
      'dashboard-frontend': 'success',
      playwright: '',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CI_OUTCOME_PLAYWRIGHT is not set/);
  });
});

// ---------------------------------------------------------------- M3b: explicit run context

describe('run record from an explicit run context', () => {
  test('the context gives exactly the record the runner environment gives', () => {
    assert.equal(
      serializeRecord(compose({ env: contextToEnvironment(RUN_2_CONTEXT) })),
      serializeRecord(compose()),
    );
  });

  test('the context is cross-checked against the API like the environment', () => {
    assert.match(
      problemsOf(() => compose({ env: contextToEnvironment({ ...RUN_2_CONTEXT, runAttempt: 2 }) })),
      /attempt does not match/,
    );
    assert.match(
      problemsOf(() =>
        compose({ env: contextToEnvironment({ ...RUN_2_CONTEXT, headSha: 'a'.repeat(40) }) }),
      ),
      /head_sha does not match/,
    );
    assert.match(
      problemsOf(() =>
        compose({ env: contextToEnvironment({ ...RUN_2_CONTEXT, event: 'pull_request' }) }),
      ),
      /not recorded/,
    );
  });

  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync(join(REPO, 'node_modules/.bin/tsx'), [join(__dirname, 'cli.ts'), ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', ...env },
    });

  test('CLI: --context replaces the process environment entirely; it is never merged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-context-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'suites.json'), serializeRecord(passingSuites()));
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobsAroundFixtures()));
    writeFileSync(join(dir, 'context.json'), JSON.stringify(RUN_2_CONTEXT));
    const args = (out: string, context: boolean): string[] => [
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
      ...(context ? ['--context', join(dir, 'context.json')] : []),
    ];
    // A conflicting environment, like a later workflow's own GITHUB_* variables.
    const conflicting = {
      ...ENV,
      GITHUB_RUN_ID: '1',
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_SHA: 'b'.repeat(40),
    };
    const withContext = cli(args(join(dir, 'with.json'), true), conflicting);
    assert.equal(withContext.status, 0, withContext.stderr);
    assert.equal(readFileSync(join(dir, 'with.json'), 'utf8'), serializeRecord(compose()));
    const withoutContext = cli(args(join(dir, 'without.json'), false), conflicting);
    assert.equal(withoutContext.status, 1);
    assert.equal(existsSync(join(dir, 'without.json')), false);
    writeFileSync(
      join(dir, 'bad-context.json'),
      JSON.stringify({ ...RUN_2_CONTEXT, serverUrl: 'http://github.com' }),
    );
    const badContext = cli(
      [...args(join(dir, 'bad.json'), false), '--context', join(dir, 'bad-context.json')],
      ENV,
    );
    assert.equal(badContext.status, 1);
    assert.match(badContext.stderr, /serverUrl must be https:\/\/github\.com/);
    assert.equal(existsSync(join(dir, 'bad.json')), false);
  });

  test('CLI: context mode derives the context from a workflow_run event; refuses a fork and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-context-event-'));
    dirs.push(dir);
    const event = join(FIXTURES, 'github/workflow-run-event-39144953322.json');
    const ok = cli(
      ['context', '--event', event, '--workflow', 'CI', '--out', join(dir, 'context.json')],
      {},
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')), RUN_2_CONTEXT);
    const fork = json('github/workflow-run-event-39144953322.json');
    (fork['workflow_run'] as Record<string, unknown>)['head_repository'] = {
      full_name: 'someone/AI-QA-AutomationFramework',
    };
    writeFileSync(join(dir, 'fork.json'), JSON.stringify(fork));
    const refused = cli(
      [
        'context',
        '--event',
        join(dir, 'fork.json'),
        '--workflow',
        'CI',
        '--out',
        join(dir, 'fork-context.json'),
      ],
      {},
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /a fork/);
    assert.equal(existsSync(join(dir, 'fork-context.json')), false);
  });
});
