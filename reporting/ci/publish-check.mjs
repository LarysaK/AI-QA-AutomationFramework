// Publisher pre-check for one CI run record (Phase 5.3 M3c). Dependency-free: plain Node.js
// (22.18 or later, which strips TypeScript types) and three dependency-free modules of this
// repository, so a future publisher can run it without installing anything.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON reporting/ci/publish-check.mjs \
//     --event <workflow_run event.json> --record <record.json> --sha256 <hex> --history <dir>
//
// Checks, all fail-closed:
//   - the record's identity (repository, workflow, run ID, attempt, number, URL, event, ref and
//     commit) equals the context derived from the trusted workflow_run event, which is supplied
//     independently of the record and accepted only for completed push or workflow_dispatch
//     runs on main of this repository;
//   - the record is a regular file within MAX_RECORD_BYTES, valid UTF-8 and exactly its
//     canonical serialization, and its sha256 equals the value handed over with it;
//   - it passes the public-safety scan;
//   - the history (a local directory) holds no different record for the same run attempt:
//     records are immutable, identical bytes are "unchanged".
//
// The sha256 is transport integrity between two jobs: it shows the bytes were not altered in
// transit, not who produced them and not that the test results are true. This check does NOT
// validate the full ci-run 1.0 schema; that is done, with the collector's cross-checks, by the
// read-only compose job before the record is handed over. Prints
// {"check":"passed","action":"add"|"unchanged","path","sha256"}; exit 0 on success, 1 otherwise.

import console from 'node:console';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { defaultSafetyContext, publicSafetyFindings } from '../dashboard-data/sanitize.ts';
import { ContextError, contextFromWorkflowRunEvent } from './context.ts';
import { canonicalJson, MAX_RECORD_BYTES, recordPath, sha256 } from './history.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
export const MAX_EVENT_BYTES = 4 * 1024 * 1024;
export const WORKFLOW = 'CI';
const RECORD_KEYS = [
  'schemaVersion',
  'kind',
  'repository',
  'workflow',
  'job',
  'run',
  'trigger',
  'commitSha',
  'status',
  'conclusion',
  'timestamps',
  'environment',
  'steps',
  'suites',
  'playwright',
];
const CONCLUSIONS = ['success', 'failure', 'cancelled', 'timed_out'];

export class PublishCheckError extends Error {
  constructor(problems) {
    super(`publish check failed:\n  ${problems.join('\n  ')}`);
    this.name = 'PublishCheckError';
    this.problems = problems;
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads a regular file (never through a link) within a size limit, as strict UTF-8. */
function readBounded(path, maxBytes, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new PublishCheckError([`${label} is missing`]);
  }
  if (!stat.isFile()) throw new PublishCheckError([`${label} is not a regular file`]);
  if (stat.size > maxBytes) {
    throw new PublishCheckError([`${label} is larger than ${String(maxBytes)} bytes`]);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new PublishCheckError([`${label} is not valid UTF-8`]);
  }
}

/** The existing file at a history path, refusing links and non-files on the way; null if absent. */
function existing(root, path) {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new PublishCheckError(['the history must be a directory, not a link or a file']);
  }
  let current = root;
  const parts = path.split('/');
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    const last = i === parts.length - 1;
    if (stat.isSymbolicLink())
      throw new PublishCheckError([`${path}: a symbolic link is in the way`]);
    if (last ? !stat.isFile() : !stat.isDirectory()) {
      throw new PublishCheckError([`${path}: something other than a record is in the way`]);
    }
  }
  return readBounded(current, MAX_RECORD_BYTES, path);
}

/**
 * The check itself, over already-read inputs. `event` is the parsed workflow_run event, `text`
 * the record file's content, `expectedSha256` the value handed over with it, and
 * `readExisting(path)` returns the history's current file at a record path, or null.
 */
export function publishCheck({ event, text, expectedSha256, readExisting, safety }) {
  const context = contextFromWorkflowRunEvent(event, WORKFLOW);
  const problems = [];
  const check = (condition, problem) => {
    if (!condition) problems.push(problem);
  };

  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new PublishCheckError(['the expected sha256 is missing or malformed']);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new PublishCheckError(['the record is not JSON']);
  }
  if (!isRecord(record)) throw new PublishCheckError(['the record is not a JSON object']);
  check(canonicalJson(record) === text, 'the record is not in canonical form');
  const digest = sha256(text);
  check(digest === expectedSha256, 'sha256 does not match the value handed over');

  const keys = Object.keys(record);
  check(
    keys.length === RECORD_KEYS.length && RECORD_KEYS.every((k) => keys.includes(k)),
    'the record does not have exactly the ci-run 1.0 top-level fields',
  );
  const run = isRecord(record.run) ? record.run : {};
  const trigger = isRecord(record.trigger) ? record.trigger : {};
  check(record.schemaVersion === '1.0' && record.kind === 'ci-run', 'not a ci-run 1.0 record');
  check(record.repository === context.repository, 'repository differs from the event');
  check(record.workflow === context.workflow, 'workflow differs from the event');
  check(record.job === 'Verify', 'job is not Verify');
  check(run.id === context.runId, 'run ID differs from the event');
  check(run.attempt === context.runAttempt, 'run attempt differs from the event');
  check(run.number === context.runNumber, 'run number differs from the event');
  check(
    run.url === `${context.serverUrl}/${context.repository}/actions/runs/${String(context.runId)}`,
    'run URL differs from the event',
  );
  check(trigger.event === context.event, 'trigger event differs from the event');
  check(trigger.ref === context.ref, 'trigger ref differs from the event');
  check(record.commitSha === context.headSha, 'commit differs from the event');
  check(record.status === 'completed', 'status is not completed');
  check(CONCLUSIONS.includes(record.conclusion), 'conclusion is not recordable');
  problems.push(...publicSafetyFindings(record, safety).map((f) => `not public-safe: ${f}`));
  if (problems.length > 0) throw new PublishCheckError(problems);

  const path = recordPath(context.runId, context.runAttempt);
  const current = readExisting(path);
  if (current !== null && current !== text) {
    throw new PublishCheckError([
      `${path}: a different record already exists for this run attempt; records are never overwritten`,
    ]);
  }
  return { check: 'passed', action: current === null ? 'add' : 'unchanged', path, sha256: digest };
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new PublishCheckError([`usage: --${name} is required`]);
  }
  return value;
}

// The entry point, compared by real path: a symlinked or aliased path must not skip the check
// (which would exit 0 having checked nothing).
if (
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    const eventText = readBounded(resolve(option(args, 'event')), MAX_EVENT_BYTES, 'the event');
    let event;
    try {
      event = JSON.parse(eventText);
    } catch {
      throw new PublishCheckError(['the event is not JSON']);
    }
    const history = resolve(option(args, 'history'));
    const result = publishCheck({
      event,
      text: readBounded(resolve(option(args, 'record')), MAX_RECORD_BYTES, 'the record'),
      expectedSha256: option(args, 'sha256'),
      readExisting: (path) => existing(history, path),
      safety: defaultSafetyContext(repoRoot),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error instanceof PublishCheckError || error instanceof ContextError) {
      console.error(error.message);
      process.exit(1);
    }
    console.error('publish check failed: unexpected error');
    process.exit(1);
  }
}
