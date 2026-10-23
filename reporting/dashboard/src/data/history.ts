import type { Snapshot, TestInstance } from './types';

/**
 * The published CI execution history (build-time export of the ci-history branch, validated by
 * build/history-plugin.ts) and pure helpers over it. Everything shown is taken from published
 * records; nothing is inferred: no per-test-case outcome from suite counts, no failure from a
 * missing record, and no claim that published records are every CI run.
 */

export type SuiteId = 'agents' | 'dashboard-data' | 'dashboard-frontend' | 'playwright';
export type SuiteState = 'passed' | 'flaky' | 'failed' | 'not-run' | 'incomplete';
export type Conclusion = 'success' | 'failure' | 'cancelled' | 'timed_out';
export type ResultStatus = 'passed' | 'failed' | 'flaky' | 'skipped';
export type UnpublishedStatus =
  | 'unpublished-artifacts-retained'
  | 'unpublished-artifacts-expired'
  | 'unpublished-legacy-artifacts'
  | 'unpublished-no-artifacts'
  | 'metadata-unavailable';

export interface Counts {
  readonly passed: number | null;
  readonly failed: number | null;
  readonly flaky: number | null;
  readonly skipped: number | null;
  readonly todo: number | null;
  readonly cancelled: number | null;
  readonly total: number | null;
}

export interface RunSuite {
  readonly id: SuiteId;
  readonly state: SuiteState;
  readonly counts: Counts | null;
  readonly durationMs: number | null;
  readonly startedAt: string | null;
}

export interface RunResult {
  readonly instanceId: string;
  readonly project: string;
  readonly status: ResultStatus;
  readonly attempts: number;
}

export interface RunRecord {
  readonly repository: string;
  readonly workflow: string;
  readonly job: string;
  readonly run: {
    readonly id: number;
    readonly attempt: number;
    readonly number: number;
    readonly url: string;
  };
  readonly trigger: { readonly event: 'push' | 'workflow_dispatch'; readonly ref: string };
  readonly commitSha: string;
  readonly conclusion: Conclusion;
  readonly timestamps: {
    readonly runCreatedAt: string;
    readonly jobStartedAt: string;
    readonly jobCompletedAt: string;
  };
  readonly environment: {
    readonly runnerLabel: string | null;
    readonly node: string | null;
    readonly playwright: string | null;
  };
  readonly steps: readonly { readonly name: string; readonly conclusion: string }[];
  readonly suites: readonly RunSuite[];
  readonly playwright: {
    readonly failOnFlakyTests: boolean;
    readonly globalErrors: number;
    readonly results: readonly RunResult[];
  } | null;
}

export interface Coverage {
  readonly commit: string;
  readonly listingComplete: boolean;
  readonly runsListed: number;
  readonly verdict: 'complete' | 'gaps' | 'undetermined';
  readonly missingAttempts: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly unpublished: readonly {
    readonly runId: number;
    readonly attempt: number;
    readonly runNumber: number;
    readonly status: UnpublishedStatus;
  }[];
}

export interface ExecutionHistory {
  readonly source: {
    readonly repository: string;
    readonly branch: 'ci-history';
    readonly commit: string;
    readonly committedAt: string;
    readonly records: number;
  };
  readonly coverage: Coverage | null;
  /** Newest first. */
  readonly records: readonly RunRecord[];
}

/** The CI step names (.github/workflows/ci.yml) and what each suite is. */
export const SUITES: Readonly<Record<SuiteId, { readonly label: string; readonly about: string }>> =
  {
    agents: {
      label: 'Agent validation and generator tests',
      about:
        'Unit and integration tests of the AI agent layer: the deterministic validation guards and the Generator, with a fake model. They make no live AI model calls.',
    },
    'dashboard-data': {
      label: 'Dashboard data tests',
      about: 'Tests of the snapshot builder behind this dashboard.',
    },
    'dashboard-frontend': {
      label: 'Dashboard tests',
      about: 'Tests of this dashboard’s user interface.',
    },
    playwright: {
      label: 'Playwright tests',
      about: 'The RequestFlow product tests (API, UI and end-to-end), run against the application.',
    },
  };

export const UNPUBLISHED: Readonly<Record<UnpublishedStatus, string>> = {
  'unpublished-artifacts-retained':
    'Not published. Its hand-off artifacts are still retained, but it ran before the publisher existed.',
  'unpublished-artifacts-expired': 'Not published. Its hand-off artifacts have expired.',
  'unpublished-legacy-artifacts':
    'Not published. It only has artifacts in an older format that the publisher does not accept.',
  'unpublished-no-artifacts':
    'Not published, and no hand-off artifact is listed (it predates the hand-off, or its artifacts expired and were removed).',
  'metadata-unavailable': 'Not published; its artifact listing could not be read.',
};

export const runKey = (record: RunRecord): string =>
  `${String(record.run.id)}-${String(record.run.attempt)}`;

export const runPath = (record: RunRecord): string => `/executions/${runKey(record)}`;

/** The record's GitHub Actions run URL, only if it is exactly this repository's run URL. */
export function safeRunUrl(record: RunRecord, repository: string): string | null {
  const expected = `https://github.com/${repository}/actions/runs/${String(record.run.id)}`;
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository) && record.run.url === expected
    ? expected
    : null;
}

/** "2026-10-23 09:24 UTC", independent of the viewer's locale and time zone. */
export function formatInstant(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const d = new Date(time).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)} min ${String(seconds % 60)} s`;
}

export function jobDurationMs(record: RunRecord): number | null {
  const start = Date.parse(record.timestamps.jobStartedAt);
  const end = Date.parse(record.timestamps.jobCompletedAt);
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start;
}

/** Test totals across suites that reported counts; `complete` is false if any suite did not. */
export function testTotals(record: RunRecord): {
  passed: number;
  failed: number;
  flaky: number;
  total: number;
  complete: boolean;
} {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let total = 0;
  let complete = true;
  for (const suite of record.suites) {
    if (suite.counts === null || suite.counts.total === null) {
      complete = false;
      continue;
    }
    passed += suite.counts.passed ?? 0;
    failed += suite.counts.failed ?? 0;
    flaky += suite.counts.flaky ?? 0;
    total += suite.counts.total;
  }
  return { passed, failed, flaky, total, complete };
}

export function suiteStates(record: RunRecord): Record<SuiteState, number> {
  const states: Record<SuiteState, number> = {
    passed: 0,
    flaky: 0,
    failed: 0,
    'not-run': 0,
    incomplete: 0,
  };
  for (const suite of record.suites) states[suite.state]++;
  return states;
}

export function conclusions(history: ExecutionHistory): Record<Conclusion, number> {
  const counts: Record<Conclusion, number> = { success: 0, failure: 0, cancelled: 0, timed_out: 0 };
  for (const record of history.records) counts[record.conclusion]++;
  return counts;
}

export const CONCLUSION_LABEL: Readonly<Record<Conclusion, string>> = {
  success: 'Success',
  failure: 'Failure',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
};

export function findRun(history: ExecutionHistory, key: string): RunRecord | undefined {
  return history.records.find((record) => runKey(record) === key);
}

/**
 * How a run's Playwright results relate to this dashboard's test cases. A result is mapped to
 * test cases only when every link is exact; otherwise it is shown as an execution result without a
 * test-case claim. Titles are never compared, and suite counts are never used.
 *
 *   1. The run tested exactly the snapshot's commit.
 *   2. The run used the snapshot's Playwright version (Playwright computes the instance IDs).
 *   3. The result's (instance ID, project) is reported once in the run.
 *   4. Exactly one committed test instance of the snapshot has that ID, and the project is one the
 *      instance is configured for.
 *   5. A test case is claimed only if the instance carries its @TC tag AND the snapshot's linkage
 *      for that test case lists the instance (both directions agree, so stale tags never count).
 */
export type MappingReason = 'other-commit' | 'other-playwright-version' | 'no-results';

export type ResultLink =
  | {
      readonly kind: 'mapped';
      readonly instance: TestInstance;
      /** Confirmed in both directions; may be empty when the instance has no confirmed test case. */
      readonly testCases: readonly string[];
      /** @TC tags on the instance that the snapshot's linkage does not confirm. */
      readonly unconfirmed: readonly string[];
    }
  | { readonly kind: 'unmatched' | 'ambiguous'; readonly why: string };

export interface ResultMapping {
  readonly status: 'mapped' | 'unavailable';
  readonly reason: MappingReason | null;
  /** By result key (see resultKey); empty when unavailable. */
  readonly links: ReadonlyMap<string, ResultLink>;
}

export const resultKey = (result: { instanceId: string; project: string }): string =>
  `${result.instanceId}\u0000${result.project}`;

export function mapResults(record: RunRecord, snapshot: Snapshot): ResultMapping {
  const unavailable = (reason: MappingReason): ResultMapping => ({
    status: 'unavailable',
    reason,
    links: new Map(),
  });
  if (record.commitSha !== snapshot.source.commit) return unavailable('other-commit');
  const version = record.environment.playwright;
  if (version === null || version !== snapshot.source.discovery.playwrightVersion) {
    return unavailable('other-playwright-version');
  }
  const results = record.playwright?.results ?? [];
  if (results.length === 0) return unavailable('no-results');

  const instances = new Map<string, TestInstance[]>();
  for (const instance of snapshot.testInstances) {
    instances.set(instance.id, [...(instances.get(instance.id) ?? []), instance]);
  }
  const linkage = new Map(
    snapshot.testCases.map((tc) => [
      tc.id,
      tc.automationLinkage.status === 'linked' ? tc.automationLinkage.testInstanceIds : [],
    ]),
  );
  const reported = new Map<string, number>();
  for (const result of results) {
    reported.set(resultKey(result), (reported.get(resultKey(result)) ?? 0) + 1);
  }

  const links = new Map<string, ResultLink>();
  for (const result of results) {
    const key = resultKey(result);
    const candidates = instances.get(result.instanceId) ?? [];
    let link: ResultLink;
    if ((reported.get(key) ?? 0) > 1) {
      link = { kind: 'ambiguous', why: 'reported more than once in this run' };
    } else if (candidates.length > 1) {
      link = { kind: 'ambiguous', why: 'more than one committed test instance has this ID' };
    } else if (candidates[0] === undefined) {
      link = { kind: 'unmatched', why: 'not a committed test instance of this snapshot' };
    } else if (!candidates[0].projects.includes(result.project)) {
      link = { kind: 'unmatched', why: 'project is not configured for this test instance' };
    } else {
      const instance = candidates[0];
      const confirmed = instance.tags.testCases.filter(
        (tc) => linkage.get(tc)?.includes(instance.id) === true,
      );
      link = {
        kind: 'mapped',
        instance,
        testCases: confirmed,
        unconfirmed: instance.tags.testCases.filter((tc) => !confirmed.includes(tc)),
      };
    }
    links.set(key, link);
  }
  return { status: 'mapped', reason: null, links };
}

export const MAPPING_REASON: Readonly<Record<MappingReason, string>> = {
  'other-commit': 'this run tested a different commit than this dashboard’s snapshot',
  'other-playwright-version':
    'this run used a different Playwright version than the snapshot’s discovery, so instance IDs may differ',
  'no-results': 'this run recorded no Playwright results',
};
