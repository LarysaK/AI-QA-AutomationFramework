/**
 * Pure parsers for the machine-readable reports of the CI verification job. Each returns either a
 * complete, internally consistent result or a rejection with a reason. Only counts, statuses,
 * versions, start times and Playwright spec IDs are read; titles, messages, paths, stdout and
 * attachments are never copied. A category a tool does not report is null, never zero.
 */

export interface Counts {
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number | null;
  readonly skipped: number;
  readonly todo: number | null;
  readonly cancelled: number | null;
  readonly total: number;
}

export type PlaywrightStatus = 'passed' | 'failed' | 'flaky' | 'skipped';

export interface PlaywrightResult {
  readonly instanceId: string;
  readonly project: string;
  readonly status: PlaywrightStatus;
  readonly attempts: number;
}

export interface CompleteReport {
  readonly ok: true;
  readonly counts: Counts;
  /** True when the tool itself reports the suite as failed. */
  readonly toolFailed: boolean;
  readonly durationMs: number | null;
  readonly startedAt: string | null;
  readonly playwright?: {
    readonly version: string;
    readonly failOnFlakyTests: boolean;
    readonly globalErrors: number;
    readonly results: readonly PlaywrightResult[];
  };
}

export interface RejectedReport {
  readonly ok: false;
  readonly reason: string;
}

export type ParsedReport = CompleteReport | RejectedReport;

const reject = (reason: string): RejectedReport => ({ ok: false, reason });
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** The values of `keys` if every one is a whole, non-negative number; otherwise null. */
function countsOf(source: Record<string, unknown>, keys: readonly string[]): number[] | null {
  const values = keys.map((key) => source[key]);
  return values.every(isCount) ? values : null;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SPEC_ID = /^[0-9a-f]+-[0-9a-f]+$/;

// ---------------------------------------------------------------- Node test runner (TAP)

/** The summary Node's TAP reporter writes after the final top-level plan, in this order. */
const TAP_SUMMARY = [
  'tests',
  'suites',
  'pass',
  'fail',
  'cancelled',
  'skipped',
  'todo',
  'duration_ms',
];
const TOP_LEVEL_SUMMARY_LIKE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
const TOP_LEVEL_PLAN = /^1\.\.(\d+)$/;
const TOP_LEVEL_TEST = /^(not ok|ok) (\d+)( |$)/;

/**
 * Reads only the authoritative top-level summary. Nested subtests are indented and cannot match;
 * a test's own output is escaped by Node (`# \# tests 1`). Ambiguous, duplicate, truncated or
 * inconsistent output is rejected.
 */
export function parseNodeTap(text: string): ParsedReport {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== 'TAP version 13') return reject('not a TAP version 13 stream');

  const plans = lines.flatMap((line, i) => (TOP_LEVEL_PLAN.test(line) ? [i] : []));
  if (plans.length === 0) return reject('no top-level plan: the run did not finish');
  if (plans.length > 1) return reject('more than one top-level plan');
  const planIndex = plans[0] ?? 0;
  const planned = Number(TOP_LEVEL_PLAN.exec(lines[planIndex] ?? '')?.[1]);

  const tail = lines.slice(planIndex + 1);
  if (tail.length !== TAP_SUMMARY.length) {
    return reject('summary missing, truncated or followed by other output');
  }
  const values: Record<string, number> = {};
  for (const [i, key] of TAP_SUMMARY.entries()) {
    const match = new RegExp(`^# ${key} (\\d+(?:\\.\\d+)?)$`).exec(tail[i] ?? '');
    if (!match?.[1]) return reject(`summary line ${String(i + 1)} is not "# ${key} <number>"`);
    values[key] = Number(match[1]);
  }
  const summaryLike = lines.slice(0, planIndex).filter((line) => TOP_LEVEL_SUMMARY_LIKE.test(line));
  if (summaryLike.length > 0) return reject('ambiguous: top-level summary lines before the plan');

  const topLevel = lines.flatMap((line) => {
    const match = TOP_LEVEL_TEST.exec(line);
    return match ? [{ ok: match[1] === 'ok', number: Number(match[2]) }] : [];
  });
  if (topLevel.length !== planned || topLevel.some((t, i) => t.number !== i + 1)) {
    return reject(`top-level results do not match the plan 1..${String(planned)}`);
  }

  const tests = values['tests'] ?? -1;
  const pass = values['pass'] ?? -1;
  const fail = values['fail'] ?? -1;
  const cancelled = values['cancelled'] ?? -1;
  const skipped = values['skipped'] ?? -1;
  const todo = values['todo'] ?? -1;
  const counted = [tests, pass, fail, cancelled, skipped, todo];
  if (!counted.every(isCount)) return reject('summary counts are not whole numbers');
  if (pass + fail + cancelled + skipped + todo !== tests) {
    return reject('inconsistent summary: pass + fail + cancelled + skipped + todo ≠ tests');
  }
  const anyNotOk = topLevel.some((t) => !t.ok);
  if (anyNotOk !== fail + cancelled > 0) {
    return reject('inconsistent summary: failures do not match the top-level results');
  }
  return {
    ok: true,
    counts: { passed: pass, failed: fail, flaky: null, skipped, todo, cancelled, total: tests },
    toolFailed: fail + cancelled > 0,
    durationMs: Math.round(values['duration_ms'] ?? 0),
    startedAt: null,
  };
}

// ---------------------------------------------------------------- Playwright JSON

const PLAYWRIGHT_TEST_STATUS: Record<string, PlaywrightStatus | undefined> = {
  expected: 'passed',
  unexpected: 'failed',
  flaky: 'flaky',
  skipped: 'skipped',
};

export function parsePlaywrightJson(text: string): ParsedReport {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return reject('not valid JSON');
  }
  if (!isRecord(report) || !isRecord(report['stats']) || !isRecord(report['config'])) {
    return reject('not a Playwright JSON report');
  }
  const { stats, config } = report as {
    stats: Record<string, unknown>;
    config: Record<string, unknown>;
  };
  const errors = report['errors'];
  const suites = report['suites'];
  if (!Array.isArray(errors) || !Array.isArray(suites))
    return reject('report has no suites or errors');
  const statCounts = countsOf(stats, ['expected', 'unexpected', 'flaky', 'skipped']);
  if (statCounts === null) return reject('stats are not counts');
  const [expected = 0, unexpected = 0, flaky = 0, skipped = 0] = statCounts;
  const startTime = stats['startTime'];
  const duration = stats['duration'];
  if (typeof startTime !== 'string' || !INSTANT.test(startTime))
    return reject('stats.startTime is invalid');
  if (typeof duration !== 'number' || duration < 0) return reject('stats.duration is invalid');
  const version = config['version'];
  if (typeof version !== 'string' || !VERSION.test(version))
    return reject('config.version is invalid');

  const results: PlaywrightResult[] = [];
  const tally: Record<PlaywrightStatus, number> = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const seen = new Set<string>();
  const problems: string[] = [];
  const walk = (suite: unknown): void => {
    if (!isRecord(suite)) {
      problems.push('malformed suite');
      return;
    }
    for (const spec of Array.isArray(suite['specs']) ? suite['specs'] : []) {
      if (!isRecord(spec) || typeof spec['id'] !== 'string' || !SPEC_ID.test(spec['id'])) {
        problems.push('spec without a valid id');
        continue;
      }
      for (const test of Array.isArray(spec['tests']) ? spec['tests'] : []) {
        if (!isRecord(test)) {
          problems.push('malformed test');
          continue;
        }
        const project = test['projectName'];
        const status = PLAYWRIGHT_TEST_STATUS[String(test['status'])];
        const attempts = Array.isArray(test['results']) ? test['results'] : [];
        if (
          typeof project !== 'string' ||
          project === '' ||
          status === undefined ||
          attempts.length === 0
        ) {
          problems.push('test without project, known status or results');
          continue;
        }
        if (attempts.some((attempt) => isRecord(attempt) && attempt['status'] === 'interrupted')) {
          problems.push('interrupted');
          continue;
        }
        if (test['status'] === 'expected' && test['expectedStatus'] !== 'passed') {
          problems.push(`unsupported expected status "${String(test['expectedStatus'])}"`);
          continue;
        }
        const key = `${spec['id']} ${project}`;
        if (seen.has(key)) problems.push(`duplicate test ${key}`);
        seen.add(key);
        tally[status] += 1;
        results.push({ instanceId: spec['id'], project, status, attempts: attempts.length });
      }
    }
    for (const child of Array.isArray(suite['suites']) ? suite['suites'] : []) walk(child);
  };
  for (const suite of suites) walk(suite);
  if (problems.includes('interrupted')) return reject('the run was interrupted');
  if (problems.length > 0) return reject(problems[0] ?? 'malformed report');
  if (
    tally.passed !== expected ||
    tally.failed !== unexpected ||
    tally.flaky !== flaky ||
    tally.skipped !== skipped
  ) {
    return reject('inconsistent report: per-test statuses do not match stats');
  }
  const failOnFlakyTests = config['failOnFlakyTests'] === true;
  const total = expected + unexpected + flaky + skipped;
  return {
    ok: true,
    counts: {
      passed: expected,
      failed: unexpected,
      flaky,
      skipped,
      todo: null,
      cancelled: null,
      total,
    },
    toolFailed: unexpected > 0 || errors.length > 0 || (failOnFlakyTests && flaky > 0),
    durationMs: Math.round(duration),
    startedAt: startTime,
    playwright: {
      version,
      failOnFlakyTests,
      globalErrors: errors.length,
      results: [...results].sort((a, b) =>
        a.instanceId === b.instanceId
          ? a.project < b.project
            ? -1
            : 1
          : a.instanceId < b.instanceId
            ? -1
            : 1,
      ),
    },
  };
}

// ---------------------------------------------------------------- Vitest JSON

export function parseVitestJson(text: string): ParsedReport {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return reject('not valid JSON');
  }
  if (!isRecord(report)) return reject('not a Vitest JSON report');
  const numbers = countsOf(report, [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numFailedTestSuites',
  ]);
  if (numbers === null) return reject('test counts are missing or not whole numbers');
  const [total = 0, passed = 0, failed = 0, pending = 0, todo = 0, failedFiles = 0] = numbers;
  const success = report['success'];
  const startTime = report['startTime'];
  if (typeof success !== 'boolean') return reject('success flag is missing');
  if (typeof startTime !== 'number' || !Number.isFinite(startTime))
    return reject('startTime is invalid');
  if (passed + failed + pending + todo !== total) {
    return reject('inconsistent report: passed + failed + pending + todo ≠ total');
  }
  if (success && (failed > 0 || failedFiles > 0)) {
    return reject('inconsistent report: success with failed tests or files');
  }
  return {
    ok: true,
    counts: { passed, failed, flaky: null, skipped: pending, todo, cancelled: null, total },
    toolFailed: !success,
    durationMs: null,
    startedAt: new Date(startTime).toISOString(),
  };
}
