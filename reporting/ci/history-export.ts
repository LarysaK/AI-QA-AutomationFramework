import { validateRecord } from './collect';
import { buildIndex, type HistoryTree, parseInstant } from './history';

/**
 * The CI execution history as the dashboard embeds it (Phase 5.3 M4): every published ci-run
 * record of one ci-history commit, verbatim and newest first, plus, when supplied, the coverage
 * a read-only reconciliation (M3e) found for that same commit. Pure: callers supply the verified
 * history tree, its commit and commit time, and the reconciliation report.
 *
 * It is a build-time snapshot: it describes the ci-history branch at `source.commit` and changes
 * only when it is regenerated. Records are what the CI jobs reported; nothing is inferred, and a
 * run attempt without a record is never treated as failed or as not having happened.
 */

export const EXPORT_SCHEMA_VERSION = '1.0';
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA1 = /^[0-9a-f]{40}$/;

/** Reconciliation statuses of eligible run attempts without a record (reconcile.ts). */
export const UNPUBLISHED_STATUSES = [
  'unpublished-artifacts-retained',
  'unpublished-artifacts-expired',
  'unpublished-legacy-artifacts',
  'unpublished-no-artifacts',
  'metadata-unavailable',
] as const;
export type UnpublishedStatus = (typeof UNPUBLISHED_STATUSES)[number];
const COUNTED = ['published', ...UNPUBLISHED_STATUSES, 'ineligible', 'pending'] as const;

export interface Coverage {
  /** The ci-history commit the reconciliation verified (always source.commit). */
  readonly commit: string;
  readonly listingComplete: boolean;
  readonly runsListed: number;
  readonly verdict: 'complete' | 'gaps' | 'undetermined';
  readonly missingAttempts: number;
  readonly counts: Readonly<Record<(typeof COUNTED)[number], number>>;
  readonly unpublished: readonly {
    readonly runId: number;
    readonly attempt: number;
    readonly runNumber: number;
    readonly status: UnpublishedStatus;
  }[];
}

export interface HistoryExport {
  readonly schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  readonly kind: 'ci-history-export';
  readonly source: {
    readonly repository: string;
    readonly branch: 'ci-history';
    readonly commit: string;
    /** Committer time of source.commit: when the history last changed, not when it was read. */
    readonly committedAt: string;
    readonly records: number;
  };
  /** Null when no reconciliation was supplied: coverage of unpublished runs is unknown. */
  readonly coverage: Coverage | null;
  /** ci-run 1.0 records, newest first (job completion time, then run ID, then attempt). */
  readonly records: readonly unknown[];
}

export class ExportError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`CI history export refused:\n  ${problems.join('\n  ')}`);
    this.name = 'ExportError';
    this.problems = problems;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositive = (value: unknown): value is number => isCount(value) && value >= 1;
const keyOf = (runId: unknown, attempt: unknown): string => `${String(runId)}-${String(attempt)}`;

/** The coverage section from a reconciliation report of the same, verified history commit. */
function coverageFrom(
  report: unknown,
  repository: string,
  commit: string,
  published: Set<string>,
): Coverage {
  const problems: string[] = [];
  const history = field(report, 'history');
  const verdict = field(report, 'verdict');
  const api = field(report, 'api');
  if (
    field(report, 'kind') !== 'ci-history-reconciliation' ||
    field(report, 'schemaVersion') !== '1.0'
  ) {
    throw new ExportError(['the reconciliation is not a ci-history-reconciliation 1.0 report']);
  }
  if (field(report, 'repository') !== repository)
    problems.push('the reconciliation is for another repository');
  if (field(history, 'commit') !== commit)
    problems.push('the reconciliation checked another ci-history commit');
  if (field(verdict, 'integrity') !== 'verified')
    problems.push('the reconciliation did not verify integrity');
  const coverage = field(verdict, 'coverage');
  if (coverage !== 'complete' && coverage !== 'gaps' && coverage !== 'undetermined') {
    problems.push('the reconciliation coverage verdict is unknown');
  }
  const summary = field(report, 'summary');
  const counts = {} as Record<(typeof COUNTED)[number], number>;
  for (const status of COUNTED) {
    const n = field(summary, status);
    if (isCount(n)) counts[status] = n;
    else problems.push(`the reconciliation count "${status}" is missing`);
  }
  const attempts = field(report, 'attempts');
  const unpublished: Coverage['unpublished'][number][] = [];
  if (!Array.isArray(attempts)) problems.push('the reconciliation lists no attempts');
  else {
    for (const a of attempts) {
      const status = field(a, 'status');
      const runId = field(a, 'runId');
      const attempt = field(a, 'attempt');
      const runNumber = field(a, 'runNumber');
      if (!isPositive(runId) || !isPositive(attempt) || !isPositive(runNumber)) {
        problems.push('a reconciliation attempt has a malformed identity');
        continue;
      }
      if (status === 'published') {
        if (!published.has(keyOf(runId, attempt))) {
          problems.push(
            `run ${String(runId)} attempt ${String(attempt)} is published in the reconciliation but has no record`,
          );
        }
      } else if ((UNPUBLISHED_STATUSES as readonly unknown[]).includes(status)) {
        if (published.has(keyOf(runId, attempt))) {
          problems.push(
            `run ${String(runId)} attempt ${String(attempt)} has a record but the reconciliation calls it unpublished`,
          );
        }
        unpublished.push({ runId, attempt, runNumber, status: status as UnpublishedStatus });
      } else {
        problems.push(
          `run ${String(runId)} attempt ${String(attempt)} has status "${String(status)}"`,
        );
      }
    }
  }
  const missing = field(verdict, 'missingAttempts');
  if (!isCount(missing) || missing !== unpublished.length)
    problems.push('the reconciliation missing-attempt count does not match its attempts');
  if (!isCount(field(api, 'runsListed'))) problems.push('the reconciliation run count is missing');
  if (problems.length > 0) throw new ExportError(problems);
  unpublished.sort((a, b) => b.runId - a.runId || b.attempt - a.attempt);
  return {
    commit,
    listingComplete: field(api, 'complete') === true,
    runsListed: field(api, 'runsListed') as number,
    verdict: coverage as Coverage['verdict'],
    missingAttempts: missing as number,
    counts,
    unpublished,
  };
}

/** The export of a verified history tree (records newest first), with optional coverage. */
export function buildExport(input: {
  readonly repository: string;
  readonly tree: HistoryTree;
  readonly commit: string;
  readonly committedAt: string;
  readonly reconciliation: unknown;
}): HistoryExport {
  if (!REPOSITORY.test(input.repository))
    throw new ExportError(['the repository is not owner/name']);
  if (!SHA1.test(input.commit)) throw new ExportError(['the ci-history commit is not a full SHA']);
  if (parseInstant(input.committedAt) === null)
    throw new ExportError(['the commit time is not an instant']);
  // The index order (oldest first) is the history's own deterministic order; newest first here.
  const index = buildIndex(input.tree);
  const records = index.runs
    .map((entry) => JSON.parse(input.tree.get(entry.path) ?? 'null') as unknown)
    .reverse();
  const published = new Set(index.runs.map((e) => keyOf(e.runId, e.attempt)));
  const result: HistoryExport = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: 'ci-history-export',
    source: {
      repository: input.repository,
      branch: 'ci-history',
      commit: input.commit,
      committedAt: input.committedAt,
      records: records.length,
    },
    coverage:
      input.reconciliation === undefined || input.reconciliation === null
        ? null
        : coverageFrom(input.reconciliation, input.repository, input.commit, published),
    records,
  };
  const problems = validateExport(result);
  if (problems.length > 0) throw new ExportError(problems);
  return result;
}

/** Every check the dashboard build repeats before embedding an export; empty means valid. */
export function validateExport(value: unknown): string[] {
  const problems: string[] = [];
  const keys = isRecord(value) ? Object.keys(value).sort().join(',') : '';
  if (keys !== 'coverage,kind,records,schemaVersion,source')
    return ['export: unexpected or missing top-level fields'];
  if (
    field(value, 'schemaVersion') !== EXPORT_SCHEMA_VERSION ||
    field(value, 'kind') !== 'ci-history-export'
  ) {
    return ['export: not a ci-history-export 1.0'];
  }
  const source = field(value, 'source');
  const repository = field(source, 'repository');
  const sourceKeys = isRecord(source) ? Object.keys(source).sort().join(',') : '';
  if (sourceKeys !== 'branch,commit,committedAt,records,repository')
    problems.push('source: unexpected or missing fields');
  if (typeof repository !== 'string' || !REPOSITORY.test(repository))
    problems.push('source.repository is malformed');
  if (field(source, 'branch') !== 'ci-history') problems.push('source.branch is not ci-history');
  if (typeof field(source, 'commit') !== 'string' || !SHA1.test(field(source, 'commit') as string))
    problems.push('source.commit is malformed');
  if (
    typeof field(source, 'committedAt') !== 'string' ||
    parseInstant(field(source, 'committedAt') as string) === null
  ) {
    problems.push('source.committedAt is not an instant');
  }
  const records = field(value, 'records');
  if (!Array.isArray(records)) return [...problems, 'records is not a list'];
  if (field(source, 'records') !== records.length)
    problems.push('source.records does not match the records');
  const seen = new Set<string>();
  let previous: [number, number, number] | undefined;
  records.forEach((record, i) => {
    const where = `records/${String(i)}`;
    problems.push(...validateRecord(record).map((p) => `${where}: ${p}`));
    const run = field(record, 'run');
    const id = field(run, 'id');
    const attempt = field(run, 'attempt');
    if (field(record, 'repository') !== repository) problems.push(`${where}: another repository`);
    if (
      field(run, 'url') !== `https://github.com/${String(repository)}/actions/runs/${String(id)}`
    ) {
      problems.push(`${where}: run.url is not this repository's run URL`);
    }
    const key = keyOf(id, attempt);
    if (seen.has(key)) problems.push(`${where}: run ${key} appears twice`);
    seen.add(key);
    const at = parseInstant(String(field(field(record, 'timestamps'), 'jobCompletedAt')));
    const order: [number, number, number] = [at ?? 0, Number(id), Number(attempt)];
    if (previous !== undefined) {
      const newer = order[0] - previous[0] || order[1] - previous[1] || order[2] - previous[2];
      if (newer >= 0) problems.push(`${where}: records are not newest first`);
    }
    previous = order;
  });
  const coverage = field(value, 'coverage');
  if (coverage !== null) {
    if (field(coverage, 'commit') !== field(source, 'commit'))
      problems.push('coverage: checked another commit');
    if (!['complete', 'gaps', 'undetermined'].includes(field(coverage, 'verdict') as string))
      problems.push('coverage: unknown verdict');
    const unpublished = field(coverage, 'unpublished');
    if (!Array.isArray(unpublished)) problems.push('coverage: unpublished is not a list');
    else {
      if (field(coverage, 'missingAttempts') !== unpublished.length)
        problems.push('coverage: missingAttempts does not match');
      for (const u of unpublished) {
        if (
          !isPositive(field(u, 'runId')) ||
          !isPositive(field(u, 'attempt')) ||
          !isPositive(field(u, 'runNumber'))
        ) {
          problems.push('coverage: an unpublished attempt has a malformed identity');
        }
        if (!(UNPUBLISHED_STATUSES as readonly unknown[]).includes(field(u, 'status')))
          problems.push('coverage: unknown status');
        if (seen.has(keyOf(field(u, 'runId'), field(u, 'attempt'))))
          problems.push('coverage: an unpublished attempt has a record');
      }
    }
    for (const status of COUNTED) {
      if (!isCount(field(field(coverage, 'counts'), status)))
        problems.push(`coverage: count "${status}" is missing`);
    }
    if (
      typeof field(coverage, 'listingComplete') !== 'boolean' ||
      !isCount(field(coverage, 'runsListed'))
    ) {
      problems.push('coverage: listing fields are malformed');
    }
  }
  return problems;
}
