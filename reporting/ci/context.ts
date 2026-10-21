/**
 * The identity of the CI run a record describes, as an explicit, validated input. A later
 * workflow cannot impersonate the CI run's GITHUB_* variables, so it passes this context instead
 * (`ci:collect record --context <file>`); the record composer cross-checks it against the Actions
 * API exactly as it does the runner environment.
 *
 * Offline only: no network, no git. Values are format-checked before use.
 */

export interface RunContext {
  readonly schemaVersion: '1.0';
  readonly kind: 'ci-run-context';
  readonly serverUrl: string;
  readonly repository: string;
  readonly workflow: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly runNumber: number;
  readonly headSha: string;
  readonly ref: string;
  readonly event: string;
}

export class ContextError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`CI run context is not valid:\n  ${problems.join('\n  ')}`);
    this.name = 'ContextError';
    this.problems = problems;
  }
}

const SERVER_URL = 'https://github.com';
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW = /^[A-Za-z0-9 ._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
const EVENTS = ['push', 'workflow_dispatch', 'pull_request'];
const KEYS = [
  'schemaVersion',
  'kind',
  'serverUrl',
  'repository',
  'workflow',
  'runId',
  'runAttempt',
  'runNumber',
  'headSha',
  'ref',
  'event',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Validates a context object; unknown or missing fields and malformed values are errors. */
export function parseRunContext(value: unknown): RunContext {
  if (!isRecord(value)) throw new ContextError(['the context must be a JSON object']);
  const problems: string[] = [];
  const extra = Object.keys(value).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (extra.length > 0) problems.push(`unknown fields: ${extra.join(', ')}`);
  const text = (key: string, pattern: RegExp): void => {
    const field = value[key];
    if (typeof field !== 'string' || !pattern.test(field))
      problems.push(`${key} is missing or malformed`);
  };
  if (value['schemaVersion'] !== '1.0') problems.push('schemaVersion must be "1.0"');
  if (value['kind'] !== 'ci-run-context') problems.push('kind must be "ci-run-context"');
  if (value['serverUrl'] !== SERVER_URL) problems.push(`serverUrl must be ${SERVER_URL}`);
  text('repository', REPOSITORY);
  text('workflow', WORKFLOW);
  text('headSha', SHA);
  text('ref', REF);
  if (!EVENTS.includes(String(value['event'])))
    problems.push(`event must be one of ${EVENTS.join(', ')}`);
  for (const key of ['runId', 'runAttempt', 'runNumber']) {
    if (!isPositiveInteger(value[key])) problems.push(`${key} must be a positive integer`);
  }
  if (problems.length > 0) throw new ContextError(problems);
  return value as unknown as RunContext;
}

/** The context in the form the record composer cross-checks (the runner variable names). */
export function contextToEnvironment(context: RunContext): Record<string, string> {
  return {
    GITHUB_SERVER_URL: context.serverUrl,
    GITHUB_REPOSITORY: context.repository,
    GITHUB_WORKFLOW: context.workflow,
    GITHUB_RUN_ID: String(context.runId),
    GITHUB_RUN_ATTEMPT: String(context.runAttempt),
    GITHUB_RUN_NUMBER: String(context.runNumber),
    GITHUB_SHA: context.headSha,
    GITHUB_REF: context.ref,
    GITHUB_EVENT_NAME: context.event,
  };
}

/**
 * The context of a completed CI run, from a `workflow_run` event payload. Only runs that may be
 * recorded are accepted: completed, triggered by push or workflow_dispatch, on `main` of this
 * repository. A pull request from a fork whose branch is also called `main` is refused because
 * its head repository differs.
 */
export function contextFromWorkflowRunEvent(event: unknown, expectedWorkflow: string): RunContext {
  const problems: string[] = [];
  const run = isRecord(event) ? event['workflow_run'] : undefined;
  const repository =
    isRecord(event) && isRecord(event['repository']) ? event['repository']['full_name'] : undefined;
  if (!isRecord(run)) throw new ContextError(['the event has no workflow_run']);
  const runRepository = isRecord(run['repository']) ? run['repository']['full_name'] : undefined;
  const headRepository = isRecord(run['head_repository'])
    ? run['head_repository']['full_name']
    : undefined;

  if (typeof repository !== 'string') problems.push('event: repository.full_name is missing');
  if (runRepository !== repository)
    problems.push('workflow_run: repository differs from the event repository');
  if (headRepository !== repository) {
    problems.push('workflow_run: head repository differs (a fork); fork runs are never recorded');
  }
  if (run['status'] !== 'completed')
    problems.push(`workflow_run: status is "${String(run['status'])}", not completed`);
  if (run['event'] !== 'push' && run['event'] !== 'workflow_dispatch') {
    problems.push(`workflow_run: "${String(run['event'])}" runs are not recorded`);
  }
  if (run['head_branch'] !== 'main') problems.push('workflow_run: head_branch is not main');
  if (run['name'] !== expectedWorkflow) {
    problems.push(
      `workflow_run: workflow is "${String(run['name'])}", expected "${expectedWorkflow}"`,
    );
  }
  const url = run['html_url'];
  const expectedUrl = `${SERVER_URL}/${String(repository)}/actions/runs/${String(run['id'])}`;
  if (url !== expectedUrl) problems.push('workflow_run: html_url does not match the run');
  if (problems.length > 0) throw new ContextError(problems);

  return parseRunContext({
    schemaVersion: '1.0',
    kind: 'ci-run-context',
    serverUrl: SERVER_URL,
    repository,
    workflow: run['name'],
    runId: run['id'],
    runAttempt: run['run_attempt'],
    runNumber: run['run_number'],
    headSha: run['head_sha'],
    ref: 'refs/heads/main',
    event: run['event'],
  });
}
