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
      /^Planner agent, Generator agent, Healer agent and Validator are implemented\./,
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
  test('lists exactly the three AI agents, all implemented; the Analyzer is shown only as retired', async () => {
    await renderAgents();
    const rows = rowsOf('AI agents');
    const status = Object.fromEntries(
      rows.map((row): [string, string] => [
        within(row).getByRole('rowheader').firstChild?.textContent ?? '',
        row.querySelector('.badge')?.textContent ?? '',
      ]),
    );
    expect(status).toEqual({
      'Planner agent': 'Implemented',
      'Generator agent': 'Implemented',
      'Healer agent': 'Implemented',
    });
    expect(rows.map((r) => r.querySelector('th .cell-note')?.textContent)).toEqual([
      'AI agent',
      'AI agent',
      'AI agent',
    ]);
    const table = screen.getByRole('region', { name: 'AI agents' }).textContent;
    expect(table).not.toMatch(/Analyzer|Validator|Specified only/);
    expect(mainText()).not.toContain('Specified only');
    expect(mainText()).toContain(
      'The Agent Standard defines exactly three AI agents, each an LLM-backed role that produces one artifact type: Planner, Generator and Healer.',
    );
    expect(mainText()).toContain(
      'The Analyzer agent of Agent Standard 1.x is retired: failure diagnosis is part of the Healer. It was never implemented, and the validator rejects Analyzer and failure-analysis artifacts instead of reinterpreting them.',
    );
    const stats = within(screen.getByLabelText('Agent layer status'));
    expect(stats.getByText('AI agents implemented').nextElementSibling?.textContent).toBe('3 of 3');
  });

  test('"3 of 3" counts the three AI agents; the Validator is shown separately and never counted', async () => {
    await renderAgents();
    const stat = within(screen.getByLabelText('Agent layer status')).getByText(
      'AI agents implemented',
    ).parentElement as HTMLElement;
    expect(stat.querySelector('.stat-detail')?.textContent).toBe(
      'All 3 AI agents defined by the Agent Standard are implemented: Planner, Generator and Healer. The Validator is deterministic code, not an AI agent, and is not counted.',
    );
    const validator = screen.getByRole('heading', {
      name: 'Validator: deterministic safety component',
    }).parentElement as HTMLElement;
    expect(validator.textContent).toContain(
      'The Validator is not an AI agent and is not counted among them: it is deterministic code in the orchestrator that runs the guards, contains no AI and never mutates approved repository state.',
    );
    const term = (name: string) =>
      within(validator).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent ?? '';
    expect(term('Status')).toBe('Implemented Deterministic validator');
    expect(term('Purpose')).toContain('No AI is involved, and it is read-only.');
    expect(validator.textContent).toContain('Never runs proposed code without H7');
    expect(validator.textContent).not.toContain('AI agent,');
  });

  test('the agent count matches the README and the Agent Standard', () => {
    // The register is evidence-checked against both; the counts shown must say the same.
    const ai = AGENT_LAYER.components.filter((c) => c.kind === 'AI agent');
    expect(ai.map((c) => c.id)).toEqual(['planner', 'generator', 'healer']);
    expect(AGENT_LAYER.components.filter((c) => c.kind !== 'AI agent').map((c) => c.id)).toEqual([
      'validator',
    ]);
    expect(AGENT_LAYER.agentRoles.evidence).toContainEqual({
      path: 'agents/standard/standard.md',
      quote: '| Agent | An LLM-backed role (Planner, Generator, Healer) that reads and proposes |',
    });
    expect(
      AGENT_LAYER.agentRoles.evidence.some(
        (e) => e.path === 'README.md' && 'quote' in e && e.quote.includes('**three AI agents**'),
      ),
    ).toBe(true);
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
    expect(values.map((v) => v.textContent)).toEqual(['3 of 3', '7', 'Closed', 'None']);
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
    // Retired components are checked to be absent, and listed separately, never as files.
    const absent = within(
      screen.getByRole('list', { name: 'Paths checked to have no committed files' }),
    )
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(absent).toEqual(['agents/definitions/analyzer', 'agents/orchestrator/analyzer']);
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
    for (const name of ['AI agents', 'Validation guards', 'Human approval gates']) {
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
