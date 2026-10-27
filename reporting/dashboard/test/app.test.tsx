import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import snapshotData from 'virtual:dashboard-snapshot';
import { describe, expect, test } from 'vitest';

import { App } from '../src/App';
import type { Snapshot } from '../src/data/types';

// The real snapshot, validated against snapshot.schema.json by the Vite plugin.
const snapshot = snapshotData as Snapshot;
const { summary } = snapshot;

/** Waits until the routed page has rendered (lazy pages load their code first). */
async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('.page-loading')).toBeNull();
    expect(document.querySelector('#main h1')).not.toBeNull();
  });
}

async function go(hash: string): Promise<void> {
  act(() => {
    window.history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await ready();
}

async function renderAt(hash: string) {
  act(() => {
    window.history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  const result = render(<App snapshot={snapshot} />);
  await ready();
  return result;
}

function testCaseRows(): HTMLElement[] {
  const table = screen.getByRole('region', { name: 'Test cases' });
  return within(table).getAllByRole('row').slice(1);
}

describe('Overview', () => {
  test('shows the real counts and linked coverage; without CI history it says so, never "no CI runs"', async () => {
    await renderAt('#/');
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    const key = within(screen.getByLabelText('Key figures'));
    expect(key.getByText(String(summary.requirements))).toBeTruthy();
    expect(key.getByText(String(summary.testCases))).toBeTruthy();
    expect(
      key.getByText(
        `${String(summary.linkedTestCasesWithIntentYes)} of ${String(summary.testCasesByAutomationIntent.Yes)}`,
      ),
    ).toBeTruthy();
    expect(key.getByText('Not included')).toBeTruthy();
    expect(screen.getByText('Execution history is not included in this build')).toBeTruthy();
    expect(screen.queryByText(/No CI runs/)).toBeNull();
  });

  test('every requirement shows "n of m test cases linked", never a bare linked/unlinked label', async () => {
    await renderAt('#/');
    const table = within(screen.getByRole('region', { name: 'Linkage by requirement' }));
    const rows = table.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(snapshot.requirements.length);
    for (const requirement of snapshot.requirements) {
      const cases = snapshot.testCases.filter((tc) => tc.requirementId === requirement.id);
      const linked = cases.filter((tc) => tc.automationLinkage.status === 'linked').length;
      const row = rows.find((r) => r.textContent.includes(requirement.id));
      expect(row?.textContent).toContain(`${String(linked)} of ${String(cases.length)} test case`);
      expect(row?.textContent).not.toMatch(/\b(Not linked|Unlinked)\b/);
    }
  });
});

describe('Meters', () => {
  test('each bar is announced once: named by its label, valued by its text', async () => {
    await renderAt('#/');
    const rows = [...document.querySelectorAll('.meter-row')].filter((row) =>
      row.querySelector('meter'),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const meter = row.querySelector('meter');
      const label = row.querySelector('.meter-label');
      const text = row.querySelector('.meter-text');
      expect(meter?.getAttribute('aria-labelledby')).toBe(label?.id);
      expect(label?.textContent).not.toBe('');
      expect(meter?.getAttribute('aria-valuetext')).toBe(text?.textContent);
      expect(meter?.textContent, 'no duplicate fallback text').toBe('');
      expect(text?.getAttribute('aria-hidden')).toBe('true');
    }
    const funnel = rows.find(
      (row) => row.querySelector('.meter-label')?.textContent === 'Linked automation',
    );
    expect(funnel?.querySelector('meter')?.getAttribute('aria-valuetext')).toBe(
      `${String(summary.linkedTestCasesWithIntentYes)} of ${String(summary.testCasesByAutomationIntent.Yes)} intended`,
    );
  });

  test('the decorative bars in the requirement table are hidden; their label is the text', async () => {
    await renderAt('#/');
    const table = screen.getByRole('region', { name: 'Linkage by requirement' });
    for (const meter of table.querySelectorAll('meter'))
      expect(meter.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Test Case Explorer', () => {
  test('lists all approved test cases', async () => {
    await renderAt('#/test-cases');
    expect(testCaseRows()).toHaveLength(summary.testCases);
    expect(screen.getByRole('status').textContent).toBe(
      `Showing ${String(summary.testCases)} of ${String(summary.testCases)} test cases`,
    );
  });

  test('searches by ID and by scenario text', async () => {
    await renderAt('#/test-cases');
    const search = screen.getByRole('searchbox', { name: 'Search ID or scenario' });
    fireEvent.change(search, { target: { value: 'TC-003-07' } });
    expect(testCaseRows().map((row) => row.querySelector('th')?.textContent)).toEqual([
      'TC-003-07',
    ]);
    fireEvent.change(search, { target: { value: 'FORBIDDEN' } });
    const expected = snapshot.testCases.filter((tc) =>
      tc.scenario.toLowerCase().includes('forbidden'),
    ).length;
    expect(testCaseRows()).toHaveLength(expected);
    expect(document.activeElement === search || document.activeElement === document.body).toBe(
      true,
    );
  });

  test('filters by requirement, level, priority, intent and linkage, and clears', async () => {
    await renderAt('#/test-cases');
    const choose = (label: string, value: string) => {
      fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });
    };
    choose('Level', 'E2E');
    expect(testCaseRows()).toHaveLength(summary.testCasesByLevel.E2E);
    choose('Level', '');
    choose('Priority', 'P0');
    expect(testCaseRows()).toHaveLength(summary.testCasesByPriority.P0);
    choose('Priority', '');
    choose('Automation intent', 'No');
    expect(testCaseRows()).toHaveLength(summary.testCasesByAutomationIntent.No);
    choose('Automation intent', '');
    choose('Automation linkage', 'linked');
    expect(testCaseRows()).toHaveLength(summary.linkedTestCases);
    choose('Requirement', 'REQ-007');
    expect(testCaseRows()).toHaveLength(
      snapshot.testCases.filter(
        (tc) => tc.requirementId === 'REQ-007' && tc.automationLinkage.status === 'linked',
      ).length,
    );
    // Manual-by-design test cases are never linked, so this combination is empty.
    choose('Automation intent', 'No');
    expect(screen.getByText('No test cases match these filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(testCaseRows()).toHaveLength(summary.testCases);
  });

  test('filters are kept in the URL', async () => {
    await renderAt('#/test-cases?level=UI&linkage=not-linked');
    const expected = snapshot.testCases.filter(
      (tc) => tc.level === 'UI' && tc.automationLinkage.status === 'not-linked',
    ).length;
    expect(testCaseRows()).toHaveLength(expected);
  });
});

describe('Test case details', () => {
  test('every approved test case has a detail page with its exact scenario', async () => {
    await renderAt('#/test-cases');
    for (const tc of snapshot.testCases) {
      await go(`#/test-cases/${tc.id}`);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(tc.id);
      expect(document.querySelector('.source-text pre code')?.textContent).toBe(tc.scenario);
      const requirement = snapshot.requirements.find((r) => r.id === tc.requirementId);
      expect(
        screen.getByRole('heading', {
          level: 2,
          name: `${tc.requirementId} — ${requirement?.title ?? ''}`,
        }),
      ).toBeTruthy();
      const instances = document.querySelectorAll('.instance');
      expect(instances).toHaveLength(tc.automationLinkage.testInstanceIds.length);
    }
  });

  test('a linked test case lists its committed instances and the linkage caveat; no CI history here', async () => {
    const tc = snapshot.testCases.find((t) => t.automationLinkage.status === 'linked');
    expect(tc).toBeDefined();
    await renderAt(`#/test-cases/${tc?.id ?? ''}`);
    const instance = snapshot.testInstances.find(
      (i) => i.id === tc?.automationLinkage.testInstanceIds[0],
    );
    expect(
      screen.getByText(`${instance?.file ?? ''}:${String(instance?.line ?? '')}`),
    ).toBeTruthy();
    expect(screen.getByText('Linkage is not full coverage')).toBeTruthy();
    expect(screen.getByText('Execution history is not included in this build')).toBeTruthy();
  });

  test('an unknown test case is reported, not invented', async () => {
    await renderAt('#/test-cases/TC-999-99');
    expect(screen.getByRole('heading', { level: 1, name: 'Test case not found' })).toBeTruthy();
  });
});

describe('Automation intent: No', () => {
  const notAutomated = snapshot.testCases.filter((tc) => tc.automationIntent === 'No');

  test('each such test case links to the plan sections that name it, and nothing else', async () => {
    expect(notAutomated.length).toBe(summary.testCasesByAutomationIntent.No);
    await renderAt('#/');
    for (const tc of notAutomated) {
      await go(`#/test-cases/${tc.id}`);
      const naming = snapshot.testPlan.sections.filter(
        (section) =>
          (section.kind === 'text' && section.markdown.includes(tc.id)) ||
          (section.kind === 'inventory' &&
            section.requirementNotes.some((n) => n.markdown.includes(tc.id))),
      );
      expect(naming.length, `${tc.id} is named in the plan`).toBeGreaterThan(0);
      const reason = screen.getByText('Reason given in the plan').nextElementSibling;
      const links = [...(reason?.querySelectorAll('a') ?? [])].map((a) => a.textContent);
      expect(links).toEqual(naming.map((section) => section.heading));
    }
  });

  test('the plan link opens the named section, not the top of the plan', async () => {
    const tc = notAutomated[0];
    await renderAt(`#/test-cases/${tc?.id ?? ''}`);
    const link = screen
      .getByText('Reason given in the plan')
      .nextElementSibling?.querySelector('a');
    expect(link).toBeTruthy();
    fireEvent.click(link as HTMLAnchorElement);
    await go(link?.getAttribute('href') ?? '');
    expect(document.activeElement?.textContent).toContain(tc?.id ?? '');
  });

  test('no page claims the status is by design, on purpose or permanent', async () => {
    await renderAt('#/');
    const routes = [
      '#/',
      '#/test-plan',
      '#/test-cases',
      '#/how-to-read',
      ...notAutomated.map((tc) => `#/test-cases/${tc.id}`),
    ];
    for (const route of routes) {
      await go(route);
      expect(document.body.textContent, route).not.toMatch(
        /by design|on purpose|manual only|manual-only/i,
      );
    }
    await go('#/');
    expect(
      screen.getByText(
        `${String(summary.testCasesByAutomationIntent.No)} marked Automation: No in the plan`,
      ),
    ).toBeTruthy();
  });
});

describe('Test Plan', () => {
  test('renders the plan metadata, every section and every canonical Purpose/Flow from the snapshot', async () => {
    await renderAt('#/test-plan');
    expect(screen.getByRole('heading', { level: 1, name: snapshot.testPlan.title })).toBeTruthy();
    for (const row of snapshot.testPlan.metadata) expect(screen.getByText(row.item)).toBeTruthy();
    for (const section of snapshot.testPlan.sections) {
      expect(screen.getByRole('heading', { level: 2, name: section.heading })).toBeTruthy();
    }
    for (const canonical of snapshot.canonicals) {
      expect(screen.getByRole('heading', { level: 3, name: canonical.heading })).toBeTruthy();
    }
    const inventory = snapshot.testPlan.sections.find((s) => s.kind === 'inventory');
    for (const note of inventory?.kind === 'inventory' ? inventory.requirementNotes : []) {
      const firstWords =
        note.markdown
          .split('\n')[0]
          ?.replace(/[`*_¹]/g, '')
          .slice(0, 30) ?? '';
      expect(document.body.textContent).toContain(firstWords.trim());
    }
  });
});

describe('Navigation', () => {
  test('AI Agents and Defects are ordinary pages: no placeholder, no "Not connected" tag', async () => {
    await renderAt('#/');
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(nav.queryByText('Not connected')).toBeNull();
    expect(nav.queryByText('Not available yet')).toBeNull();
    for (const [name, hash] of [
      ['AI Agents', '#/ai-agents'],
      ['Defects', '#/defects'],
    ] as const) {
      await go(hash);
      expect(nav.getByRole('link', { name }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('heading', { level: 1, name })).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
      expect(screen.queryByText('This integration is not connected')).toBeNull();
    }
  });

  test('the active page is marked and focus moves to the new page', async () => {
    await renderAt('#/');
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(nav.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    await go('#/test-plan');
    expect(nav.getByRole('link', { name: 'Test Plan' }).getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  test('the mobile menu button controls the navigation', async () => {
    await renderAt('#/');
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button.getAttribute('aria-controls')).toBe('primary-navigation');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('primary-navigation')?.className).toContain('sidebar-open');
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
        name: 'Test Cases',
      }),
    );
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('the skip link moves focus to the content without changing the route', async () => {
    await renderAt('#/test-plan');
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(window.location.hash).toBe('#/test-plan');
    expect(document.activeElement?.id).toBe('main');
  });

  test('Escape closes the mobile menu and returns focus to the menu button', async () => {
    await renderAt('#/');
    const button = screen.getByRole('button', { name: 'Menu' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(button);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('primary-navigation')?.className).not.toContain('sidebar-open');
    expect(document.activeElement).toBe(button);
  });

  test('background content is inert while the mobile menu is open, and only then', async () => {
    await renderAt('#/');
    const main = document.getElementById('main');
    const brand = screen.getByRole('link', { name: /RequestFlow QA Dashboard/ });
    const skip = screen.getByText('Skip to content');
    const nav = document.getElementById('primary-navigation');
    const button = screen.getByRole('button', { name: 'Menu' });
    for (const element of [main, brand, skip]) expect(element?.hasAttribute('inert')).toBe(false);
    fireEvent.click(button);
    for (const element of [main, brand, skip]) expect(element?.hasAttribute('inert')).toBe(true);
    expect(nav?.hasAttribute('inert')).toBe(false);
    expect(button.closest('[inert]')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    for (const element of [main, brand, skip]) expect(element?.hasAttribute('inert')).toBe(false);
  });

  test('choosing a page from the mobile menu closes it and moves focus to the new page', async () => {
    await renderAt('#/');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const link = within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
      name: 'Test Plan',
    });
    fireEvent.click(link);
    await go('#/test-plan');
    expect(document.getElementById('main')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 1, name: snapshot.testPlan.title }),
    );
  });

  test('choosing the current page from the mobile menu moves focus to its heading', async () => {
    await renderAt('#/test-plan');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    fireEvent.click(nav.getByRole('link', { name: 'Test Plan' }));
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  test('unknown routes show a not-found page', async () => {
    await renderAt('#/nowhere');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });
});
