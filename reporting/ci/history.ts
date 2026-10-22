import { createHash } from 'node:crypto';

/**
 * Offline preparation of the CI execution history: immutable record paths, canonical bytes and a
 * deterministic index, over an in-memory tree (repository-relative path → file content).
 *
 * Dependency-free on purpose (node built-ins and erasable TypeScript only), so it can run with
 * plain `node` where no packages are installed. It checks the structure it relies on; full
 * schema and public-safety validation of records is the caller's job (history-cli.ts). No git,
 * no network, no file system access here.
 *
 * Layout (version 1):
 *   README.md                          optional notice
 *   v1/index.json                      rebuilt from v1/runs on every change; never edited
 *   v1/runs/<runId>-<attempt>.json     one record per run attempt; immutable
 *
 * Integrity: the index's sha256 values are a consistency check between the index and the record
 * files. They are derived from the records themselves, so they are not independent tamper
 * evidence: whoever can edit a record can also rebuild the index. Tamper evidence for published
 * history comes from the git history of the branch that holds it, and from repository protections
 * (no force-push, no deletion, restricted writers).
 *
 * Limits: inputs larger than MAX_RECORD_BYTES, MAX_INDEX_BYTES or MAX_README_BYTES are refused
 * before they are parsed. A record today is about 6 KB; the limits leave ample room.
 */

/** Largest accepted record file (1 MiB; the schema allows at most 2,000 Playwright results). */
export const MAX_RECORD_BYTES = 1024 * 1024;
/** Largest accepted index file (16 MiB; about 60,000 entries). */
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;
/** Largest accepted README (64 KiB). */
export const MAX_README_BYTES = 64 * 1024;
/**
 * Largest record handed from the read-only compose job to the publish job (64 KiB). It travels
 * base64-encoded in one environment variable, which Linux limits to 128 KiB; larger records fail
 * closed instead of being truncated. A record today is about 9 KB.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export const INDEX_PATH = 'v1/index.json';
export const README_PATH = 'README.md';
const RUN_PATH = /^v1\/runs\/([1-9][0-9]*)-([1-9][0-9]*)\.json$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const SHA = /^[0-9a-f]{40}$/;
const EVENTS = ['push', 'workflow_dispatch'];
const CONCLUSIONS = ['success', 'failure', 'cancelled', 'timed_out'];

export interface IndexEntry {
  readonly runId: number;
  readonly attempt: number;
  readonly number: number;
  readonly commitSha: string;
  readonly event: string;
  readonly conclusion: string;
  readonly jobCompletedAt: string;
  readonly path: string;
  readonly sha256: string;
}

export interface HistoryIndex {
  readonly schemaVersion: '1.0';
  readonly kind: 'ci-history-index';
  readonly recordSchema: 'ci-run/1.0';
  readonly runs: readonly IndexEntry[];
}

export type HistoryTree = ReadonlyMap<string, string>;

export class HistoryError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`CI history cannot be updated:\n  ${problems.join('\n  ')}`);
    this.name = 'HistoryError';
    this.problems = problems;
  }
}

/** The one serialization used for records and the index (2-space JSON, trailing newline). */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Milliseconds since the epoch of an RFC 3339 instant, or null if it is not a real instant.
 * Every field is checked on its own, so nothing is normalized: no month 13, no 30 February, no
 * 29 February outside leap years, no 24:00, no leap second (:60), offsets within ±14:00. Years are
 * limited to 1970–9999. Fractions beyond milliseconds are accepted and truncated.
 */
export function parseInstant(text: string): number | null {
  const match = INSTANT.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fraction = match[7] ?? '';
  const sign = match[8];
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (year < 1970 || month < 1 || month > 12) return null;
  const daysInMonth = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  if (offsetMinutes > 59 || offsetHours * 60 + offsetMinutes > 14 * 60) return null;
  const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3));
  const offset = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offset;
  return Number.isFinite(utc) ? utc : null;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function recordPath(runId: number, attempt: number): string {
  for (const [name, value] of [
    ['runId', runId],
    ['attempt', attempt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new HistoryError([`${name} must be a positive integer`]);
  }
  return `v1/runs/${String(runId)}-${String(attempt)}.json`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The index entry of one record file; the file must be canonical and stored at its own path. */
export function entryFor(path: string, content: string): IndexEntry {
  if (byteLength(content) > MAX_RECORD_BYTES) {
    throw new HistoryError([`${path}: larger than ${String(MAX_RECORD_BYTES)} bytes`]);
  }
  const problems: string[] = [];
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    throw new HistoryError([`${path}: not valid JSON`]);
  }
  if (!isRecord(record)) throw new HistoryError([`${path}: not a JSON object`]);
  const run = isRecord(record['run']) ? record['run'] : {};
  const trigger = isRecord(record['trigger']) ? record['trigger'] : {};
  const timestamps = isRecord(record['timestamps']) ? record['timestamps'] : {};
  const check = (condition: boolean, problem: string): void => {
    if (!condition) problems.push(`${path}: ${problem}`);
  };
  check(
    record['schemaVersion'] === '1.0' && record['kind'] === 'ci-run',
    'not a ci-run 1.0 record',
  );
  check(record['status'] === 'completed', 'status is not completed');
  for (const key of ['id', 'attempt', 'number']) {
    check(
      Number.isSafeInteger(run[key]) && (run[key] as number) >= 1,
      `run.${key} is not a positive integer`,
    );
  }
  check(
    typeof record['commitSha'] === 'string' && SHA.test(record['commitSha']),
    'commitSha is malformed',
  );
  check(EVENTS.includes(String(trigger['event'])), 'trigger.event is not recordable');
  check(CONCLUSIONS.includes(String(record['conclusion'])), 'conclusion is not recordable');
  const completed = timestamps['jobCompletedAt'];
  check(
    typeof completed === 'string' && parseInstant(completed) !== null,
    'timestamps.jobCompletedAt is not a real instant',
  );
  if (problems.length > 0) throw new HistoryError(problems);

  const runId = run['id'] as number;
  const attempt = run['attempt'] as number;
  if (path !== recordPath(runId, attempt)) {
    throw new HistoryError([
      `${path}: the record is for run ${String(runId)} attempt ${String(attempt)}`,
    ]);
  }
  if (content !== canonicalJson(record)) {
    throw new HistoryError([
      `${path}: not in canonical form (2-space JSON with a trailing newline)`,
    ]);
  }
  return {
    runId,
    attempt,
    number: run['number'] as number,
    commitSha: record['commitSha'] as string,
    event: trigger['event'] as string,
    conclusion: record['conclusion'] as string,
    jobCompletedAt: completed as string,
    path,
    sha256: sha256(content),
  };
}

/** A total order: entries only ever hold instants that parseInstant accepted. */
function compareEntries(a: IndexEntry, b: IndexEntry): number {
  return (
    (parseInstant(a.jobCompletedAt) ?? 0) - (parseInstant(b.jobCompletedAt) ?? 0) ||
    a.runId - b.runId ||
    a.attempt - b.attempt
  );
}

/**
 * The index of every record in the tree, ordered by job completion time, then run ID, then
 * attempt. Attempts of one run must agree on its number, commit and trigger. Each entry's sha256
 * is a consistency check against its record file, not independent tamper evidence (see above).
 */
export function buildIndex(tree: HistoryTree): HistoryIndex {
  const entries = [...tree.keys()]
    .filter((path) => RUN_PATH.test(path))
    .map((path) => entryFor(path, tree.get(path) ?? ''));
  const problems: string[] = [];
  const byRun = new Map<number, IndexEntry>();
  for (const entry of entries) {
    const first = byRun.get(entry.runId);
    if (first === undefined) byRun.set(entry.runId, entry);
    else if (
      first.number !== entry.number ||
      first.commitSha !== entry.commitSha ||
      first.event !== entry.event
    ) {
      problems.push(
        `run ${String(entry.runId)}: attempts disagree on run number, commit or trigger`,
      );
    }
  }
  if (problems.length > 0) throw new HistoryError(problems);
  return {
    schemaVersion: '1.0',
    kind: 'ci-history-index',
    recordSchema: 'ci-run/1.0',
    runs: [...entries].sort(compareEntries),
  };
}

/** Problems with a history tree: unexpected files, invalid or misplaced records, a stale index. */
export function verifyTree(tree: HistoryTree): string[] {
  const problems: string[] = [];
  for (const path of tree.keys()) {
    if (path !== README_PATH && path !== INDEX_PATH && !RUN_PATH.test(path)) {
      problems.push(`${path}: not part of the history layout`);
    }
  }
  let index: HistoryIndex;
  try {
    index = buildIndex(tree);
  } catch (error) {
    if (error instanceof HistoryError) return [...problems, ...error.problems];
    throw error;
  }
  const readme = tree.get(README_PATH);
  if (readme !== undefined && byteLength(readme) > MAX_README_BYTES) {
    problems.push(`${README_PATH}: larger than ${String(MAX_README_BYTES)} bytes`);
  }
  const stored = tree.get(INDEX_PATH);
  if (stored !== undefined && byteLength(stored) > MAX_INDEX_BYTES) {
    problems.push(`${INDEX_PATH}: larger than ${String(MAX_INDEX_BYTES)} bytes`);
  } else if (stored === undefined) {
    if (index.runs.length > 0) problems.push(`${INDEX_PATH}: missing`);
  } else if (stored !== canonicalJson(index)) {
    problems.push(`${INDEX_PATH}: does not match the records (stale, edited or out of order)`);
  }
  return problems;
}

export interface Addition {
  readonly action: 'add' | 'unchanged';
  readonly path: string;
  readonly sha256: string;
  /** The complete tree after the addition (equal to the input when unchanged). */
  readonly tree: HistoryTree;
  /** Files whose content is new or changed, to be written. */
  readonly changed: readonly string[];
}

/**
 * Adds one record (its canonical bytes) to a consistent history. The same bytes at the same path
 * are a no-op; different bytes at the same path are a conflict and are never overwritten.
 */
export function planAddition(tree: HistoryTree, content: string): Addition {
  const existing = verifyTree(tree);
  if (existing.length > 0)
    throw new HistoryError(['the existing history is not consistent:', ...existing]);
  if (byteLength(content) > MAX_RECORD_BYTES) {
    throw new HistoryError([`the new record is larger than ${String(MAX_RECORD_BYTES)} bytes`]);
  }
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    throw new HistoryError(['the new record is not valid JSON']);
  }
  const run = isRecord(record) && isRecord(record['run']) ? record['run'] : {};
  const path = recordPath(run['id'] as number, run['attempt'] as number);
  const entry = entryFor(path, content);

  const current = tree.get(path);
  if (current === content)
    return { action: 'unchanged', path, sha256: entry.sha256, tree, changed: [] };
  if (current !== undefined) {
    throw new HistoryError([
      `${path}: a different record already exists for this run attempt; records are never overwritten`,
    ]);
  }
  const next = new Map(tree);
  next.set(path, content);
  const index = canonicalJson(buildIndex(next));
  const changed = [path];
  if (tree.get(INDEX_PATH) !== index) changed.push(INDEX_PATH);
  next.set(INDEX_PATH, index);
  return { action: 'add', path, sha256: entry.sha256, tree: next, changed };
}
