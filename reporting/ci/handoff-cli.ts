import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { defaultSafetyContext } from '../dashboard-data/sanitize';
import { CollectError, composeRecord, serializeRecord, snapshotReference } from './collect';
import { ContextError, contextToEnvironment, parseRunContext, type RunContext } from './context';
import { canonicalJson, MAX_PAYLOAD_BYTES, MAX_RECORD_BYTES, recordPath, sha256 } from './history';
import {
  ARTIFACTS,
  type ApiInputs,
  type ArtifactDecision,
  type Fetch,
  fetchApiInputs,
  HandoffError,
  MAX_API_RESPONSE_BYTES,
  readArtifactFile,
  type Resolution,
  resolveHandoff,
} from './handoff';

/**
 * The read-only compose steps of the CI history workflow (.github/workflows/ci-history.yml). All
 * files live in one work folder:
 *
 *   context.json            ci:collect context, from the trusted workflow_run event
 *   api/*.json              Actions API responses for the triggering run attempt
 *   resolution.json         which artifacts to download, and which were never produced
 *   download/<kind>/        the raw downloaded artifacts (by ID, never extracted)
 *   record.json             the composed run record
 *   plan.json, check.json   history-cli plan and publish-check, against the current ci-history
 *
 *   npx tsx reporting/ci/handoff-cli.ts resolve --work <dir> [--api <dir>]
 *   npx tsx reporting/ci/handoff-cli.ts compose --work <dir>
 *   npx tsx reporting/ci/handoff-cli.ts payload --work <dir>
 *   npx tsx reporting/ci/handoff-cli.ts summary --work <dir>
 *
 * `resolve` fetches the API responses (GITHUB_TOKEN; or, offline, copies them from --api),
 * decides, and writes the step outputs `recordable`, `run-id`, `snapshot-id` and `suites-id`
 * (integers or empty) to GITHUB_OUTPUT. `compose` re-derives that decision from the saved
 * responses, reads the downloaded files and composes the record with the collector's checks.
 * `payload` hands the record to the separate, approved publish job: it writes the step outputs
 * `publish` (true only when the plan adds a new record), `record-sha256` and `record-b64`, after
 * checking that the record is canonical, matches the plan's SHA-256 and path, and fits
 * MAX_PAYLOAD_BYTES. `summary` prints a Markdown job summary of fixed text, integers and
 * validated values only. Nothing here writes outside the work folder, and nothing here
 * publishes. Exit 0 on success.
 */

const repoRoot = resolve(__dirname, '..', '..');
const API_FILES = {
  run: 'run.json',
  jobs: 'jobs.json',
  snapshot: 'artifacts-snapshot.json',
  suites: 'artifacts-suites.json',
} as const;

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--'))
    throw new HandoffError([`usage: --${name} needs a value`]);
  return resolve(value);
}

function readJson(path: string, maxBytes: number): unknown {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new HandoffError([`${relativeName(path)} is missing`]);
  }
  if (!stat.isFile()) throw new HandoffError([`${relativeName(path)} is not a regular file`]);
  if (stat.size > maxBytes) {
    throw new HandoffError([`${relativeName(path)} is larger than ${String(maxBytes)} bytes`]);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new HandoffError([`${relativeName(path)} is not JSON`]);
  }
}

/** File names in messages, never absolute runner paths. */
const relativeName = (path: string): string => path.split(/[\\/]/).slice(-2).join('/');

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRecord(value));
}

const readContext = (work: string): RunContext =>
  parseRunContext(readJson(join(work, 'context.json'), 64 * 1024));

function readApi(dir: string): ApiInputs {
  const read = (key: keyof typeof API_FILES): unknown =>
    readJson(join(dir, API_FILES[key]), MAX_API_RESPONSE_BYTES);
  return {
    run: read('run'),
    jobs: read('jobs'),
    listings: { snapshot: read('snapshot'), suites: read('suites') },
  };
}

function writeApi(dir: string, api: ApiInputs): void {
  write(join(dir, API_FILES.run), api.run);
  write(join(dir, API_FILES.jobs), api.jobs);
  write(join(dir, API_FILES.snapshot), api.listings.snapshot);
  write(join(dir, API_FILES.suites), api.listings.suites);
}

/** Step outputs: fixed keys, integer or boolean values only. */
export function stepOutputs(resolution: Resolution): string {
  const id = (decision: ArtifactDecision): string =>
    decision.state === 'download' ? String(decision.id) : '';
  return [
    `recordable=${String(resolution.recordable)}`,
    `run-id=${String(resolution.runId)}`,
    `snapshot-id=${id(resolution.snapshot)}`,
    `suites-id=${id(resolution.suites)}`,
    '',
  ].join('\n');
}

export async function resolveStage(
  work: string,
  source: { api: string } | { token: string; fetch: Fetch },
): Promise<Resolution> {
  const context = readContext(work);
  const api =
    'api' in source
      ? readApi(source.api)
      : await fetchApiInputs(context, source.token, source.fetch);
  writeApi(join(work, 'api'), api);
  const resolution = resolveHandoff(context, api);
  write(join(work, 'resolution.json'), resolution);
  return resolution;
}

export function composeStage(work: string): unknown {
  const context = readContext(work);
  // Re-derived from the saved responses, not read back from resolution.json.
  const resolution = resolveHandoff(context, readApi(join(work, 'api')));
  if (resolution.snapshot.state !== 'download') {
    throw new HandoffError(['the snapshot was never produced; no record is composed']);
  }
  // Each download is verified against its listing (name, size, not ZIP, SHA-256) before parsing.
  const snapshot: unknown = JSON.parse(
    readArtifactFile(join(work, 'download', 'snapshot'), 'snapshot', resolution.snapshot),
  );
  let suiteResults: unknown = null;
  if (resolution.suites.state === 'download') {
    suiteResults = JSON.parse(
      readArtifactFile(join(work, 'download', 'suites'), 'suites', resolution.suites),
    );
  } else if (existsSync(join(work, 'download', 'suites'))) {
    throw new HandoffError(['suite results were never produced, yet a download folder exists']);
  }
  const api = readApi(join(work, 'api'));
  const record = composeRecord({
    suiteResults,
    run: api.run,
    jobs: api.jobs,
    env: contextToEnvironment(context),
    snapshot: snapshotReference(snapshot),
    safety: defaultSafetyContext(repoRoot),
  });
  write(join(work, 'record.json'), record);
  return record;
}

const optionalJson = (path: string): unknown => {
  try {
    return readJson(path, ARTIFACTS.snapshot.maxBytes);
  } catch {
    return undefined;
  }
};
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (node, key) =>
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[key]
        : undefined,
    value,
  );
const integer = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '?';
const oneOf = (value: unknown, allowed: readonly string[]): string =>
  allowed.includes(value as string) ? (value as string) : '?';
const hex = (value: unknown): string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : '?';
const recordPathText = (value: unknown): string =>
  typeof value === 'string' && /^v1\/runs\/[1-9][0-9]*-[1-9][0-9]*\.json$/.test(value)
    ? value
    : '?';

/**
 * The publication hand-off for the approved publish job, as GITHUB_OUTPUT lines: `publish`
 * (true only when the plan adds a new record), `record-sha256` and `record-b64` (empty when there
 * is nothing to publish). The record must be exactly its canonical bytes, its SHA-256 and path
 * must be the plan's, and it must fit MAX_PAYLOAD_BYTES; anything else fails closed.
 */
export function payloadStage(work: string): string {
  const recordFile = join(work, 'record.json');
  let text: string;
  try {
    const stat = lstatSync(recordFile);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error('size');
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(recordFile));
  } catch {
    throw new HandoffError(['record.json is missing, not a regular file, too large or not UTF-8']);
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    throw new HandoffError(['record.json is not JSON']);
  }
  const plan = readJson(join(work, 'plan.json'), 64 * 1024);
  const digest = sha256(text);
  const problems: string[] = [];
  if (canonicalJson(record) !== text) problems.push('record.json is not in canonical form');
  if (at(plan, 'sha256') !== digest) problems.push('the plan SHA-256 differs from record.json');
  const runId = at(record, 'run', 'id');
  const attempt = at(record, 'run', 'attempt');
  if (
    typeof runId !== 'number' ||
    typeof attempt !== 'number' ||
    at(plan, 'path') !== recordPath(runId, attempt)
  ) {
    problems.push('the plan path is not the record path of this run attempt');
  }
  const action = at(plan, 'action');
  if (action !== 'add' && action !== 'unchanged') problems.push('the plan action is unknown');
  const publish = action === 'add';
  if (publish && Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    problems.push(`the record is larger than the ${String(MAX_PAYLOAD_BYTES)}-byte hand-off limit`);
  }
  if (problems.length > 0) throw new HandoffError(problems);
  return [
    `publish=${String(publish)}`,
    `record-sha256=${digest}`,
    `record-b64=${publish ? Buffer.from(text, 'utf8').toString('base64') : ''}`,
    '',
  ].join('\n');
}

/** The job summary: fixed text plus values re-validated here, never free text from inputs. */
export function summaryStage(work: string): string {
  const context = optionalJson(join(work, 'context.json'));
  const resolution = optionalJson(join(work, 'resolution.json'));
  const record = optionalJson(join(work, 'record.json'));
  const plan = optionalJson(join(work, 'plan.json'));
  const check = optionalJson(join(work, 'check.json'));
  const notRun = 'failed or did not run (see the step log)';
  const decision = (kind: 'snapshot' | 'suites'): string => {
    const state = at(resolution, kind, 'state');
    if (state === 'download' && at(resolution, 'recordable') === false)
      return 'present, not downloaded (no record without the snapshot)';
    if (state === 'download')
      return 'downloaded raw (size and SHA-256 verified, nothing extracted)';
    if (state === 'not-produced')
      return kind === 'snapshot'
        ? 'never produced: the CI job did not generate the snapshot'
        : 'never produced: suite results were not collected; suites are recorded as incomplete';
    return '—';
  };
  const recordable = at(resolution, 'recordable');
  const lines = [
    '## CI history: compose (read-only)',
    '',
    'This job has read-only permissions and writes nothing. A new record is published only by the separate publish job, after approval of the ci-history environment.',
    '',
    '| Stage | Result |',
    '| --- | --- |',
    `| Run context (workflow_run event) | ${
      context === undefined
        ? notRun
        : `run ${integer(at(context, 'runId'))}, attempt ${integer(at(context, 'runAttempt'))}, #${integer(at(context, 'runNumber'))}, ${oneOf(at(context, 'event'), ['push', 'workflow_dispatch'])}`
    } |`,
    `| Artifact hand-off | ${
      resolution === undefined
        ? notRun
        : `snapshot: ${decision('snapshot')}; suite results: ${decision('suites')}`
    } |`,
    `| Run record | ${
      recordable === false
        ? 'not composed: a record is never composed without the snapshot'
        : record === undefined
          ? notRun
          : `composed (job conclusion: ${oneOf(at(record, 'conclusion'), ['success', 'failure', 'cancelled', 'timed_out'])})`
    } |`,
    `| History plan (current ci-history) | ${
      recordable === false
        ? '—'
        : plan === undefined
          ? notRun
          : `${oneOf(at(plan, 'action'), ['add', 'unchanged'])} ${recordPathText(at(plan, 'path'))}, sha256 ${hex(at(plan, 'sha256'))}`
    } |`,
    `| Publisher pre-check | ${
      recordable === false
        ? '—'
        : check === undefined
          ? notRun
          : oneOf(at(check, 'check'), ['passed'])
    } |`,
    '',
  ];
  const suites = at(record, 'suites');
  if (Array.isArray(suites)) {
    const cell = (value: unknown): string =>
      typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '—';
    lines.push(
      '| Suite | State | Passed | Failed | Flaky | Skipped | Total |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...suites.map(
        (s: unknown) =>
          `| ${oneOf(at(s, 'id'), ['agents', 'dashboard-data', 'dashboard-frontend', 'playwright'])} | ${oneOf(at(s, 'state'), ['passed', 'flaky', 'failed', 'not-run', 'incomplete'])} | ${cell(at(s, 'counts', 'passed'))} | ${cell(at(s, 'counts', 'failed'))} | ${cell(at(s, 'counts', 'flaky'))} | ${cell(at(s, 'counts', 'skipped'))} | ${cell(at(s, 'counts', 'total'))} |`,
      ),
      '',
      'The sha256 is a transport-integrity and consistency value, not authentication and not proof that the results are true.',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  const work = option(args, 'work');
  if (work === undefined) throw new HandoffError(['usage: --work <dir> is required']);
  if (mode === 'resolve') {
    const api = option(args, 'api');
    const resolution = await resolveStage(
      work,
      api !== undefined
        ? { api }
        : { token: process.env['GITHUB_TOKEN'] ?? '', fetch: (url, init) => fetch(url, init) },
    );
    const outputs = process.env['GITHUB_OUTPUT'];
    if (outputs !== undefined && outputs !== '') appendFileSync(outputs, stepOutputs(resolution));
    process.stdout.write(stepOutputs(resolution));
  } else if (mode === 'compose') {
    composeStage(work);
    process.stdout.write('record composed\n');
  } else if (mode === 'payload') {
    const outputs = payloadStage(work);
    const file = process.env['GITHUB_OUTPUT'];
    if (file !== undefined && file !== '') appendFileSync(file, outputs);
    process.stdout.write(outputs.replace(/^record-b64=.+$/m, 'record-b64=<base64>'));
  } else if (mode === 'summary') {
    process.stdout.write(summaryStage(work));
  } else {
    throw new HandoffError(['usage: handoff-cli.ts resolve|compose|payload|summary --work <dir>']);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (
      error instanceof HandoffError ||
      error instanceof CollectError ||
      error instanceof ContextError
    ) {
      console.error(error.message);
    } else if (error instanceof SyntaxError) {
      console.error('CI artifact hand-off refused: a downloaded file is not JSON');
    } else {
      // No message or stack: either could carry runner paths.
      console.error(
        `CI history compose failed: unexpected ${error instanceof Error ? error.name : 'error'}`,
      );
    }
    process.exit(1);
  });
}
