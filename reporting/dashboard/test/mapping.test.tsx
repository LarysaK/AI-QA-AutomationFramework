import { act, render, screen, waitFor, within } from '@testing-library/react';
import snapshotData from 'virtual:dashboard-snapshot';
import { describe, expect, test } from 'vitest';

import { App, PageLoadError } from '../src/App';
import { type ExecutionHistory, mapResults, resultKey, type RunRecord } from '../src/data/history';
import type { Snapshot, TestInstance } from '../src/data/types';
import fixtureText from './fixtures/ci-history.json?raw';

/**
 * The contract that relates a run's Playwright results to test cases (data/history.ts mapResults),
 * over the real export of ci-history at f51780b and the real snapshot. Every variant (commit,
 * Playwright version, duplicates, foreign IDs, stale tags) is derived here and says so.
 */

const snapshot = snapshotData as Snapshot;
const FIXTURE = JSON.parse(fixtureText) as ExecutionHistory;

/** The newest record, made a run of the snapshot's commit and Playwright version (derived). */
function matchingRecord(): RunRecord {
  const record = structuredClone(FIXTURE.records[0]) as RunRecord & {
    commitSha: string;
    environment: { playwright: string | null };
  };
  record.commitSha = snapshot.source.commit;
  record.environment.playwright = snapshot.source.discovery.playwrightVersion;
  return record;
}
const results = (record: RunRecord) => record.playwright?.results ?? [];
/** Replaces a record's Playwright results (test-only mutation of a cloned record). */
const setResults = (record: RunRecord, list: unknown[]): void => {
  (record as unknown as { playwright: { results: unknown[] } }).playwright.results = list;
};
/** A linked instance and one of its test cases from the real snapshot. */
function linkedInstance(s: Snapshot = snapshot): { instance: TestInstance; testCase: string } {
  for (const instance of s.testInstances) {
    const testCase = instance.tags.testCases.find((tc) =>
      s.testCases.some(
        (c) =>
          c.id === tc &&
          c.automationLinkage.status === 'linked' &&
          c.automationLinkage.testInstanceIds.includes(instance.id),
      ),
    );
    if (testCase !== undefined) return { instance, testCase };
  }
  throw new Error('the snapshot has no linked instance');
}

describe('mapping: when results may be related to test cases', () => {
  test('a run of the snapshot commit and Playwright version maps every committed instance', () => {
    const record = matchingRecord();
    const mapping = mapResults(record, snapshot);
    expect(mapping.status).toBe('mapped');
    const { instance, testCase } = linkedInstance();
    const link = mapping.links.get(
      resultKey({ instanceId: instance.id, project: instance.projects[0] ?? '' }),
    );
    expect(link?.kind).toBe('mapped');
    if (link?.kind === 'mapped') {
      expect(link.instance.id).toBe(instance.id);
      expect(link.testCases).toContain(testCase);
      expect(link.unconfirmed).toEqual([]);
    }
  });

  test('a run of another commit is never mapped, even with identical instance IDs (derived)', () => {
    const record = { ...matchingRecord(), commitSha: 'f'.repeat(40) };
    expect(mapResults(record, snapshot)).toEqual({
      status: 'unavailable',
      reason: 'other-commit',
      links: new Map(),
    });
  });

  test('a run with another (or an unknown) Playwright version is never mapped (derived)', () => {
    for (const playwright of ['0.0.1', null]) {
      const record = matchingRecord();
      (record.environment as { playwright: string | null }).playwright = playwright;
      expect(mapResults(record, snapshot).reason).toBe('other-playwright-version');
    }
  });

  test('a run without Playwright results maps nothing (derived)', () => {
    const record = { ...matchingRecord(), playwright: null };
    expect(mapResults(record, snapshot).reason).toBe('no-results');
  });
});

describe('mapping: ambiguous, unmatched and stale relationships', () => {
  test('a result reported twice is ambiguous; neither copy is mapped (derived)', () => {
    const record = matchingRecord();
    const first = results(record)[0];
    expect(first).toBeDefined();
    setResults(record, [...results(record), { ...first }]);
    const link = mapResults(record, snapshot).links.get(
      resultKey(first ?? { instanceId: '', project: '' }),
    );
    expect(link).toEqual({ kind: 'ambiguous', why: 'reported more than once in this run' });
  });

  test('an instance ID that two committed instances share is ambiguous (derived)', () => {
    const { instance } = linkedInstance();
    const doubled = structuredClone(snapshot) as Snapshot & { testInstances: TestInstance[] };
    doubled.testInstances.push({ ...instance, title: `${instance.title} (copy)` });
    const link = mapResults(matchingRecord(), doubled).links.get(
      resultKey({ instanceId: instance.id, project: instance.projects[0] ?? '' }),
    );
    expect(link).toEqual({
      kind: 'ambiguous',
      why: 'more than one committed test instance has this ID',
    });
  });

  test('a result whose ID is not a committed instance is unmatched, even with a matching title (derived)', () => {
    const record = matchingRecord();
    const first = results(record)[0];
    expect(first).toBeDefined();
    const foreign = {
      ...(first ?? { project: 'chromium', status: 'passed', attempts: 1 }),
      instanceId: 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb',
    };
    setResults(record, [foreign]);
    expect(mapResults(record, snapshot).links.get(resultKey(foreign))).toEqual({
      kind: 'unmatched',
      why: 'not a committed test instance of this snapshot',
    });
  });

  test('a result for a project the instance is not configured for is unmatched (derived)', () => {
    const record = matchingRecord();
    const first = results(record)[0];
    const other = {
      ...(first ?? { instanceId: '', status: 'passed', attempts: 1 }),
      project: 'webkit',
    };
    setResults(record, [other]);
    expect(mapResults(record, snapshot).links.get(resultKey(other))).toEqual({
      kind: 'unmatched',
      why: 'project is not configured for this test instance',
    });
  });

  test('a @TC tag the snapshot linkage does not confirm is never claimed (derived)', () => {
    const { instance, testCase } = linkedInstance();
    const stale = structuredClone(snapshot);
    const tc = stale.testCases.find((c) => c.id === testCase) as unknown as {
      automationLinkage: { testInstanceIds: string[] };
    };
    tc.automationLinkage.testInstanceIds = tc.automationLinkage.testInstanceIds.filter(
      (id) => id !== instance.id,
    );
    const link = mapResults(matchingRecord(), stale).links.get(
      resultKey({ instanceId: instance.id, project: instance.projects[0] ?? '' }),
    );
    expect(link?.kind).toBe('mapped');
    if (link?.kind === 'mapped') {
      expect(link.testCases).not.toContain(testCase);
      expect(link.unconfirmed).toContain(testCase);
    }
  });

  test('a linkage that lists an instance without its @TC tag is never claimed either (derived)', () => {
    const { instance, testCase } = linkedInstance();
    const untagged = structuredClone(snapshot);
    const copy = untagged.testInstances.find((i) => i.id === instance.id) as unknown as {
      tags: { testCases: string[] };
    };
    copy.tags.testCases = copy.tags.testCases.filter((t) => t !== testCase);
    const link = mapResults(matchingRecord(), untagged).links.get(
      resultKey({ instanceId: instance.id, project: instance.projects[0] ?? '' }),
    );
    if (link?.kind === 'mapped') expect(link.testCases).not.toContain(testCase);
  });
});

describe('mapping in the UI', () => {
  async function renderAt(hash: string, history: ExecutionHistory) {
    act(() => {
      window.history.replaceState(null, '', hash);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const result = render(<App snapshot={snapshot} history={history} />);
    await waitFor(() => {
      expect(document.querySelector('.page-loading')).toBeNull();
      expect(document.querySelector('#main h1')).not.toBeNull();
    });
    return result;
  }
  const historyWith = (record: RunRecord): ExecutionHistory => ({
    ...FIXTURE,
    records: [record, ...FIXTURE.records.slice(1)],
  });

  test('ambiguous and unmatched results are listed by ID with the reason, without test cases (derived)', async () => {
    const record = matchingRecord();
    const first = results(record)[0];
    const foreign = {
      ...(first ?? { project: 'chromium', status: 'passed', attempts: 1 }),
      instanceId: 'cccccccccccccccccccc-dddddddddddddddddddd',
    };
    setResults(record, [...results(record), { ...first }, foreign]);
    await renderAt(
      `#/executions/${String(record.run.id)}-${String(record.run.attempt)}`,
      historyWith(record),
    );
    const table = within(screen.getByRole('region', { name: 'Playwright test results' }));
    expect(table.getAllByText(/Ambiguous: reported more than once in this run/)).toHaveLength(2);
    expect(
      table.getByText(/Not mapped: not a committed test instance of this snapshot/),
    ).toBeTruthy();
    const foreignRow = table.getByText(foreign.instanceId).closest('tr');
    expect(foreignRow?.querySelector('a')).toBeNull();
  });

  test('a test case shows no result when the run used another Playwright version (derived)', async () => {
    const record = matchingRecord();
    (record.environment as { playwright: string | null }).playwright = '0.0.1';
    const { testCase } = linkedInstance();
    await renderAt(`#/test-cases/${testCase}`, historyWith(record));
    expect(screen.getByText('CI results are not mapped to this test case')).toBeTruthy();
    expect(
      screen.getByText(/used a different Playwright version than the snapshot’s discovery/),
    ).toBeTruthy();
    expect(screen.queryByText(/In published CI run/)).toBeNull();
  });

  test('a test case shows exactly its own confirmed results for a matching run (derived)', async () => {
    const { testCase } = linkedInstance();
    await renderAt(`#/test-cases/${testCase}`, historyWith(matchingRecord()));
    expect(screen.getByText(/In published CI run/)).toBeTruthy();
    expect(screen.getAllByText('passed').length).toBeGreaterThan(0);
    expect(screen.queryByText(/not mapped/)).toBeNull();
  });
});

describe('lazy pages: loading and failure', () => {
  test('a page shows a polite loading status while its code loads', async () => {
    act(() => {
      window.history.replaceState(null, '', '#/test-plan');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    render(<App snapshot={snapshot} history={FIXTURE} />);
    const status = screen.queryByRole('status');
    if (status !== null) expect(status.textContent).toBe('Loading…');
    expect(
      await screen.findByRole('heading', { level: 1, name: snapshot.testPlan.title }),
    ).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('a page whose code fails to load says so, and the next page loads normally', () => {
    function Broken(): never {
      throw new Error('chunk failed to load');
    }
    const original = console.error;
    console.error = () => undefined; // React logs caught render errors; expected here.
    try {
      const { rerender } = render(
        <PageLoadError path="/test-plan">
          <Broken />
        </PageLoadError>,
      );
      expect(
        screen.getByRole('heading', { level: 1, name: 'This page could not be loaded' }),
      ).toBeTruthy();
      rerender(
        <PageLoadError path="/test-cases">
          <h1>Next page</h1>
        </PageLoadError>,
      );
      expect(screen.getByRole('heading', { level: 1, name: 'Next page' })).toBeTruthy();
    } finally {
      console.error = original;
    }
  });
});

describe('Overview: published CI runs and coverage, kept apart', () => {
  async function overview(history: ExecutionHistory) {
    act(() => {
      window.history.replaceState(null, '', '#/');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    render(<App snapshot={snapshot} history={history} />);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
  }
  const withCoverage = (
    change: Partial<NonNullable<ExecutionHistory['coverage']>> | null,
  ): ExecutionHistory => ({
    ...FIXTURE,
    coverage:
      change === null || FIXTURE.coverage === null ? null : { ...FIXTURE.coverage, ...change },
  });

  test('the metric counts published records only, never a fraction of eligible runs', async () => {
    await overview(FIXTURE);
    const key = within(screen.getByLabelText('Key figures'));
    const stat = key.getByText('Published CI runs').closest('.stat');
    expect(stat?.querySelector('.stat-value')?.textContent).toBe('2');
    expect(stat?.textContent).not.toMatch(/ of \d/);
  });

  const sentences: [string, ExecutionHistory, RegExp][] = [
    [
      'gaps',
      FIXTURE,
      /7 eligible run attempts have no published record; that does not mean they failed\./,
    ],
    [
      'one gap with an incomplete listing',
      withCoverage({ missingAttempts: 1, listingComplete: false }),
      /1 eligible run attempt has no published record; that does not mean it failed\. The runs listing was incomplete/,
    ],
    [
      'complete',
      withCoverage({ verdict: 'complete', missingAttempts: 0, unpublished: [] }),
      /Every eligible CI run attempt that GitHub Actions listed is published\./,
    ],
    [
      'undetermined',
      withCoverage({
        verdict: 'undetermined',
        missingAttempts: 0,
        unpublished: [],
        listingComplete: false,
      }),
      /No unpublished eligible run attempt is known, but coverage is undetermined\./,
    ],
    [
      'not checked',
      withCoverage(null),
      /Coverage of unpublished CI runs was not checked for this build\./,
    ],
  ];
  for (const [name, history, text] of sentences) {
    test(`coverage ${name} is stated as such`, async () => {
      await overview(history);
      expect(screen.getByText(text)).toBeTruthy();
      expect(within(screen.getByLabelText('Key figures')).getByText('2')).toBeTruthy();
    });
  }
});
