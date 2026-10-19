import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

import { type PublicSafetyContext, publicSafetyFindings } from '../dashboard-data/sanitize';
import { validateSnapshot } from '../dashboard-data/validate';
import {
  type Counts,
  type ParsedReport,
  parseNodeTap,
  parsePlaywrightJson,
  parseVitestJson,
  type PlaywrightResult,
} from './reports';

/**
 * Turns the verification job's reports and GitHub Actions metadata into a CI run record
 * (run-record.schema.json). Pure: callers supply file contents, API responses and environment.
 * Nothing is guessed: contradictions are errors, missing data is null.
 */

export const SCHEMA_PATH = join(__dirname, 'run-record.schema.json');

export type SuiteId = 'agents' | 'dashboard-data' | 'dashboard-frontend' | 'playwright';
export type StepConclusion = 'success' | 'failure' | 'cancelled' | 'skipped';
export type SuiteState = 'passed' | 'flaky' | 'failed' | 'not-run' | 'incomplete';

export const SUITE_IDS: readonly SuiteId[] = [
  'agents',
  'dashboard-data',
  'dashboard-frontend',
  'playwright',
];

/** The workflow step that runs each suite (.github/workflows/ci.yml). */
export const SUITE_STEPS: Readonly<Record<SuiteId, string>> = {
  agents: 'Agent validation and generator tests',
  'dashboard-data': 'Dashboard data tests',
  'dashboard-frontend': 'Dashboard tests',
  playwright: 'Playwright tests',
};

/** Report file names inside the reports directory. */
export const REPORT_FILES: Readonly<Record<SuiteId, string>> = {
  agents: 'agents.tap',
  'dashboard-data': 'dashboard-data.tap',
  'dashboard-frontend': 'dashboard-frontend.vitest.json',
  playwright: 'playwright.json',
};

const PARSERS: Readonly<Record<SuiteId, (text: string) => ParsedReport>> = {
  agents: parseNodeTap,
  'dashboard-data': parseNodeTap,
  'dashboard-frontend': parseVitestJson,
  playwright: parsePlaywrightJson,
};

export const VERIFY_JOB = 'Verify';
/** Clock tolerance between the runner and the Actions API, for start-time checks. */
export const CLOCK_TOLERANCE_MS = 120_000;

export interface Suite {
  readonly id: SuiteId;
  readonly state: SuiteState;
  readonly counts: Counts | null;
  readonly durationMs: number | null;
  readonly startedAt: string | null;
}

export interface PlaywrightSection {
  readonly failOnFlakyTests: boolean;
  readonly globalErrors: number;
  readonly results: readonly PlaywrightResult[];
}

export interface SuiteResults {
  readonly schemaVersion: '1.0';
  readonly kind: 'suite-results';
  readonly node: string;
  readonly playwrightVersion: string | null;
  readonly suites: readonly { readonly outcome: StepConclusion; readonly suite: Suite }[];
  readonly playwright: PlaywrightSection | null;
}

export class CollectError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`CI run record cannot be produced:\n  ${problems.join('\n  ')}`);
    this.name = 'CollectError';
  }
}

// ---------------------------------------------------------------- schema

let validators: { record: ValidateFunction; suiteResults: ValidateFunction } | undefined;

function schema(): NonNullable<typeof validators> {
  if (validators === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    const document = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as { $id: string };
    ajv.addSchema(document);
    const record = ajv.getSchema(document.$id);
    const suiteResults = ajv.getSchema(`${document.$id}#/$defs/suiteResults`);
    if (!record || !suiteResults) throw new Error('run-record.schema.json could not be compiled');
    validators = { record, suiteResults };
  }
  return validators;
}

const messages = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).map((e) => `schema: ${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);

export function validateRecord(value: unknown): string[] {
  const { record } = schema();
  return record(value) ? [] : messages(record.errors);
}

export function validateSuiteResults(value: unknown): string[] {
  const { suiteResults } = schema();
  return suiteResults(value) ? [] : messages(suiteResults.errors);
}

// ---------------------------------------------------------------- suite state

export type ReportInput =
  { readonly kind: 'missing' } | { readonly kind: 'present'; readonly text: string };

/**
 * One suite's state from its step outcome and its report. Missing or unreadable results are
 * not-run (step skipped) or incomplete (step ran) with null counts; a report that contradicts its
 * step outcome is an error.
 */
export function suiteFor(
  id: SuiteId,
  outcome: StepConclusion,
  report: ReportInput,
): { suite: Suite; parsed: ParsedReport | null } {
  const empty = (state: 'not-run' | 'incomplete'): Suite => ({
    id,
    state,
    counts: null,
    durationMs: null,
    startedAt: null,
  });
  const contradiction = (detail: string): never => {
    throw new CollectError([`${id}: ${detail}`]);
  };

  if (report.kind === 'missing') {
    if (outcome === 'skipped') return { suite: empty('not-run'), parsed: null };
    if (outcome === 'success') contradiction('the step succeeded but wrote no report');
    return { suite: empty('incomplete'), parsed: null };
  }
  if (outcome === 'skipped')
    contradiction('the step was skipped but a report exists (stale report?)');

  const parsed = PARSERS[id](report.text);
  if (!parsed.ok) {
    if (outcome === 'success')
      contradiction(`the step succeeded but its report is unusable: ${parsed.reason}`);
    return { suite: empty('incomplete'), parsed };
  }
  if (outcome === 'cancelled') return { suite: empty('incomplete'), parsed };
  if (parsed.toolFailed !== (outcome === 'failure')) {
    contradiction(
      `the step ${outcome === 'failure' ? 'failed' : 'succeeded'} but its report says the suite ${parsed.toolFailed ? 'failed' : 'passed'}`,
    );
  }
  const state: SuiteState = parsed.toolFailed
    ? 'failed'
    : (parsed.counts.flaky ?? 0) > 0
      ? 'flaky'
      : 'passed';
  return {
    suite: {
      id,
      state,
      counts: parsed.counts,
      durationMs: parsed.durationMs,
      startedAt: parsed.startedAt,
    },
    parsed,
  };
}

/** The verification job's own summary of its suites (written at the end of that job). */
export function collectSuites(input: {
  readonly outcomes: Readonly<Record<SuiteId, StepConclusion>>;
  readonly reports: Readonly<Record<SuiteId, ReportInput>>;
  readonly node: string;
}): SuiteResults {
  const entries = SUITE_IDS.map((id) => ({
    id,
    ...suiteFor(id, input.outcomes[id], input.reports[id]),
  }));
  const playwrightReport = entries.find((e) => e.id === 'playwright')?.parsed;
  const playwrightSuite = entries.find((e) => e.id === 'playwright')?.suite;
  const section =
    playwrightReport?.ok === true &&
    playwrightReport.playwright !== undefined &&
    playwrightSuite !== undefined &&
    playwrightSuite.counts !== null
      ? {
          failOnFlakyTests: playwrightReport.playwright.failOnFlakyTests,
          globalErrors: playwrightReport.playwright.globalErrors,
          results: playwrightReport.playwright.results,
        }
      : null;
  const results: SuiteResults = {
    schemaVersion: '1.0',
    kind: 'suite-results',
    node: input.node,
    playwrightVersion:
      playwrightReport?.ok === true && playwrightReport.playwright
        ? playwrightReport.playwright.version
        : null,
    suites: entries.map((e) => ({ outcome: input.outcomes[e.id], suite: e.suite })),
    playwright: section,
  };
  const problems = validateSuiteResults(results);
  if (problems.length > 0) throw new CollectError(problems);
  return results;
}

/**
 * Step outcomes as the workflow passes them: one environment variable per suite, named
 * `<prefix><SUITE>` (for example CI_OUTCOME_AGENTS), set from `steps.<id>.outcome`. Missing or
 * unknown values are errors; nothing is assumed.
 */
export const OUTCOME_SUFFIXES: Readonly<Record<SuiteId, string>> = {
  agents: 'AGENTS',
  'dashboard-data': 'DASHBOARD_DATA',
  'dashboard-frontend': 'DASHBOARD_FRONTEND',
  playwright: 'PLAYWRIGHT',
};

const OUTCOMES: readonly StepConclusion[] = ['success', 'failure', 'cancelled', 'skipped'];

export function outcomesFrom(
  source: Readonly<Record<string, unknown>>,
  keyFor: (id: SuiteId) => string,
): Record<SuiteId, StepConclusion> {
  const problems: string[] = [];
  const outcomes = {} as Record<SuiteId, StepConclusion>;
  for (const id of SUITE_IDS) {
    const value = source[keyFor(id)];
    if (OUTCOMES.includes(value as StepConclusion)) outcomes[id] = value as StepConclusion;
    else {
      problems.push(
        `outcomes: ${keyFor(id)} is ${value === undefined || value === '' ? 'not set' : JSON.stringify(value)}; expected ${OUTCOMES.join(', ')}`,
      );
    }
  }
  if (problems.length > 0) throw new CollectError(problems);
  return outcomes;
}

/** A counts-only Markdown summary of validated suite results, for the job summary. */
export function summarizeSuiteResults(value: unknown): string {
  const problems = validateSuiteResults(value);
  if (problems.length > 0) throw new CollectError(['suite results:', ...problems]);
  const results = value as SuiteResults;
  const cell = (n: number | null | undefined): string =>
    n === null || n === undefined ? '—' : String(n);
  const rows = results.suites.map(({ outcome, suite }) => {
    const c = suite.counts;
    return `| ${SUITE_STEPS[suite.id]} | ${outcome} | ${suite.state} | ${cell(c?.passed)} | ${cell(c?.failed)} | ${cell(c?.flaky)} | ${cell(c?.skipped)} | ${cell(c?.todo)} | ${cell(c?.cancelled)} | ${cell(c?.total)} |`;
  });
  const lines = [
    '### CI suite results',
    '',
    '| Suite | Step outcome | State | Passed | Failed | Flaky | Skipped | Todo | Cancelled | Total |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ];
  if (results.playwright !== null) {
    lines.push(`Playwright global errors: ${String(results.playwright.globalErrors)}`, '');
  }
  lines.push(
    'Counts come from the machine-readable reports of this job. "—" means the tool does not report that category, or the suite did not run or did not complete.',
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- run record

/** The runner environment variables the record is cross-checked against. */
export interface RunnerEnvironment {
  readonly GITHUB_SERVER_URL: string;
  readonly GITHUB_REPOSITORY: string;
  readonly GITHUB_WORKFLOW: string;
  readonly GITHUB_RUN_ID: string;
  readonly GITHUB_RUN_ATTEMPT: string;
  readonly GITHUB_RUN_NUMBER: string;
  readonly GITHUB_SHA: string;
  readonly GITHUB_REF: string;
  readonly GITHUB_EVENT_NAME: string;
}

export const RUNNER_VARIABLES: readonly (keyof RunnerEnvironment)[] = [
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_WORKFLOW',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_EVENT_NAME',
];

/** The committed test inventory of the same commit: instance ID → projects. */
export interface SnapshotReference {
  readonly commit: string;
  readonly instances: ReadonlyMap<string, readonly string[]>;
}

export function snapshotReference(snapshot: unknown): SnapshotReference {
  const errors = validateSnapshot(snapshot);
  if (errors.length > 0) throw new CollectError(['dashboard snapshot is not valid', ...errors]);
  const valid = snapshot as {
    source: { commit: string };
    testInstances: { id: string; projects: string[] }[];
  };
  return {
    commit: valid.source.commit,
    instances: new Map(valid.testInstances.map((instance) => [instance.id, instance.projects])),
  };
}

interface ApiStep {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly number: number;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const RUN_CONCLUSIONS = ['success', 'failure', 'cancelled', 'timed_out'] as const;
const STEP_CONCLUSIONS: readonly StepConclusion[] = ['success', 'failure', 'cancelled', 'skipped'];
const RUNNER_STEPS = (name: string): boolean =>
  name === 'Set up job' || name === 'Complete job' || name.startsWith('Post ');

export function composeRecord(input: {
  readonly suiteResults: unknown;
  readonly run: unknown;
  readonly jobs: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly snapshot: SnapshotReference;
  readonly safety: PublicSafetyContext;
}): unknown {
  const problems: string[] = [];
  const check = (condition: boolean, problem: string): void => {
    if (!condition) problems.push(problem);
  };
  const fail = (): never => {
    throw new CollectError(problems);
  };

  // Runner environment.
  const env: Partial<Record<keyof RunnerEnvironment, string>> = {};
  for (const name of RUNNER_VARIABLES) {
    const value = input.env[name];
    if (value === undefined || value === '') problems.push(`environment: ${name} is not set`);
    else env[name] = value;
  }
  if (problems.length > 0) fail();
  const runId = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const number = Number(env.GITHUB_RUN_NUMBER);
  const url = `${env.GITHUB_SERVER_URL ?? ''}/${env.GITHUB_REPOSITORY ?? ''}/actions/runs/${String(runId)}`;

  // Only main-branch push or dispatch runs are recordable.
  check(
    env.GITHUB_EVENT_NAME === 'push' || env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    `trigger: "${env.GITHUB_EVENT_NAME ?? ''}" runs are not recorded (push and workflow_dispatch on main only)`,
  );
  check(
    env.GITHUB_REF === 'refs/heads/main',
    `trigger: ref "${env.GITHUB_REF ?? ''}" is not refs/heads/main`,
  );

  // The run, as reported by the Actions API, must be this run.
  const run = input.run;
  check(field(run, 'id') === runId, 'run: id does not match GITHUB_RUN_ID');
  check(field(run, 'run_attempt') === attempt, 'run: attempt does not match GITHUB_RUN_ATTEMPT');
  check(field(run, 'run_number') === number, 'run: number does not match GITHUB_RUN_NUMBER');
  check(field(run, 'head_sha') === env.GITHUB_SHA, 'run: head_sha does not match GITHUB_SHA');
  check(
    field(run, 'event') === env.GITHUB_EVENT_NAME,
    'run: event does not match GITHUB_EVENT_NAME',
  );
  check(field(run, 'head_branch') === 'main', 'run: head_branch is not main');
  check(
    field(run, 'name') === env.GITHUB_WORKFLOW,
    'run: workflow name does not match GITHUB_WORKFLOW',
  );
  check(
    field(field(run, 'repository'), 'full_name') === env.GITHUB_REPOSITORY,
    'run: repository does not match',
  );
  check(field(run, 'html_url') === url, 'run: html_url does not match the run URL');
  const runCreatedAt = field(run, 'created_at');
  check(typeof runCreatedAt === 'string', 'run: created_at is missing');

  // The verification job of this attempt must have completed.
  const allJobs = field(input.jobs, 'jobs');
  const jobs = Array.isArray(allJobs)
    ? allJobs.filter((j) => field(j, 'name') === VERIFY_JOB && field(j, 'run_id') === runId)
    : [];
  check(
    jobs.length === 1,
    `jobs: expected exactly one "${VERIFY_JOB}" job for this run, found ${String(jobs.length)}`,
  );
  if (problems.length > 0) fail();
  const job: unknown = jobs[0];
  check(field(job, 'run_attempt') === attempt, 'job: attempt does not match GITHUB_RUN_ATTEMPT');
  check(
    field(job, 'status') === 'completed',
    `job: status is "${String(field(job, 'status'))}"; only completed jobs are recorded`,
  );
  const conclusion = field(job, 'conclusion');
  check(
    (RUN_CONCLUSIONS as readonly unknown[]).includes(conclusion),
    `job: conclusion "${String(conclusion)}" is not recordable`,
  );
  const jobStartedAt = field(job, 'started_at');
  const jobCompletedAt = field(job, 'completed_at');
  check(
    typeof jobStartedAt === 'string' && typeof jobCompletedAt === 'string',
    'job: start or completion time is missing',
  );
  if (problems.length > 0) fail();

  const apiSteps = (
    Array.isArray(field(job, 'steps')) ? (field(job, 'steps') as unknown[]) : []
  ).map((s) => s as ApiStep);
  const steps = apiSteps
    .filter((s) => typeof s.name === 'string' && !RUNNER_STEPS(s.name))
    .sort((a, b) => a.number - b.number)
    .map((s) => {
      check(s.status === 'completed', `step "${s.name}" did not complete`);
      check(
        (STEP_CONCLUSIONS as readonly (string | null)[]).includes(s.conclusion),
        `step "${s.name}" has conclusion "${String(s.conclusion)}"`,
      );
      return { name: s.name, conclusion: s.conclusion as StepConclusion };
    });
  const stepConclusion = (name: string): StepConclusion | undefined =>
    steps.find((s) => s.name === name)?.conclusion;
  for (const id of SUITE_IDS) {
    check(
      stepConclusion(SUITE_STEPS[id]) !== undefined,
      `step "${SUITE_STEPS[id]}" (suite ${id}) is not in the job`,
    );
  }
  if (problems.length > 0) fail();

  // Suites: from the job's own results when present; otherwise only what the API knows.
  let suites: Suite[];
  let playwright: PlaywrightSection | null = null;
  let node: string | null = null;
  let playwrightVersion: string | null = null;
  if (input.suiteResults === null) {
    suites = SUITE_IDS.map((id) => ({
      id,
      state: stepConclusion(SUITE_STEPS[id]) === 'skipped' ? 'not-run' : 'incomplete',
      counts: null,
      durationMs: null,
      startedAt: null,
    }));
  } else {
    const schemaProblems = validateSuiteResults(input.suiteResults);
    if (schemaProblems.length > 0) throw new CollectError(['suite results:', ...schemaProblems]);
    const results = input.suiteResults as SuiteResults;
    const ids = results.suites.map((s) => s.suite.id);
    check(
      ids.length === SUITE_IDS.length && SUITE_IDS.every((id) => ids.includes(id)),
      'suite results: must contain each suite exactly once',
    );
    for (const { outcome, suite } of results.suites) {
      check(
        outcome === stepConclusion(SUITE_STEPS[suite.id]),
        `suite results: ${suite.id} outcome "${outcome}" differs from the job's step conclusion "${String(stepConclusion(SUITE_STEPS[suite.id]))}"`,
      );
    }
    suites = SUITE_IDS.flatMap((id) =>
      results.suites.filter((s) => s.suite.id === id).map((s) => s.suite),
    );
    playwright = results.playwright;
    node = results.node;
    playwrightVersion = results.playwrightVersion;
  }

  // Report start times must fall within the job.
  const from = Date.parse(String(jobStartedAt)) - CLOCK_TOLERANCE_MS;
  const to = Date.parse(String(jobCompletedAt)) + CLOCK_TOLERANCE_MS;
  for (const suite of suites) {
    if (suite.startedAt === null) continue;
    const at = Date.parse(suite.startedAt);
    check(at >= from && at <= to, `${suite.id}: report started outside the job (stale report?)`);
  }

  // The run conclusion and the suites must agree.
  if (conclusion === 'success') {
    check(
      suites.every((s) => s.state === 'passed' || s.state === 'flaky'),
      'conclusion "success" but a suite did not pass',
    );
    check(
      steps.every((s) => s.conclusion === 'success'),
      'conclusion "success" but a step did not succeed',
    );
  }
  if (conclusion === 'failure') {
    check(
      steps.some((s) => s.conclusion === 'failure'),
      'conclusion "failure" but no step failed',
    );
  }

  // Playwright results must be the committed inventory of the same commit.
  check(
    input.snapshot.commit === env.GITHUB_SHA,
    'snapshot: source.commit does not match GITHUB_SHA',
  );
  if (playwright !== null) {
    const reported = new Set(playwright.results.map((r) => `${r.instanceId} ${r.project}`));
    for (const r of playwright.results) {
      check(
        input.snapshot.instances.get(r.instanceId)?.includes(r.project) === true,
        `playwright: ${r.instanceId} (${r.project}) is not a committed test instance of this commit`,
      );
    }
    for (const [id, projects] of input.snapshot.instances) {
      for (const project of projects) {
        check(
          reported.has(`${id} ${project}`),
          `playwright: committed instance ${id} (${project}) has no result`,
        );
      }
    }
  }
  if (problems.length > 0) fail();

  const labels = field(job, 'labels');
  const record = {
    schemaVersion: '1.0',
    kind: 'ci-run',
    repository: env.GITHUB_REPOSITORY,
    workflow: env.GITHUB_WORKFLOW,
    job: VERIFY_JOB,
    run: { id: runId, attempt, number, url },
    trigger: { event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF },
    commitSha: env.GITHUB_SHA,
    status: 'completed',
    conclusion,
    timestamps: { runCreatedAt, jobStartedAt, jobCompletedAt },
    environment: {
      runnerLabel:
        Array.isArray(labels) && labels.length === 1 && typeof labels[0] === 'string'
          ? labels[0]
          : null,
      node,
      playwright: playwrightVersion,
    },
    steps,
    suites,
    playwright,
  };

  const schemaProblems = validateRecord(record);
  if (schemaProblems.length > 0) throw new CollectError(schemaProblems);
  const unsafe = publicSafetyFindings(record, input.safety);
  if (unsafe.length > 0) throw new CollectError(unsafe.map((f) => `not public-safe: ${f}`));
  return record;
}

export function serializeRecord(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
