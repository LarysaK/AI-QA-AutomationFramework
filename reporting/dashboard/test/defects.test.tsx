import { act, render, screen, waitFor, within } from '@testing-library/react';
import agentData from 'virtual:agent-layer';
import snapshotData from 'virtual:dashboard-snapshot';
import { describe, expect, test } from 'vitest';

import { App } from '../src/App';
import type { VerifiedAgentLayer } from '../src/data/agents';
import { type DefectSource, NOT_CONNECTED, validateDefectSource } from '../src/data/defects';
import type { ExecutionHistory } from '../src/data/history';
import type { Snapshot } from '../src/data/types';
import fixtureText from './fixtures/ci-history.json?raw';

/**
 * The Defects view. No defect source exists, so the real build is not connected. The connected
 * sources below are TEST-ONLY data made up inside these tests to exercise the display contract
 * for a future verified register; they are never part of a build.
 */

const snapshot = snapshotData as Snapshot;
const agents = agentData as VerifiedAgentLayer;
const HISTORY = JSON.parse(fixtureText) as ExecutionHistory;
const tc = snapshot.testCases[0];
if (tc === undefined) throw new Error('the snapshot has no test cases');

const connected = (records: unknown[]): DefectSource =>
  ({
    status: 'connected',
    system: 'Test tracker',
    retrievedAt: '2026-10-20T08:00:00Z',
    records,
  }) as DefectSource;

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'TEST-1',
  title: 'Test-only record title',
  status: 'In Review',
  severity: 'Major',
  requirementIds: [tc.requirementId],
  testCaseIds: [tc.id],
  url: 'https://tracker.example/browse/TEST-1',
  updatedAt: '2026-10-19T12:30:00Z',
  ...overrides,
});

async function renderDefects(defects?: DefectSource, history: ExecutionHistory | null = HISTORY) {
  act(() => {
    window.history.replaceState(null, '', '#/defects');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  const result = render(
    <App
      snapshot={snapshot}
      history={history}
      agents={agents}
      {...(defects === undefined ? {} : { defects })}
    />,
  );
  await waitFor(() => {
    expect(document.querySelector('.page-loading')).toBeNull();
    expect(document.querySelector('#main h1')).not.toBeNull();
  });
  return result;
}

const mainText = () => document.getElementById('main')?.textContent ?? '';

describe('Defects: no register connected (the real build)', () => {
  test('an intentional empty state that never claims the product has no defects', async () => {
    await renderDefects();
    expect(screen.getByRole('heading', { level: 1, name: 'Defects' })).toBeTruthy();
    const empty = screen.getByRole('complementary', { name: 'No defect register is connected' });
    expect(empty.textContent).toContain(
      'An empty list here is not evidence that the product has no defects',
    );
    expect(screen.queryByRole('region', { name: 'Defect records' })).toBeNull();
    expect(mainText()).not.toMatch(/\b0 defects\b|no defects found|defect-free/i);
  });

  test('failed CI results are not turned into defects', async () => {
    const failing = structuredClone(HISTORY);
    const first = failing.records[0];
    if (first === undefined) throw new Error('fixture has no records');
    (first as { conclusion: string }).conclusion = 'failure';
    const results = first.playwright?.results ?? [];
    for (const result of results) (result as { status: string }).status = 'failed';
    await renderDefects(undefined, failing);
    expect(screen.queryByRole('region', { name: 'Defect records' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    const never = screen.getByRole('heading', { name: 'What is never shown as a defect' })
      .parentElement as HTMLElement;
    expect(never.textContent).toContain('A failed test is an execution result');
    expect(within(never).getByRole('link', { name: 'Executions' }).getAttribute('href')).toBe(
      '#/executions',
    );
  });

  test("agents' defect candidates are explained from the standard, not shown as defects", async () => {
    await renderDefects();
    expect(mainText()).toContain(agents.layer.defectCandidates.text);
    expect(mainText()).toContain('Proposals stay outside the repository and are not shown.');
  });

  test('describes the fields a connected register must provide', async () => {
    await renderDefects();
    const future = screen.getByRole('heading', { name: 'When a defect register is connected' })
      .parentElement as HTMLElement;
    for (const term of [
      'Identifier and title',
      'Status and severity',
      'Traceability',
      'Provenance',
    ]) {
      expect(within(future).getByText(term, { selector: 'dt' })).toBeTruthy();
    }
  });
});

describe('Defects: a verified register (test-only data)', () => {
  test('shows identifiers, status, severity, traceability and provenance exactly as given', async () => {
    await renderDefects(
      connected([
        record(),
        record({ id: 'TEST-2', severity: null, url: null, requirementIds: [], testCaseIds: [] }),
      ]),
    );
    expect(mainText()).toContain(
      '2 defect records from Test tracker, exported 2026-10-20 08:00 UTC',
    );
    const rows = within(screen.getByRole('region', { name: 'Defect records' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    const link = within(first).getByRole('link', { name: /TEST-1/ });
    expect(link.getAttribute('href')).toBe('https://tracker.example/browse/TEST-1');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(first.textContent).toContain('In Review');
    expect(first.textContent).toContain('Major');
    expect(first.textContent).toContain(tc.requirementId);
    expect(within(first).getByRole('link', { name: tc.id }).getAttribute('href')).toBe(
      `#/test-cases/${tc.id}`,
    );
    expect(first.textContent).toContain('2026-10-19 12:30 UTC');
    expect(within(second).queryByRole('link')).toBeNull();
    expect(second.children[3]?.textContent).toBe('—');
  });

  test('a connected register with no records is still not evidence of zero defects', async () => {
    await renderDefects(connected([]));
    expect(mainText()).toContain('Test tracker returned no defect records');
    expect(mainText()).toContain('That is not evidence that the product has no defects.');
  });

  test.each([
    ['an unknown test case', { testCaseIds: ['TC-999-99'] }],
    ['an unknown requirement', { requirementIds: ['REQ-999'] }],
    ['a made-up identifier', { id: 'defect one' }],
    ['a missing status', { status: '' }],
    ['a non-https link', { url: 'javascript:alert(1)' }],
    ['an extra field', { aiGenerated: true }],
    ['a local timestamp', { updatedAt: '2026-10-19 12:30' }],
  ])('malformed data (%s) is rejected and nothing is shown', async (_, overrides) => {
    await renderDefects(connected([record(), record({ id: 'TEST-2', ...overrides })]));
    expect(screen.getByText('The defect data did not pass validation')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Defect records' })).toBeNull();
    expect(mainText()).not.toContain('Test-only record title');
  });
});

describe('validateDefectSource', () => {
  test('accepts "not connected" and a valid register', () => {
    expect(validateDefectSource(NOT_CONNECTED, snapshot)).toEqual([]);
    expect(validateDefectSource(connected([record()]), snapshot)).toEqual([]);
  });

  test.each([
    ['null', null],
    ['an array', []],
    ['an unknown status', { status: 'live' }],
    ['"not connected" with records', { status: 'not-connected', records: [] }],
    ['records that are not a list', { ...connected([]), records: {} }],
    ['a record that is not an object', connected(['TEST-1'])],
    ['a duplicate identifier', connected([record(), record()])],
    ['a missing system', { ...connected([]), system: '' }],
  ])('rejects %s', (_, value) => {
    expect(validateDefectSource(value, snapshot).length).toBeGreaterThan(0);
  });

  test('problems name fields, never values', () => {
    const problems = validateDefectSource(
      connected([record({ title: '', url: 'http://secret.example' })]),
      snapshot,
    );
    expect(problems.join('\n')).not.toContain('secret.example');
  });
});
