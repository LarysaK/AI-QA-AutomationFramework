import { ContextError, contextFromWorkflowRunEvent } from './context';
import { API_URL, artifactName, type Fetch, MAX_API_RESPONSE_BYTES } from './handoff';
import { type HistoryTree, recordPath } from './history';

/**
 * CI history reconciliation (Phase 5.3 M3e). Read-only: compares the published ci-history
 * branch with the CI runs the Actions API lists, and reports, never repairs. Pure apart from the
 * bounded GET helper; callers supply the verified history tree, the git audit and API responses.
 *
 * Eligibility is the publisher's: a listed run is eligible exactly when contextFromWorkflowRunEvent
 * accepts it (completed push or workflow_dispatch run of CI on main of this repository, not a
 * fork). Every attempt 1..run_attempt of an eligible run is eligible: earlier attempts completed
 * before the latest one started.
 *
 * Statuses, per eligible run attempt:
 *   published                     a record exists and its run identity matches the API
 *   inconsistent                  a record exists but its identity differs from the API
 *   unpublished-artifacts-retained  no record; the attempt's raw hand-off snapshot is still listed
 *                                 and not expired (publication would need a publisher run for
 *                                 this attempt; re-running a CI history run made before the
 *                                 publisher existed re-runs that old definition and cannot)
 *   unpublished-artifacts-expired no record; the snapshot artifact is listed but expired
 *   unpublished-legacy-artifacts  no record; only pre-M3d-1 archive artifacts are listed, which
 *                                 the publisher does not accept
 *   unpublished-no-artifacts      no record and no hand-off artifact listed: the run predates the
 *                                 hand-off, never produced a snapshot, or its artifacts expired
 *                                 and were removed. The API cannot tell these apart; this is NOT
 *                                 evidence that the run attempt did not happen.
 *   metadata-unavailable          no record, and the artifact listing could not be read in full
 * Per listed run that is not eligible: `ineligible` (with a reason code) or `pending` (not yet
 * completed; it may become eligible). Per record whose run the API did not list (deleted, or
 * outside the listed range): `unlisted-record`, reported, not judged.
 *
 * Two separate verdicts, and the exit status derived from them only:
 *   integrity  failed       the history is invalid (layout, index, schema, public safety), the
 *                           immutability audit found a violation, or a record's identity differs
 *                           from the API (inconsistent)
 *              unverified   nothing failed, but the immutability audit could not run
 *              verified     otherwise
 *   coverage   gaps         at least one eligible run attempt has no record (any unpublished-* or
 *                           metadata-unavailable status: the record is known to be missing, only
 *                           the reason may be unknown)
 *              undetermined no known gap, but the runs listing is incomplete, so unlisted eligible
 *                           attempts may be missing
 *              complete     the runs listing is complete and every eligible attempt is published
 * Exit 1: integrity failed (an integrity or security failure; always wins).
 * Exit 2: integrity not failed, but integrity unverified or coverage not complete (known gaps or
 *         undetermined): a diagnostic finding, not damage.
 * Exit 0: integrity verified and coverage complete.
 * Pending and ineligible runs and unlisted records are reported but change neither verdict. An
 * artifact listing is needed only to explain a missing record; its failure never affects runs
 * whose attempts are all published.
 */

export type AttemptStatus =
  | 'published'
  | 'inconsistent'
  | 'unpublished-artifacts-retained'
  | 'unpublished-artifacts-expired'
  | 'unpublished-legacy-artifacts'
  | 'unpublished-no-artifacts'
  | 'metadata-unavailable';
export type RunStatus = 'ineligible' | 'pending';

export const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'published',
  'inconsistent',
  'unpublished-artifacts-retained',
  'unpublished-artifacts-expired',
  'unpublished-legacy-artifacts',
  'unpublished-no-artifacts',
  'metadata-unavailable',
];

export const WORKFLOW_FILE = 'ci.yml';
export const WORKFLOW_NAME = 'CI';
/** At most this many pages of 100 runs are read; more is reported as incomplete. */
export const MAX_RUN_PAGES = 10;

export interface AttemptEntry {
  readonly runId: number;
  readonly attempt: number;
  readonly runNumber: number;
  readonly status: AttemptStatus;
  /** Record path for published, inconsistent and unpublished attempts. */
  readonly path: string;
  /** Identity fields that differ (inconsistent only), by name. */
  readonly mismatches?: readonly string[];
  /** When the retained snapshot artifact expires (unpublished-artifacts-retained only). */
  readonly artifactsExpireAt?: string;
}

export interface RunEntry {
  readonly runId: number;
  readonly runNumber: number | null;
  readonly status: RunStatus;
  readonly reason: string;
}

export interface Report {
  readonly schemaVersion: '1.0';
  readonly kind: 'ci-history-reconciliation';
  readonly repository: string;
  readonly history: {
    /** The audited commit of the ci-history checkout, or null when unknown. */
    readonly commit: string | null;
    readonly records: number;
    readonly valid: boolean;
    readonly problems: readonly string[];
    readonly immutability: 'verified' | 'violated' | 'not-checked';
    readonly immutabilityProblems: readonly string[];
  };
  readonly api: {
    /** The runs listing is complete (pagination, totals, IDs); artifact listings are separate. */
    readonly complete: boolean;
    readonly runsListed: number;
    readonly problems: readonly string[];
    readonly artifactProblems: readonly string[];
  };
  readonly verdict: {
    readonly integrity: 'verified' | 'failed' | 'unverified';
    readonly coverage: 'complete' | 'gaps' | 'undetermined';
    /** Eligible run attempts without a record. */
    readonly missingAttempts: number;
  };
  readonly summary: Readonly<Record<AttemptStatus | RunStatus | 'unlisted-record', number>>;
  readonly attempts: readonly AttemptEntry[];
  readonly runs: readonly RunEntry[];
  readonly unlistedRecords: readonly string[];
}

/**
 * 1: integrity failed. 2: integrity unverified, or coverage gaps or undetermined. 0: integrity
 * verified and coverage complete. See the contract above.
 */
export function exitCode(report: Report): 0 | 1 | 2 {
  if (report.verdict.integrity === 'failed') return 1;
  if (report.verdict.integrity === 'unverified' || report.verdict.coverage !== 'complete') return 2;
  return 0;
}

/** Attempt statuses that mean an eligible attempt has no record. */
const MISSING: readonly AttemptStatus[] = [
  'unpublished-artifacts-retained',
  'unpublished-artifacts-expired',
  'unpublished-legacy-artifacts',
  'unpublished-no-artifacts',
  'metadata-unavailable',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

// ---------------------------------------------------------------- git audit

/**
 * Audits the branch history for the immutability contract, from
 * `git log --reverse --format=%x00%H%x09%P%x09%an <%ae> --name-status --no-renames`: the root
 * commit has no parent and adds only README.md; every later commit has one parent, is authored
 * by the Actions bot (the publisher), adds exactly one record under v1/runs/ and adds or updates
 * v1/index.json, nothing else; no record is ever modified, deleted or added twice.
 */
export const PUBLISHER_IDENTITY =
  'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';

export function auditHistoryLog(log: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const commits = log.split('\0').filter((chunk) => chunk.trim() !== '');
  if (commits.length === 0) return ['the branch has no commits'];
  commits.forEach((chunk, index) => {
    const [header = '', ...changeLines] = chunk.split('\n').filter((line) => line !== '');
    const [sha = '', parents = '', author = ''] = header.split('\t');
    const short = sha.slice(0, 12);
    const parentCount = parents.trim() === '' ? 0 : parents.trim().split(' ').length;
    const changes = changeLines.map((line) => {
      const [status = '', ...paths] = line.split('\t');
      return { status, path: paths.join('\t') };
    });
    if (index === 0) {
      if (parentCount !== 0) problems.push(`${short}: the first commit is not a root commit`);
      for (const c of changes) {
        if (c.path !== 'README.md') problems.push(`${short}: the root commit adds ${c.path}`);
      }
      return;
    }
    if (parentCount !== 1) problems.push(`${short}: has ${String(parentCount)} parents`);
    if (author !== PUBLISHER_IDENTITY)
      problems.push(`${short}: not authored by the publisher (the Actions bot)`);
    const records = changes.filter((c) => /^v1\/runs\/[1-9][0-9]*-[1-9][0-9]*\.json$/.test(c.path));
    for (const c of changes) {
      if (records.includes(c)) {
        if (c.status !== 'A')
          problems.push(`${short}: ${c.path} was ${c.status === 'D' ? 'deleted' : 'modified'}`);
        else if (seen.has(c.path)) problems.push(`${short}: ${c.path} added again`);
        else seen.add(c.path);
      } else if (c.path === 'v1/index.json') {
        if (c.status !== 'A' && c.status !== 'M')
          problems.push(`${short}: v1/index.json was deleted`);
      } else {
        problems.push(`${short}: changes ${c.path}, which is not a run record or the index`);
      }
    }
    if (records.length !== 1) {
      problems.push(
        `${short}: adds ${String(records.length)} records; each commit adds exactly one`,
      );
    }
  });
  return problems;
}

// ---------------------------------------------------------------- API

export interface ApiData {
  /** Every listed run of the CI workflow on main (latest attempt per run). */
  readonly runs: readonly unknown[];
  readonly runsComplete: boolean;
  /** Artifact listings by run ID; absent or null when the listing could not be read in full. */
  readonly artifacts: ReadonlyMap<number, readonly unknown[] | null>;
  /** Problems reading the runs listing. */
  readonly problems: readonly string[];
  /** Problems reading artifact listings (they only explain missing records). */
  readonly artifactProblems: readonly string[];
}

/** One bounded, unauthenticated-or-token GET to api.github.com; null on any failure. */
async function getJson(fetchFn: Fetch, token: string, path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token !== '') headers['Authorization'] = `Bearer ${token}`;
  try {
    const response = await fetchFn(`${API_URL}${path}`, { headers, redirect: 'error' });
    if (response.status !== 200) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_API_RESPONSE_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads the CI workflow's runs on main (paginated, at most MAX_RUN_PAGES pages) and, for each
 * eligible run, its artifact listing. Incomplete pages or failed requests are recorded as
 * problems and make the data incomplete; nothing is guessed.
 */
export async function fetchApiData(
  repository: string,
  token: string,
  fetchFn: Fetch,
): Promise<ApiData> {
  const problems: string[] = [];
  const artifactProblems: string[] = [];
  const runs: unknown[] = [];
  let total: number | undefined;
  for (let page = 1; page <= MAX_RUN_PAGES; page++) {
    const body = await getJson(
      fetchFn,
      token,
      `/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&per_page=100&page=${String(page)}`,
    );
    const list = field(body, 'workflow_runs');
    const count = field(body, 'total_count');
    if (
      !Array.isArray(list) ||
      !(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    ) {
      problems.push(`runs page ${String(page)} could not be read`);
      break;
    }
    total = count;
    runs.push(...(list as unknown[]));
    if (runs.length >= total || list.length === 0) break;
  }
  const runsComplete = total !== undefined && runs.length === total && problems.length === 0;
  if (total !== undefined && runs.length !== total && problems.length === 0) {
    problems.push(`${String(runs.length)} of ${String(total)} runs were listed`);
  }
  const artifacts = new Map<number, readonly unknown[] | null>();
  for (const run of runs) {
    const id = field(run, 'id');
    if (!isPositiveInteger(id) || !eligibility(repository, run).eligible) continue;
    const body = await getJson(
      fetchFn,
      token,
      `/repos/${repository}/actions/runs/${String(id)}/artifacts?per_page=100`,
    );
    const list = field(body, 'artifacts');
    if (Array.isArray(list) && field(body, 'total_count') === list.length) artifacts.set(id, list);
    else {
      artifacts.set(id, null);
      artifactProblems.push(`artifacts of run ${String(id)} could not be read in full`);
    }
  }
  return { runs, runsComplete, artifacts, problems, artifactProblems };
}

// ---------------------------------------------------------------- reconciliation

/** The publisher's eligibility, plus a coarse reason code for runs it refuses. */
export function eligibility(
  repository: string,
  run: unknown,
): { eligible: true } | { eligible: false; status: RunStatus; reason: string } {
  if (field(run, 'status') !== 'completed') {
    return { eligible: false, status: 'pending', reason: 'not completed' };
  }
  try {
    contextFromWorkflowRunEvent(
      { action: 'completed', repository: { full_name: repository }, workflow_run: run },
      WORKFLOW_NAME,
    );
    return { eligible: true };
  } catch (error) {
    if (!(error instanceof ContextError)) throw error;
    const event = field(run, 'event');
    const reason =
      field(field(run, 'head_repository'), 'full_name') !== repository
        ? 'fork'
        : field(field(run, 'repository'), 'full_name') !== repository
          ? 'other repository'
          : event !== 'push' && event !== 'workflow_dispatch'
            ? 'event not recorded'
            : field(run, 'head_branch') !== 'main'
              ? 'not main'
              : field(run, 'name') !== WORKFLOW_NAME
                ? 'other workflow'
                : 'malformed run';
    return { eligible: false, status: 'ineligible', reason };
  }
}

/** Run identity fields of a record that differ from the listed run, by name. */
function identityMismatches(repository: string, record: unknown, run: unknown): string[] {
  const id = field(run, 'id');
  const checks: [string, boolean][] = [
    ['repository', field(record, 'repository') === repository],
    ['workflow', field(record, 'workflow') === WORKFLOW_NAME],
    ['run.id', field(field(record, 'run'), 'id') === id],
    ['run.number', field(field(record, 'run'), 'number') === field(run, 'run_number')],
    ['run.url', field(field(record, 'run'), 'url') === field(run, 'html_url')],
    ['commitSha', field(record, 'commitSha') === field(run, 'head_sha')],
    ['trigger.event', field(field(record, 'trigger'), 'event') === field(run, 'event')],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

/** The hand-off evidence for one attempt that has no record. */
function artifactStatus(
  listing: readonly unknown[] | null | undefined,
  attempt: number,
): { status: AttemptStatus; expiresAt?: string } {
  if (listing === null || listing === undefined) return { status: 'metadata-unavailable' };
  const named = (name: string): unknown[] => listing.filter((a) => field(a, 'name') === name);
  const raw = named(artifactName('snapshot', attempt));
  if (raw.length > 0) {
    const live = raw.find((a) => field(a, 'expired') === false);
    const expires = field(live, 'expires_at');
    return live !== undefined
      ? {
          status: 'unpublished-artifacts-retained',
          ...(typeof expires === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(expires)
            ? { expiresAt: expires }
            : {}),
        }
      : { status: 'unpublished-artifacts-expired' };
  }
  // The M3c archive format used the same names without ".json".
  if (named(artifactName('snapshot', attempt).replace(/\.json$/, '')).length > 0) {
    return { status: 'unpublished-legacy-artifacts' };
  }
  return { status: 'unpublished-no-artifacts' };
}

export function reconcile(input: {
  readonly repository: string;
  readonly tree: HistoryTree;
  readonly historyProblems: readonly string[];
  readonly historyCommit: string | null;
  readonly immutabilityProblems: readonly string[] | null;
  readonly api: ApiData;
}): Report {
  const { repository, tree, api } = input;
  const attempts: AttemptEntry[] = [];
  const runs: RunEntry[] = [];
  const matched = new Set<string>();
  const seenRuns = new Set<number>();
  const apiProblems = [...api.problems];

  for (const run of api.runs) {
    const id = field(run, 'id');
    const number = field(run, 'run_number');
    if (!isPositiveInteger(id)) {
      apiProblems.push('a listed run has no valid ID');
      continue;
    }
    if (seenRuns.has(id)) {
      apiProblems.push(`run ${String(id)} is listed twice`);
      continue;
    }
    seenRuns.add(id);
    const verdict = eligibility(repository, run);
    if (!verdict.eligible) {
      runs.push({
        runId: id,
        runNumber: isPositiveInteger(number) ? number : null,
        status: verdict.status,
        reason: verdict.reason,
      });
      continue;
    }
    const latest = field(run, 'run_attempt') as number; // validated by eligibility
    for (let attempt = 1; attempt <= latest; attempt++) {
      const path = recordPath(id, attempt);
      const text = tree.get(path);
      if (text !== undefined) {
        matched.add(path);
        let record: unknown;
        try {
          record = JSON.parse(text);
        } catch {
          record = undefined;
        }
        const mismatches = identityMismatches(repository, record, run);
        if (field(field(record, 'run'), 'attempt') !== attempt) mismatches.push('run.attempt');
        attempts.push(
          mismatches.length === 0
            ? { runId: id, attempt, runNumber: number as number, status: 'published', path }
            : {
                runId: id,
                attempt,
                runNumber: number as number,
                status: 'inconsistent',
                path,
                mismatches,
              },
        );
        continue;
      }
      const evidence = artifactStatus(api.artifacts.get(id), attempt);
      attempts.push({
        runId: id,
        attempt,
        runNumber: number as number,
        status: evidence.status,
        path,
        ...(evidence.expiresAt === undefined ? {} : { artifactsExpireAt: evidence.expiresAt }),
      });
    }
  }

  const unlistedRecords = [...tree.keys()]
    .filter((p) => /^v1\/runs\//.test(p) && !matched.has(p))
    .sort();
  attempts.sort((a, b) => a.runId - b.runId || a.attempt - b.attempt);
  runs.sort((a, b) => a.runId - b.runId);

  const summary = Object.fromEntries(
    [...ATTEMPT_STATUSES, 'ineligible', 'pending', 'unlisted-record'].map((s) => [s, 0]),
  ) as Record<AttemptStatus | RunStatus | 'unlisted-record', number>;
  for (const a of attempts) summary[a.status]++;
  for (const r of runs) summary[r.status]++;
  summary['unlisted-record'] = unlistedRecords.length;

  const historyValid = input.historyProblems.length === 0;
  const immutability =
    input.immutabilityProblems === null
      ? ('not-checked' as const)
      : input.immutabilityProblems.length === 0
        ? ('verified' as const)
        : ('violated' as const);
  const listingComplete = api.runsComplete && apiProblems.length === 0;
  const missingAttempts = attempts.filter((a) => MISSING.includes(a.status)).length;
  return {
    schemaVersion: '1.0',
    kind: 'ci-history-reconciliation',
    repository,
    history: {
      commit: input.historyCommit,
      records: [...tree.keys()].filter((p) => /^v1\/runs\//.test(p)).length,
      valid: historyValid,
      problems: [...input.historyProblems],
      immutability,
      immutabilityProblems: [...(input.immutabilityProblems ?? [])],
    },
    api: {
      complete: listingComplete,
      runsListed: seenRuns.size,
      problems: apiProblems,
      artifactProblems: [...api.artifactProblems],
    },
    verdict: {
      integrity:
        !historyValid || immutability === 'violated' || summary.inconsistent > 0
          ? 'failed'
          : immutability === 'not-checked'
            ? 'unverified'
            : 'verified',
      coverage: missingAttempts > 0 ? 'gaps' : listingComplete ? 'complete' : 'undetermined',
      missingAttempts,
    },
    summary,
    attempts,
    runs,
    unlistedRecords,
  };
}

/** A Markdown summary of fixed text and the report's validated values. */
export function markdown(report: Report): string {
  const lines = [
    '## CI history reconciliation (read-only)',
    '',
    `**Integrity: ${report.verdict.integrity}. Coverage: ${report.verdict.coverage}${report.verdict.missingAttempts > 0 ? ` (${String(report.verdict.missingAttempts)} eligible run attempt(s) without a record)` : ''}. Exit ${String(exitCode(report))}.**`,
    '',
    `History: ${String(report.history.records)} record(s) at ${report.history.commit ?? 'unknown commit'}; ${report.history.valid ? 'valid' : 'INVALID'}; immutability ${report.history.immutability}. API: ${String(report.api.runsListed)} run(s) listed${report.api.complete ? '' : ' (INCOMPLETE)'}.`,
    '',
    '| Status | Count |',
    '| --- | ---: |',
    ...Object.entries(report.summary).map(([status, count]) => `| ${status} | ${String(count)} |`),
    '',
    '| Run | Attempt | # | Status | Detail |',
    '| ---: | ---: | ---: | --- | --- |',
    ...report.attempts.map(
      (a) =>
        `| ${String(a.runId)} | ${String(a.attempt)} | ${String(a.runNumber)} | ${a.status} | ${a.mismatches?.join(', ') ?? (a.artifactsExpireAt === undefined ? '' : `artifacts expire ${a.artifactsExpireAt}`)} |`,
    ),
    ...report.runs.map(
      (r) =>
        `| ${String(r.runId)} | — | ${r.runNumber === null ? '?' : String(r.runNumber)} | ${r.status} | ${r.reason} |`,
    ),
    '',
  ];
  if (report.unlistedRecords.length > 0) {
    lines.push(`Records whose run the API did not list: ${report.unlistedRecords.join(', ')}`, '');
  }
  const problems = [
    ...report.history.problems,
    ...report.history.immutabilityProblems,
    ...report.api.problems,
    ...report.api.artifactProblems,
  ];
  if (problems.length > 0) lines.push('Problems:', ...problems.map((p) => `- ${p}`), '');
  lines.push(
    'Exit 0: integrity verified and coverage complete. Exit 1: integrity failed (invalid history, immutability violated or an inconsistent record). Exit 2: integrity unverified, or coverage has gaps or is undetermined; a finding, not damage.',
    '',
    '"unpublished-no-artifacts" means no hand-off artifact is listed (the run predates the hand-off, never produced one, or its artifacts expired and were removed); it is not evidence that the run attempt did not happen. This report changes nothing.',
    '',
  );
  return `${lines.join('\n')}\n`;
}
