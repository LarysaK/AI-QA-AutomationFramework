import { act, render, screen, waitFor, within } from '@testing-library/react';
import snapshotData from 'virtual:dashboard-snapshot';
import { describe, expect, test } from 'vitest';

import { App } from '../src/App';
import {
  type ExecutionHistory,
  formatDuration,
  formatInstant,
  type RunRecord,
  safeRunUrl,
  testTotals,
} from '../src/data/history';
import type { Snapshot } from '../src/data/types';
import fixtureText from './fixtures/ci-history.json?raw';

/**
 * The Executions view over a real CI history export: fixtures/ci-history.json is the output of
 * reporting/ci/history-export-cli.ts for the ci-history branch at f51780b (two published runs,
 * #15 and #17) with the read-only reconciliation of that commit. Variants (commit changes, a
 * foreign URL, no coverage, no records) are derived inside the tests, which say so.
 */

const snapshot = snapshotData as Snapshot;
const FIXTURE = JSON.parse(fixtureText) as ExecutionHistory;
const clone = (): ExecutionHistory => structuredClone(FIXTURE);
const REPO = 'LarysaK/AI-QA-AutomationFramework';

/** Renders at a route and waits until the routed page has rendered (lazy pages load first). */
async function renderAt(hash: string, history: ExecutionHistory | null) {
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

/** The newest record with its commit changed (derived). */
function withCommit(sha: string): ExecutionHistory {
  const history = clone();
  (history.records[0] as { commitSha: string }).commitSha = sha;
  return history;
}

describe('Executions: published runs (real export)', () => {
  test('lists the published runs newest first, with freshness and no live claim', async () => {
    await renderAt('#/executions', FIXTURE);
    expect(screen.getByRole('heading', { level: 1, name: 'Executions' })).toBeTruthy();
    expect(screen.getByText(/read from the/).textContent).toMatch(
      /ci-history branch at commit f51780b, last updated 2026-10-23 09:25 UTC\. This is a snapshot taken when the dashboard was built; it does not update live\./,
    );
    const rows = within(screen.getByRole('region', { name: 'Published runs' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => within(r).getAllByRole('rowheader')[0]?.textContent)).toEqual([
      '#17',
      '#15',
    ]);
    expect(rows[0]?.textContent).toContain('2026-10-23 09:24 UTC');
    expect(rows[0]?.textContent).toContain('Success');
    expect(rows[0]?.textContent).toContain('305 of 305');
  });

  test('summary figures come only from published records', async () => {
    await renderAt('#/executions', FIXTURE);
    const stats = within(screen.getByLabelText('Published CI runs'));
    expect(stats.getByText('2')).toBeTruthy();
    expect(stats.getByText('#17')).toBeTruthy();
    expect(stats.getByText('2 success')).toBeTruthy();
    expect(stats.getByText('Of published runs only')).toBeTruthy();
    expect(screen.queryByText(/pass rate|success rate/i)).toBeNull();
  });

  test('coverage: published versus eligible attempts, unpublished runs never shown as failed', async () => {
    await renderAt('#/executions', FIXTURE);
    expect(screen.getByText('2 of 9 eligible run attempts are published')).toBeTruthy();
    const unpublished = within(
      screen.getByRole('region', { name: 'Eligible runs without a published record' }),
    );
    const rows = unpublished.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7);
    expect(rows[0]?.textContent).toContain('#13');
    expect(rows[0]?.textContent).toContain('it ran before the publisher existed');
    expect(unpublished.queryByText(/failed/i)).toBeNull();
    expect(screen.getByText(/A run without a record did not necessarily fail/)).toBeTruthy();
    expect(screen.getByText(/is not evidence that a run did not happen/)).toBeTruthy();
  });

  test('without a reconciliation, coverage is reported as not checked', async () => {
    const history = { ...clone(), coverage: null };
    await renderAt('#/executions', history);
    expect(screen.getByText('Coverage was not checked for this build')).toBeTruthy();
    expect(
      screen.getByText(/some CI runs may be missing here\. A missing run is not a failed run\./),
    ).toBeTruthy();
  });

  test('an incomplete runs listing (API unavailable) gives no "n of m" coverage figure', async () => {
    // As exported when the Actions API answered nothing: integrity verified, nothing listed.
    const history = clone();
    const coverage = {
      ...(history.coverage as NonNullable<ExecutionHistory['coverage']>),
      listingComplete: false,
      runsListed: 0,
      verdict: 'undetermined' as const,
      missingAttempts: 0,
      unpublished: [],
    };
    await renderAt('#/executions', { ...history, coverage });
    const card = screen.getByRole('heading', { name: 'Coverage of CI runs' })
      .parentElement as HTMLElement;
    expect(card.textContent).toContain('GitHub Actions listed 0 runs');
    expect(card.textContent).toContain('(an incomplete listing)');
    expect(within(card).getByText('Coverage could not be determined.')).toBeTruthy();
    expect(card.textContent).toContain('eligible runs missing from the listing cannot be counted');
    expect(card.textContent).not.toMatch(/\d+ of \d+ eligible/);
  });

  test('an export with no records says so, and keeps the coverage', async () => {
    const history = { ...clone(), records: [], source: { ...FIXTURE.source, records: 0 } };
    await renderAt('#/executions', history);
    expect(screen.getByText('No published CI runs yet')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Published runs' })).toBeNull();
    expect(screen.getByText('Coverage of CI runs')).toBeTruthy();
  });

  test('a build without the history says it is not included, never that no CI runs exist', async () => {
    await renderAt('#/executions', null);
    expect(screen.getByText('Execution history is not included in this build')).toBeTruthy();
    expect(screen.getByText(/That does not mean no CI runs exist/)).toBeTruthy();
    expect(screen.queryByText(/No published CI runs/)).toBeNull();
  });
});

describe('Executions: links', () => {
  test('each run links to its detail page and to exactly its GitHub Actions run', async () => {
    await renderAt('#/executions', FIXTURE);
    expect(screen.getByRole('link', { name: '#17' }).getAttribute('href')).toBe(
      '#/executions/39930898982-1',
    );
    const external = screen.getAllByRole('link', { name: /View run/ });
    expect(external.map((a) => a.getAttribute('href'))).toEqual([
      `https://github.com/${REPO}/actions/runs/39930898982`,
      `https://github.com/${REPO}/actions/runs/39843212300`,
    ]);
    for (const a of external) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('a run URL that is not this repository’s exact run URL is never rendered as a link (derived)', async () => {
    for (const url of [
      'javascript:alert(1)',
      'https://github.com/someone/else/actions/runs/39930898982',
      `https://github.com/${REPO}/actions/runs/1`,
      `http://github.com/${REPO}/actions/runs/39930898982`,
    ]) {
      const history = clone();
      (history.records[0] as { run: { url: string } }).run.url = url;
      const { unmount } = await renderAt('#/executions', history);
      expect(screen.getAllByRole('link', { name: /View run/ })).toHaveLength(1);
      expect(document.querySelector(`a[href="${url}"]`)).toBeNull();
      unmount();
    }
  });

  test('safeRunUrl accepts only the exact URL for this repository and run', () => {
    const record = FIXTURE.records[0] as RunRecord;
    expect(safeRunUrl(record, REPO)).toBe(`https://github.com/${REPO}/actions/runs/39930898982`);
    expect(safeRunUrl(record, 'someone/else')).toBeNull();
    expect(safeRunUrl(record, 'bad repo')).toBeNull();
  });
});

describe('Executions: run detail', () => {
  test('shows the run metadata, suite counts and the AI-suite caveat', async () => {
    await renderAt('#/executions/39930898982-1', FIXTURE);
    expect(screen.getByRole('heading', { level: 1, name: 'Run #17' })).toBeTruthy();
    expect(screen.getAllByText(/^3c33bee/).length).toBeGreaterThan(0);
    const suites = within(screen.getByRole('region', { name: 'Test suites' }));
    const agents = suites.getByRole('rowheader', { name: /Agent validation and generator tests/ });
    expect(agents.textContent).toContain('with a fake model. They make no live AI model calls.');
    expect(agents.closest('tr')?.textContent).toContain('176');
    expect(
      screen.getByText(/it is a CI test suite, not a record of live AI model runs/),
    ).toBeTruthy();
    expect(screen.getByText('Open the original run').closest('a')?.getAttribute('href')).toBe(
      `https://github.com/${REPO}/actions/runs/39930898982`,
    );
  });

  test('a run of another commit lists results by instance ID, never mapped to test cases (derived)', async () => {
    await renderAt('#/executions/39930898982-1', withCommit('f'.repeat(40)));
    const table = within(screen.getByRole('region', { name: 'Playwright test results' }));
    expect(table.queryByRole('columnheader', { name: 'Test cases' })).toBeNull();
    expect(table.getAllByRole('row').slice(1)).toHaveLength(30);
    expect(
      screen.getByText(/this run tested a different commit than this dashboard’s snapshot/),
    ).toBeTruthy();
    expect(screen.getByText(/Instances are listed by ID\./)).toBeTruthy();
    expect(table.queryByRole('link')).toBeNull();
  });

  test('a run of the snapshot commit shows each instance with its committed test and test cases (derived)', async () => {
    await renderAt('#/executions/39930898982-1', withCommit(snapshot.source.commit));
    const table = within(screen.getByRole('region', { name: 'Playwright test results' }));
    expect(table.getByRole('columnheader', { name: 'Test cases' })).toBeTruthy();
    const instance = snapshot.testInstances[0];
    expect(instance).toBeDefined();
    if (instance !== undefined && instance.tags.testCases[0] !== undefined) {
      expect(
        table.getAllByRole('link', { name: instance.tags.testCases[0] }).length,
      ).toBeGreaterThan(0);
    }
  });

  test('an unknown run is reported, not invented', async () => {
    await renderAt('#/executions/1-1', FIXTURE);
    expect(screen.getByRole('heading', { level: 1, name: 'Run not found' })).toBeTruthy();
    const { unmount } = await renderAt('#/executions/39930898982-1', null);
    expect(
      screen.getAllByRole('heading', { level: 1, name: 'Run not found' }).length,
    ).toBeGreaterThan(0);
    unmount();
  });
});

describe('Executions elsewhere in the dashboard', () => {
  test('the overview summarizes the latest published run and its coverage', async () => {
    await renderAt('#/', FIXTURE);
    const key = within(screen.getByLabelText('Key figures'));
    expect(key.getByText('Published CI runs')).toBeTruthy();
    expect(key.getByText('Latest #17 · Success')).toBeTruthy();
    expect(screen.getByText(/7 eligible run attempts have no published record/)).toBeTruthy();
    expect(screen.getByText(/Not measured per test case/)).toBeTruthy();
  });

  test('a test case shows its own instance results only for a published run of the snapshot commit (derived)', async () => {
    const tc = snapshot.testCases.find((t) => t.automationLinkage.status === 'linked');
    expect(tc).toBeDefined();
    const id = tc?.id ?? '';
    const { unmount } = await renderAt(`#/test-cases/${id}`, withCommit(snapshot.source.commit));
    expect(screen.getByText(/In published CI run/)).toBeTruthy();
    expect(screen.getAllByText('passed').length).toBeGreaterThan(0);
    unmount();
    await renderAt(`#/test-cases/${id}`, withCommit('f'.repeat(40)));
    expect(screen.getByText('No published CI run of this commit')).toBeTruthy();
    expect(
      screen.getByText(/Results of runs of other commits are not mapped to test cases/),
    ).toBeTruthy();
  });

  test('the navigation lists Executions as available', async () => {
    await renderAt('#/executions', FIXTURE);
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    const link = nav.getByRole('link', { name: 'Executions' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.textContent).not.toContain('Not connected');
  });
});

describe('Executions: helpers', () => {
  test('dates are UTC and locale-independent; durations are readable', () => {
    expect(formatInstant('2026-10-23T09:24:08Z')).toBe('2026-10-23 09:24 UTC');
    expect(formatInstant('not a date')).toBe('—');
    expect(formatDuration(340000)).toBe('5 min 40 s');
    expect(formatDuration(4568)).toBe('5 s');
    expect(formatDuration(null)).toBe('—');
  });

  test('test totals add only suites that reported counts, and say when one did not (derived)', () => {
    const record = structuredClone(FIXTURE.records[0]) as RunRecord;
    expect(testTotals(record)).toEqual({
      passed: 305,
      failed: 0,
      flaky: 0,
      total: 305,
      complete: true,
    });
    (record.suites[0] as { counts: unknown }).counts = null;
    expect(testTotals(record)).toEqual({
      passed: 129,
      failed: 0,
      flaky: 0,
      total: 129,
      complete: false,
    });
  });
});
