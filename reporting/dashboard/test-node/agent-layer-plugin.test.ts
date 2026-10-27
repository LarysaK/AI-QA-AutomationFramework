// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  EXECUTION_CAPABLE_GUARDS,
  GUARD_ORDER,
} from '../../../agents/orchestrator/validation/validate';
import {
  type CommittedFiles,
  gitCommittedFiles,
  verifiedAgentLayer,
  verifyAgentLayer,
} from '../build/agent-layer-plugin';
import { AGENT_LAYER, type AgentLayer, allEvidence } from '../src/data/agents';

/**
 * The agent layer facts are checked against committed files before they are embedded. The real
 * facts must hold at this repository's HEAD; each kind of drift (a changed quote, a component
 * that appears, a file that disappears, text that appears in CI, a table row that is not shown,
 * an unsafe path or value) must fail.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const real = gitCommittedFiles(REPO_ROOT);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The real commit's files, with some replaced or removed. */
function filesWith(changes: Record<string, string | null>, extra: string[] = []): CommittedFiles {
  return {
    commit: real.commit,
    read: (path) => (path in changes ? (changes[path] ?? null) : real.read(path)),
    list: (path) => [
      ...real.list(path),
      ...extra.filter((p) => p === path || p.startsWith(`${path}/`)),
    ],
  };
}

const layerWith = (change: (layer: AgentLayer) => void): AgentLayer => {
  const copy = structuredClone<AgentLayer>(AGENT_LAYER);
  change(copy);
  return copy;
};

const STANDARD = 'agents/standard/standard.md';
const standardText = (): string => real.read(STANDARD) ?? '';

describe('agent layer: the real facts', () => {
  test('every statement holds at HEAD', () => {
    expect(verifyAgentLayer(AGENT_LAYER, real)).toEqual([]);
  });

  test('the guards match the validator’s own order and execution-capable set', () => {
    expect(AGENT_LAYER.guards.map((g) => g.id)).toEqual(GUARD_ORDER);
    expect(AGENT_LAYER.guards.filter((g) => g.executionCapable).map((g) => g.id)).toEqual(
      EXECUTION_CAPABLE_GUARDS,
    );
  });

  test('gates are H1–H7, and H7 is stated as closed', () => {
    expect(AGENT_LAYER.gates.map((g) => g.id)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']);
    expect(AGENT_LAYER.gates[6]?.here.text).toMatch(/^Closed\./);
  });

  test('every statement has evidence, and every path is repository-relative', () => {
    const facts = [
      AGENT_LAYER.standard,
      AGENT_LAYER.principle,
      ...AGENT_LAYER.components.flatMap((c) => [
        c.purpose,
        ...c.responsibilities,
        c.code,
        c.tests,
        c.approval,
      ]),
      ...Object.values(AGENT_LAYER.modelExecution),
      ...AGENT_LAYER.notRecorded,
    ];
    for (const fact of facts) expect(fact.evidence.length, fact.text).toBeGreaterThan(0);
    for (const { path } of allEvidence(AGENT_LAYER)) {
      expect(path).not.toMatch(/^\/|\.\.|\\/);
    }
  });
});

describe('agent layer: drift fails', () => {
  test('a changed quotation', () => {
    const files = filesWith({ 'docs/generator-agent.md': 'rewritten' });
    expect(verifyAgentLayer(AGENT_LAYER, files)).toContain(
      'docs/generator-agent.md: quoted text not found',
    );
  });

  test('a component that is stated absent but now has committed files', () => {
    const files = filesWith({}, ['agents/orchestrator/healer/heal.ts']);
    expect(verifyAgentLayer(AGENT_LAYER, files)).toContain(
      'agents/orchestrator/healer: expected no committed files',
    );
  });

  test('a tracked file that is no longer committed', () => {
    const files = filesWith({ 'agents/orchestrator/validation/run-guard.ts': null });
    expect(verifyAgentLayer(AGENT_LAYER, files)).toContain(
      'agents/orchestrator/validation/run-guard.ts: not a committed file',
    );
  });

  test('CI starting to authorize execution or run the Generator', () => {
    const ci = real.read('.github/workflows/ci.yml') ?? '';
    for (const added of [
      '--authorize-execution abc',
      'npm run agents:generate -- --tc TC-001-01',
    ]) {
      const problems = verifyAgentLayer(
        AGENT_LAYER,
        filesWith({ '.github/workflows/ci.yml': `${ci}\n${added}\n` }),
      );
      expect(problems).toContain(
        '.github/workflows/ci.yml: contains text it is stated not to contain',
      );
    }
  });

  test('a README checkbox that is ticked (a live run, a new agent)', () => {
    const readme = real.read('README.md') ?? '';
    for (const item of ['A live Generator run (real model output)', 'Healer agent']) {
      const ticked = readme.replace(`- [ ] ${item}`, `- [x] ${item}`);
      expect(verifyAgentLayer(AGENT_LAYER, filesWith({ 'README.md': ticked }))).toContain(
        'README.md: quoted text not found',
      );
    }
  });

  test('a guard row whose execution capability differs from the standard', () => {
    const layer = layerWith((l) => {
      (l.guards[5] as { executionCapable: boolean }).executionCapable = false;
    });
    expect(verifyAgentLayer(layer, real)).toContain(`${STANDARD}: quoted text not found`);
  });

  test('a gate or guard table row that is not shown', () => {
    const extraGate = standardText().replace('| H7   |', '| H8   | Something new |\n| H7   |');
    expect(verifyAgentLayer(AGENT_LAYER, filesWith({ [STANDARD]: extraGate }))).toContain(
      `${STANDARD}: the gate table has rows that are not shown`,
    );
    const layer = layerWith((l) => {
      (l as unknown as { guards: unknown[] }).guards = l.guards.slice(0, 6);
    });
    expect(verifyAgentLayer(layer, real)).toContain(
      `${STANDARD}: the guard table has rows that are not shown`,
    );
  });

  test('AI-agent components that are not exactly the standard’s agent roles', () => {
    const problem = `${STANDARD}: the AI agent components are not the standard's agent roles`;
    // A role added to the standard but not shown.
    const fiveRoles = standardText().replace(
      'An LLM-backed role (Planner, Generator, Analyzer, Healer)',
      'An LLM-backed role (Planner, Generator, Analyzer, Healer, Reviewer)',
    );
    expect(verifyAgentLayer(AGENT_LAYER, filesWith({ [STANDARD]: fiveRoles }))).toContain(problem);
    // The Validator counted as an AI agent.
    const validatorAsAgent = layerWith((l) => {
      (l.components[1] as { kind: string }).kind = 'AI agent';
    });
    expect(verifyAgentLayer(validatorAsAgent, real)).toContain(problem);
    // An agent dropped from the page.
    const dropped = layerWith((l) => {
      (l as unknown as { components: unknown[] }).components = l.components.slice(0, 4);
    });
    expect(verifyAgentLayer(dropped, real)).toContain(problem);
  });

  test('an evidence path outside the repository, or an empty quotation', () => {
    for (const path of ['../secrets.txt', '/etc/passwd', 'docs/../README.md', 'docs/']) {
      const layer = layerWith((l) => {
        (l.standard as unknown as { evidence: unknown[] }).evidence = [{ path, quote: 'x' }];
      });
      expect(verifyAgentLayer(layer, real).join('\n')).toContain('not a repository-relative path');
    }
    const empty = layerWith((l) => {
      (l.standard as unknown as { evidence: unknown[] }).evidence = [
        { path: 'README.md', quote: '  ' },
      ];
    });
    expect(verifyAgentLayer(empty, real)).toContain('README.md: quoted text not found');
  });

  test('problems name paths and checks, never file contents', () => {
    const problems = verifyAgentLayer(
      AGENT_LAYER,
      filesWith({ 'README.md': 'SECRET-README-CONTENT' }),
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).not.toContain('SECRET-README-CONTENT');
  });
});

describe('agent layer: committed files, not the working tree', () => {
  test('reads a file as committed, ignoring an uncommitted change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-layer-git-'));
    dirs.push(dir);
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
    git('init', '-q');
    writeFileSync(join(dir, 'note.md'), 'committed text\n');
    git('add', 'note.md');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(dir, 'note.md'), 'working tree text\n');
    writeFileSync(join(dir, 'untracked.md'), 'untracked\n');
    const files = gitCommittedFiles(dir);
    expect(files.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(files.read('note.md')).toBe('committed text\n');
    expect(files.read('untracked.md')).toBeNull();
    expect(files.list('untracked.md')).toEqual([]);
    expect(files.list('note.md')).toEqual(['note.md']);
  });
});

describe('agent layer plugin', () => {
  type Load = (this: { error(message: string): never }, id: string) => string | undefined;
  const load = (options: Parameters<typeof verifiedAgentLayer>[0]): string => {
    const plugin = verifiedAgentLayer(options);
    const context = {
      error(message: string): never {
        throw new Error(message);
      },
    };
    return (plugin.load as unknown as Load).call(context, '\0virtual:agent-layer') ?? '';
  };

  test('embeds the checked facts with the commit they were checked at', () => {
    const code = load({ repoRoot: REPO_ROOT });
    const embedded = JSON.parse(code.replace(/^export default /, '').replace(/;$/, '')) as {
      commit: string;
      layer: unknown;
    };
    expect(embedded.commit).toBe(real.commit);
    expect(embedded.layer).toEqual(JSON.parse(JSON.stringify(AGENT_LAYER)));
  });

  test('embeds nothing when a statement no longer holds', () => {
    expect(() => load({ repoRoot: REPO_ROOT, files: filesWith({ 'README.md': '' }) })).toThrow(
      /do not match the committed files .*nothing was embedded/s,
    );
  });

  test('embeds nothing that is not public-safe', () => {
    const layer = layerWith((l) => {
      (l.standard as { text: string }).text = `Built in ${REPO_ROOT}`;
    });
    expect(() => load({ repoRoot: REPO_ROOT, layer })).toThrow(
      /not public-safe; nothing was embedded/,
    );
  });
});
