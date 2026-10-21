import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunContext } from './context';
import { parseInstant } from './history';

/**
 * Artifact hand-off from a CI run to the history workflow (Phase 5.3 M3c). Pure decisions over
 * Actions API responses, plus one bounded reader for downloaded artifact folders.
 *
 * Binding to the run attempt: the Actions API reports which run an artifact belongs to
 * (`workflow_run.id`) but not which attempt uploaded it. The CI workflow therefore names each
 * artifact after its attempt (`ci-snapshot-attempt-<n>`), and an artifact is accepted only if
 *
 *   - it is the only artifact of the triggering run with that exact name (duplicates and
 *     unexpected names are refused, never resolved by picking one),
 *   - its run, commit and branch are the triggering run's, from the same repository,
 *   - it was created while that attempt's Verify job ran (with clock tolerance),
 *   - it has not expired, has a sha256 digest and is within the size limit, and
 *   - the job's upload step for it succeeded.
 *
 * The artifact is then downloaded by its ID only; the download action verifies the archive
 * against the digest the API reports. That digest is transport integrity (the bytes are the
 * bytes the run uploaded), not authentication and not proof that test results are true.
 *
 * An absent artifact is "never produced" only when the job itself says so: its upload step was
 * skipped, and for the snapshot the API also shows that the step generating it failed, was
 * cancelled or was skipped (a generated snapshot whose upload was skipped is an error). Absent
 * suite results are "never produced" when their upload was skipped; the record composer then
 * refuses a successful run without them, so no counts or success are ever inferred. Any other
 * absence, a duplicate or a contradiction is an error.
 *
 * Known limitation (ZIP extraction), a mandatory security review item before M3d introduces any
 * write-capable publishing workflow: the pinned actions/download-artifact (v8.0.2, using
 * @actions/artifact 6.3.1 and unzip-stream) extracts the archive while streaming it and compares
 * the ZIP digest only after extraction has finished; a mismatch fails the step, but the files
 * are already on disk. The archive-size limit (`size_in_bytes`, checked before download) bounds
 * the compressed size only: it does not prevent a decompression bomb, and the extracted file's
 * size is checked (readArtifactFile) only after extraction. The action itself neutralizes `..`
 * path components and creates no symbolic links. In this read-only dry run the impact is limited
 * to the job's disk and its 15-minute timeout.
 */

export type ArtifactKind = 'snapshot' | 'suites';
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['snapshot', 'suites'];

export interface ArtifactSpec {
  /** Name prefix; the run attempt follows. */
  readonly prefix: string;
  /** The single file inside the artifact. */
  readonly file: string;
  /** The CI job step that uploads it (.github/workflows/ci.yml). */
  readonly uploadStep: string;
  /** The step that produces the file; for the snapshot, its conclusion decides "never produced". */
  readonly producerStep: string;
  /** Largest accepted archive and extracted file. */
  readonly maxBytes: number;
}

export const ARTIFACTS: Readonly<Record<ArtifactKind, ArtifactSpec>> = {
  snapshot: {
    prefix: 'ci-snapshot-attempt-',
    file: 'dashboard-data.json',
    uploadStep: 'Upload dashboard snapshot',
    producerStep: 'Generate dashboard snapshot',
    maxBytes: 8 * 1024 * 1024,
  },
  suites: {
    prefix: 'ci-suite-results-attempt-',
    file: 'suite-results.json',
    uploadStep: 'Upload suite results',
    producerStep: 'Collect suite results',
    maxBytes: 4 * 1024 * 1024,
  },
};

/** Largest accepted Actions API response. */
export const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Clock tolerance between the artifact service and the job timestamps. */
export const ARTIFACT_CLOCK_TOLERANCE_MS = 120_000;
const VERIFY_JOB = 'Verify';

export const artifactName = (kind: ArtifactKind, attempt: number): string =>
  `${ARTIFACTS[kind].prefix}${String(attempt)}`;

export class HandoffError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`CI artifact hand-off refused:\n  ${problems.join('\n  ')}`);
    this.name = 'HandoffError';
    this.problems = problems;
  }
}

export type ArtifactDecision =
  | {
      readonly state: 'download';
      readonly name: string;
      readonly id: number;
      readonly sizeInBytes: number;
      readonly digest: string;
    }
  | { readonly state: 'not-produced'; readonly name: string; readonly reason: string };

export interface Resolution {
  readonly schemaVersion: '1.0';
  readonly kind: 'ci-handoff';
  readonly runId: number;
  readonly runAttempt: number;
  readonly runNumber: number;
  /** True only when the snapshot exists: a record is never composed without it. */
  readonly recordable: boolean;
  readonly snapshot: ArtifactDecision;
  readonly suites: ArtifactDecision;
}

export interface ApiInputs {
  /** GET /repos/{repo}/actions/runs/{id}/attempts/{attempt} */
  readonly run: unknown;
  /** GET /repos/{repo}/actions/runs/{id}/attempts/{attempt}/jobs */
  readonly jobs: unknown;
  /** GET /repos/{repo}/actions/runs/{id}/artifacts?name=<exact name>, per kind */
  readonly listings: Readonly<Record<ArtifactKind, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const STEP_CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped'];

/** Decides, for the triggering run attempt, which artifacts to download and which never existed. */
export function resolveHandoff(context: RunContext, api: ApiInputs): Resolution {
  const problems: string[] = [];
  const check = (condition: boolean, problem: string): void => {
    if (!condition) problems.push(problem);
  };
  const fail = (): never => {
    throw new HandoffError(problems);
  };

  // The attempt, as the Actions API reports it, must be the triggering one.
  const run = api.run;
  check(field(run, 'id') === context.runId, 'run: id does not match the triggering run');
  check(
    field(run, 'run_attempt') === context.runAttempt,
    'run: attempt does not match the triggering attempt',
  );
  check(field(run, 'run_number') === context.runNumber, 'run: number does not match');
  check(field(run, 'status') === 'completed', 'run: the attempt has not completed');
  check(field(run, 'head_sha') === context.headSha, 'run: head_sha does not match');
  check(field(run, 'head_branch') === 'main', 'run: head_branch is not main');
  check(field(run, 'event') === context.event, 'run: event does not match');
  check(field(run, 'name') === context.workflow, 'run: workflow name does not match');
  check(
    field(field(run, 'repository'), 'full_name') === context.repository,
    'run: repository does not match',
  );
  check(
    field(field(run, 'head_repository'), 'full_name') === context.repository,
    'run: head repository differs (a fork)',
  );

  // Exactly one completed Verify job of this attempt, on a complete page.
  const allJobs = field(api.jobs, 'jobs');
  check(
    Array.isArray(allJobs) && field(api.jobs, 'total_count') === allJobs.length,
    'jobs: the response is not a complete list of jobs',
  );
  const jobs = Array.isArray(allJobs) ? allJobs.filter((j) => field(j, 'name') === VERIFY_JOB) : [];
  check(
    jobs.length === 1,
    `jobs: expected exactly one "${VERIFY_JOB}" job, found ${String(jobs.length)}`,
  );
  if (problems.length > 0) fail();
  const job: unknown = jobs[0];
  check(field(job, 'run_id') === context.runId, 'job: run does not match');
  check(field(job, 'run_attempt') === context.runAttempt, 'job: attempt does not match');
  check(field(job, 'status') === 'completed', 'job: has not completed');
  const started = parseInstant(String(field(job, 'started_at')));
  const completed = parseInstant(String(field(job, 'completed_at')));
  check(
    started !== null && completed !== null && started <= completed,
    'job: start or completion time is missing or malformed',
  );
  const steps = field(job, 'steps');
  check(Array.isArray(steps), 'job: steps are missing');
  if (problems.length > 0) fail();

  const window = {
    from: (started ?? 0) - ARTIFACT_CLOCK_TOLERANCE_MS,
    to: (completed ?? 0) + ARTIFACT_CLOCK_TOLERANCE_MS,
  };
  const stepConclusion = (name: string): unknown => {
    const matches = (steps as unknown[]).filter((s) => field(s, 'name') === name);
    if (matches.length !== 1) {
      problems.push(
        `job: expected exactly one step "${name}", found ${String(matches.length)}` +
          (matches.length === 0 ? ' (a CI workflow without the M3c hand-off?)' : ''),
      );
      return undefined;
    }
    const step = matches[0];
    if (field(step, 'status') !== 'completed') {
      problems.push(`job: step "${name}" did not complete`);
      return undefined;
    }
    const conclusion = field(step, 'conclusion');
    if (!STEP_CONCLUSIONS.includes(conclusion as string)) {
      problems.push(`job: step "${name}" has an unknown conclusion`);
      return undefined;
    }
    return conclusion;
  };

  const decide = (kind: ArtifactKind): ArtifactDecision | undefined => {
    const spec = ARTIFACTS[kind];
    const name = artifactName(kind, context.runAttempt);
    const before = problems.length;
    const upload = stepConclusion(spec.uploadStep);
    const found = artifactsNamed(api.listings[kind], name, problems);
    if (problems.length > before || upload === undefined || found === undefined) return undefined;

    if (upload === 'skipped') {
      if (found.length > 0) {
        problems.push(`${name}: the upload step was skipped, yet the artifact exists`);
        return undefined;
      }
      if (kind === 'snapshot') {
        // Never produced only if the API confirms the snapshot was not generated.
        const producer = stepConclusion(spec.producerStep);
        if (producer === undefined) return undefined;
        if (producer === 'success') {
          problems.push(
            `${name}: step "${spec.producerStep}" succeeded but the upload was skipped; refusing to treat the snapshot as never produced`,
          );
          return undefined;
        }
        return {
          state: 'not-produced',
          name,
          reason: `the CI job did not generate the snapshot (step "${spec.producerStep}": ${producer as string}); a run record needs the snapshot, so none is composed`,
        };
      }
      const producer = (steps as unknown[]).find((s) => field(s, 'name') === spec.producerStep);
      // Diagnostic only; a known conclusion is echoed, anything else is reported as unknown.
      const reported = field(producer, 'conclusion');
      const producerConclusion = STEP_CONCLUSIONS.includes(reported as string)
        ? (reported as string)
        : 'unknown';
      return {
        state: 'not-produced',
        name,
        reason: `the CI job produced no validated suite results (step "${spec.producerStep}": ${producerConclusion}); suites are recorded as incomplete, without counts`,
      };
    }
    if (upload !== 'success') {
      problems.push(
        `${name}: the upload step concluded "${upload as string}"; refusing the artifact`,
      );
      return undefined;
    }
    if (found.length !== 1) {
      problems.push(
        found.length === 0
          ? `${name}: the upload step succeeded but the artifact is missing (expired or deleted?)`
          : `${name}: ${String(found.length)} artifacts share this name; refusing to choose one`,
      );
      return undefined;
    }
    const artifact = found[0];
    const id = field(artifact, 'id');
    const size = field(artifact, 'size_in_bytes');
    const digest = field(artifact, 'digest');
    const origin = field(artifact, 'workflow_run');
    const created = parseInstant(String(field(artifact, 'created_at')));
    check(isPositiveInteger(id), `${name}: id is missing or malformed`);
    check(field(artifact, 'expired') === false, `${name}: has expired`);
    check(
      isPositiveInteger(size) && size <= spec.maxBytes,
      `${name}: size is missing or larger than ${String(spec.maxBytes)} bytes`,
    );
    check(typeof digest === 'string' && DIGEST.test(digest), `${name}: has no sha256 digest`);
    check(field(origin, 'id') === context.runId, `${name}: belongs to another run`);
    check(field(origin, 'head_sha') === context.headSha, `${name}: belongs to another commit`);
    check(field(origin, 'head_branch') === 'main', `${name}: belongs to another branch`);
    check(
      isPositiveInteger(field(origin, 'repository_id')) &&
        field(origin, 'repository_id') === field(origin, 'head_repository_id'),
      `${name}: comes from another (head) repository`,
    );
    check(
      created !== null && created >= window.from && created <= window.to,
      `${name}: was not created during this attempt's ${VERIFY_JOB} job (another attempt?)`,
    );
    if (problems.length > before) return undefined;
    return {
      state: 'download',
      name,
      id: id as number,
      sizeInBytes: size as number,
      digest: digest as string,
    };
  };

  const snapshot = decide('snapshot');
  const suites = decide('suites');
  if (problems.length > 0 || snapshot === undefined || suites === undefined) fail();
  return {
    schemaVersion: '1.0',
    kind: 'ci-handoff',
    runId: context.runId,
    runAttempt: context.runAttempt,
    runNumber: context.runNumber,
    recordable: (snapshot as ArtifactDecision).state === 'download',
    snapshot: snapshot as ArtifactDecision,
    suites: suites as ArtifactDecision,
  };
}

/** The artifacts of an exact-name listing; an incomplete page or a foreign name is an error. */
function artifactsNamed(listing: unknown, name: string, problems: string[]): unknown[] | undefined {
  const artifacts = field(listing, 'artifacts');
  if (!Array.isArray(artifacts) || field(listing, 'total_count') !== artifacts.length) {
    problems.push(`${name}: the artifact listing is not a complete list`);
    return undefined;
  }
  if (artifacts.some((a) => field(a, 'name') !== name)) {
    problems.push(`${name}: the listing contains artifacts with other names`);
    return undefined;
  }
  return artifacts as unknown[];
}

/**
 * The one expected file of a downloaded artifact folder. The folder must contain exactly that
 * regular file (no links, no other entries) within the size limit.
 */
export function readArtifactFile(dir: string, kind: ArtifactKind): string {
  const spec = ARTIFACTS[kind];
  const where = `${spec.prefix}<attempt>`;
  let entries: string[];
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error('not a directory');
    entries = readdirSync(dir);
  } catch {
    throw new HandoffError([`${where}: the downloaded folder is missing`]);
  }
  if (entries.length !== 1 || entries[0] !== spec.file) {
    throw new HandoffError([
      `${where}: expected exactly one file "${spec.file}", found ${String(entries.length)} entries`,
    ]);
  }
  const path = join(dir, spec.file);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new HandoffError([`${where}: ${spec.file} is not a regular file`]);
  if (stat.size > spec.maxBytes) {
    throw new HandoffError([
      `${where}: ${spec.file} is larger than ${String(spec.maxBytes)} bytes`,
    ]);
  }
  const bytes = readFileSync(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HandoffError([`${where}: ${spec.file} is not valid UTF-8`]);
  }
}

/** The Actions API requests for one run attempt (paths relative to the API root). */
export function apiRequests(context: RunContext): Record<'run' | 'jobs' | ArtifactKind, string> {
  const base = `/repos/${context.repository}/actions/runs/${String(context.runId)}`;
  const listing = (kind: ArtifactKind): string =>
    `${base}/artifacts?name=${encodeURIComponent(artifactName(kind, context.runAttempt))}&per_page=100`;
  return {
    run: `${base}/attempts/${String(context.runAttempt)}`,
    jobs: `${base}/attempts/${String(context.runAttempt)}/jobs?per_page=100`,
    snapshot: listing('snapshot'),
    suites: listing('suites'),
  };
}

export type Fetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: 'error' },
) => Promise<{ status: number; text: () => Promise<string> }>;

export const API_URL = 'https://api.github.com';

/**
 * Fetches the API inputs for one attempt. Only GET requests to api.github.com, no redirects,
 * bounded responses; the token is sent in a header and never appears in errors.
 */
export async function fetchApiInputs(
  context: RunContext,
  token: string,
  fetchFn: Fetch,
): Promise<ApiInputs> {
  if (token === '') throw new HandoffError(['GITHUB_TOKEN is not set']);
  const requests = apiRequests(context);
  const get = async (key: keyof typeof requests): Promise<unknown> => {
    const response = await fetchFn(`${API_URL}${requests[key]}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
    });
    if (response.status !== 200) {
      throw new HandoffError([`API ${key} request failed with HTTP ${String(response.status)}`]);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_API_RESPONSE_BYTES) {
      throw new HandoffError([
        `API ${key} response is larger than ${String(MAX_API_RESPONSE_BYTES)} bytes`,
      ]);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new HandoffError([`API ${key} response is not JSON`]);
    }
  };
  return {
    run: await get('run'),
    jobs: await get('jobs'),
    listings: { snapshot: await get('snapshot'), suites: await get('suites') },
  };
}
