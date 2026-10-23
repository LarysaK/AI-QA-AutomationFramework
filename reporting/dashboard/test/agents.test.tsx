import { act, render, screen, waitFor, within } from '@testing-library/react';
import agentData from 'virtual:agent-layer';
import snapshotData from 'virtual:dashboard-snapshot';
import { describe, expect, test } from 'vitest';

import { App } from '../src/App';
import { AGENT_LAYER, type VerifiedAgentLayer } from '../src/data/agents';
import type { ExecutionHistory } from '../src/data/history';
import type { Snapshot } from '../src/data/types';
import fixtureText from './fixtures/ci-history.json?raw';

/**
 * The AI Agents view over the real agent layer facts, as embedded by build/agent-layer-plugin.ts
 * after checking them against the committed files (the plugin itself is tested in
 * test-node/agent-layer-plugin.test.ts). The CI history fixture is the real export at f51780b.
 */

const snapshot = snapshotData as Snapshot;
const agents = agentData as VerifiedAgentLayer;
const HISTORY = JSON.parse(fixtureText) as ExecutionHistory;

async function renderAgents(
  layer: VerifiedAgentLayer | null = agents,
  history: ExecutionHistory | null = HISTORY,
) {
  act(() => {
    window.history.replaceState(null, '', '#/ai-agents');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  const result = render(<App snapshot={snapshot} history={history} agents={layer} />);
  await waitFor(() => {
    expect(document.querySelector('.page-loading')).toBeNull();
    expect(document.querySelector('#main h1')).not.toBeNull();
  });
  return result;
}

const rowsOf = (name: string) =>
  within(screen.getByRole('region', { name })).getAllByRole('row').slice(1);
const mainText = () => document.getElementById('main')?.textContent ?? '';

describe('AI Agents: embedded facts', () => {
  test('the embedded layer is the checked register at a full commit', () => {
    expect(agents.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(agents.layer).toEqual(JSON.parse(JSON.stringify(AGENT_LAYER)));
  });
});

describe('AI Agents: model execution and H7', () => {
  test('states that H7 is closed and real AI model execution is not enabled', async () => {
    await renderAgents();
    expect(screen.getByRole('heading', { level: 1, name: 'AI Agents' })).toBeTruthy();
    const status = within(
      screen.getByRole('complementary', { name: 'Real AI model execution is not enabled' }),
    );
    expect(status.getByText('H7 is closed.')).toBeTruthy();
    expect(status.getByText(/fails if a model API key is set/)).toBeTruthy();
    expect(status.getByText(/No live AI model run is recorded/)).toBeTruthy();

    const stats = within(screen.getByLabelText('Agent layer status'));
    expect(stats.getByText('Execution authorization (H7)').nextElementSibling?.textContent).toBe(
      'Closed',
    );
    expect(stats.getByText('Live AI model runs recorded').nextElementSibling?.textContent).toBe(
      'None',
    );
  });

  test('keeps implemented code, fake-model tests and live AI runs apart', async () => {
    await renderAgents();
    const card = screen.getByRole('heading', {
      name: 'Code, tests, live AI runs and H7 are different things',
    }).parentElement as HTMLElement;
    const term = (name: string) =>
      within(card).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

    expect(term('Implemented agent code')).toMatch(
      /^Generator agent and Validator are implemented\./,
    );
    expect(term('Implemented agent code')).toContain('never run in CI');

    // The latest published CI result of the agent suite, from the record itself.
    const fake = term('Automated tests with a fake model');
    expect(fake).toContain('with a fake model');
    expect(fake).toContain('CI run #17');
    expect(fake).toContain('Agent validation and generator tests: passed, 176 of 176 tests passed');
    expect(fake).toContain('not AI model runs');
    expect(within(card).getByRole('link', { name: 'CI run #17' }).getAttribute('href')).toBe(
      '#/executions/39930898982-1',
    );

    const live = term('Live AI model executions');
    expect(live).toMatch(/^None recorded\. No live AI model run is recorded/);
    expect(live).not.toContain('demonstration');
  });

  test('keeps the historical demonstration, live runs and the current H7 status apart', async () => {
    await renderAgents();
    const card = screen.getByRole('heading', {
      name: 'Code, tests, live AI runs and H7 are different things',
    }).parentElement as HTMLElement;
    const term = (name: string) =>
      within(card).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

    const demo = term('Historical offline demonstration (not a live run)');
    expect(demo).toContain('records one historical offline demonstration');
    expect(demo).toContain('A hand-written test fixture, not model output');
    expect(demo).toContain('for that one exact artifact, by its SHA-256, in a local validator run');
    expect(demo).toContain('It was not a live AI model run, and it did not open H7');
    expect(demo).toContain('is not in effect now');
    expect(demo).not.toMatch(/\bonce\b/);

    const current = term('Current H7 authorization');
    expect(current).toMatch(/^None; H7 is closed\. No execution authorization is in effect/);
    expect(current).toContain('did not open H7 for current use');

    // The status callout and stat say the same, and the stat never says "recorded" for H7.
    const status = screen.getByRole('complementary', {
      name: 'Real AI model execution is not enabled',
    });
    expect(status.textContent).toContain('did not open H7 for current use');
    const stats = within(screen.getByLabelText('Agent layer status'));
    expect(stats.getByText('Execution authorization (H7)').parentElement?.textContent).toContain(
      'None in effect or stored',
    );
    // Credentials are described without naming the environment variable.
    expect(mainText()).toContain('the run fails if a model API key is set');
    expect(mainText()).not.toMatch(/ANTHROPIC_[A-Z_]+/);
  });

  test('without CI history, no suite result is shown or implied', async () => {
    await renderAgents(agents, null);
    expect(mainText()).toContain('CI execution history is not included in this build');
    expect(mainText()).not.toContain('176');
    expect(screen.queryByRole('link', { name: /CI run #/ })).toBeNull();
  });

  test('a run that did not report the agent suite is skipped, and none at all says so', async () => {
    const withoutAgents = structuredClone(HISTORY);
    for (const record of withoutAgents.records) {
      (record as unknown as { suites: unknown[] }).suites = record.suites.filter(
        (s) => s.id !== 'agents',
      );
    }
    await renderAgents(agents, withoutAgents);
    expect(mainText()).toContain('No published CI run has reported the agent suite yet.');
  });
});

describe('AI Agents: components, guards and gates', () => {
  test('lists every component with its real status; only the Generator and Validator are implemented', async () => {
    await renderAgents();
    const rows = rowsOf('Agent layer components');
    const status = Object.fromEntries(
      rows.map((row): [string, string] => [
        within(row).getByRole('rowheader').firstChild?.textContent ?? '',
        row.querySelector('.badge')?.textContent ?? '',
      ]),
    );
    expect(status).toEqual({
      'Generator agent': 'Implemented',
      Validator: 'Implemented',
      'Planner agent': 'Specified only',
      'Analyzer agent': 'Specified only',
      'Healer agent': 'Specified only',
    });
    for (const name of ['Planner agent', 'Analyzer agent', 'Healer agent']) {
      const row = rows.find((r) => r.textContent.startsWith(name));
      expect(row?.textContent).toContain(
        'Not implemented: no agent definition and no orchestrator code.',
      );
    }
    const stats = within(screen.getByLabelText('Agent layer status'));
    expect(stats.getByText('AI agents implemented').nextElementSibling?.textContent).toBe('1 of 4');
  });

  test('"1 of 4" counts the standard\'s four AI agents; the Validator is listed but not counted', async () => {
    await renderAgents();
    // Five components: four AI agents (the standard's LLM-backed roles) and the Validator.
    const rows = rowsOf('Agent layer components');
    expect(rows).toHaveLength(5);
    const kinds = rows.map((r) => r.querySelector('th .cell-note')?.textContent);
    expect(kinds.filter((k) => k === 'AI agent')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'Deterministic orchestrator')).toHaveLength(1);

    const stat = within(screen.getByLabelText('Agent layer status')).getByText(
      'AI agents implemented',
    ).parentElement as HTMLElement;
    const detail = stat.querySelector('.stat-detail')?.textContent;
    expect(detail).toBe(
      'Of the 4 defined by the Agent Standard. Implemented: Generator. Specified only: Planner, Analyzer, Healer. The Validator is deterministic code, not an AI agent.',
    );
    expect(mainText()).toContain(
      'The Agent Standard defines four AI agents, each an LLM-backed role: Planner, Generator, Analyzer and Healer.',
    );
    expect(mainText()).toContain('The table lists all 5: 4 AI agents and the Validator.');
  });

  test('shows the seven guards in order; only G-DISCOVERY and G-RUN run proposed code, after H7', async () => {
    await renderAgents();
    const rows = rowsOf('Validation guards');
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'G-SCHEMA',
      'G-PATHS',
      'G-BASE',
      'G-TRACE',
      'G-STATIC',
      'G-DISCOVERY',
      'G-RUN',
    ]);
    const runs = rows.map((r) => r.children[2]?.textContent);
    expect(runs).toEqual(['No', 'No', 'No', 'No', 'No', 'Yes — H7 required', 'Yes — H7 required']);
    // Backtick spans of the standard are code, not literal backticks.
    expect(mainText()).not.toContain('`');
  });

  test('shows the seven human approval gates; H7 is closed and no approval event is claimed', async () => {
    await renderAgents();
    const rows = rowsOf('Human approval gates');
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'H7',
    ]);
    const h7 = rows[6];
    expect(h7?.textContent).toContain(
      'Execution authorization: before any execution-capable guard runs proposed code',
    );
    expect(h7?.children[2]?.textContent).toMatch(/^Closed\./);
    expect(rows[1]?.textContent).toContain('No apply workflow exists');
    expect(mainText()).toContain(
      'The repository keeps no record of approval or authorization events.',
    );
  });
});

describe('AI Agents: nothing fabricated', () => {
  test('lists what is not recorded, and shows no usage, cost, rate or proposal figures', async () => {
    await renderAgents();
    const notRecorded = screen.getByRole('heading', { name: 'Not recorded in this repository' })
      .parentElement as HTMLElement;
    for (const item of [
      'Agent execution history',
      'Model usage, tokens and costs',
      'AI-generated proposals',
      'Approval events',
      'Live AI success rates',
    ]) {
      expect(notRecorded.textContent).toContain(item);
    }
    const text = mainText();
    expect(text).not.toMatch(/%|\$|€/);
    expect(text).not.toMatch(/\d[\d,]*\s*(tokens|calls|proposals|approvals)/i);
    expect(text).not.toMatch(/authorized by|approved by/i);
    // The only figures: counts of the register's own components and guards, and two statuses.
    const values = [...screen.getByLabelText('Agent layer status').querySelectorAll('.stat-value')];
    expect(values.map((v) => v.textContent)).toEqual(['1 of 4', '7', 'Closed', 'None']);
  });

  test('cites committed files as evidence, and names the commit they were checked at', async () => {
    await renderAgents();
    const evidence = screen.getByRole('heading', { name: 'Evidence' }).parentElement as HTMLElement;
    expect(evidence.textContent).toContain(agents.commit);
    const listed = within(evidence)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(listed).toContain('agents/standard/standard.md');
    expect(listed).toContain('.github/workflows/ci.yml');
    // Absent components are listed separately, never as files.
    const absent = within(
      screen.getByRole('list', { name: 'Paths checked to have no committed files' }),
    )
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(absent).toEqual([
      'agents/definitions/analyzer',
      'agents/definitions/healer',
      'agents/definitions/planner',
      'agents/orchestrator/analyzer',
      'agents/orchestrator/healer',
      'agents/orchestrator/planner',
    ]);
    expect(listed.filter((path) => absent.includes(path))).toEqual(absent);
    expect(listed.every((path) => !path.startsWith('/') && !path.includes('..'))).toBe(true);
  });

  test('without the checked facts, the page says they are not included and shows none', async () => {
    await renderAgents(null);
    expect(screen.getByText('Agent layer facts are not included in this build')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Validation guards' })).toBeNull();
    expect(mainText()).not.toContain('Implemented');
  });
});

describe('AI Agents: accessibility', () => {
  test('tables are labelled, focusable scroll regions with row and column headers', async () => {
    await renderAgents();
    for (const name of ['Agent layer components', 'Validation guards', 'Human approval gates']) {
      const region = screen.getByRole('region', { name });
      expect(region.getAttribute('tabindex')).toBe('0');
      expect(within(region).getAllByRole('columnheader').length).toBeGreaterThan(2);
      expect(within(region).getAllByRole('rowheader').length).toBeGreaterThan(2);
    }
    const levels = [...document.querySelectorAll('#main h1, #main h2, #main h3')].map((h) =>
      Number(h.tagName[1]),
    );
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++)
      expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
  });
});
