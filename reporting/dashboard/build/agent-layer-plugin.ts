import { spawnSync } from 'node:child_process';

import type { Plugin } from 'vite';

import { defaultSafetyContext, publicSafetyFindings } from '../../dashboard-data/sanitize';
import { AGENT_LAYER, type AgentLayer, allEvidence } from '../src/data/agents';

/**
 * Provides `virtual:agent-layer`: the agent layer facts of src/data/agents.ts, embedded only after
 * every statement has been checked, in Node, against the committed files of the commit being built
 * (HEAD), never the working tree:
 * - each quote appears in its file (whitespace-insensitive), each excluded text does not;
 * - each tracked file is committed, and no committed file is at or under an absent path;
 * - the guard and gate rows match the Agent Standard's tables, and the tables have no other rows;
 * - the AI-agent components are exactly the standard's agent roles (the Validator is orchestrator
 *   code, not an agent);
 * - the result passes the public-safety scan.
 * Any failure fails the dev server, the tests and the build; nothing is embedded. Findings name
 * the path and the kind of check, never file contents.
 */

export const AGENT_LAYER_VIRTUAL_ID = 'virtual:agent-layer';
const RESOLVED_ID = `\0${AGENT_LAYER_VIRTUAL_ID}`;
const STANDARD = 'agents/standard/standard.md';

/** Read access to one commit's files. */
export interface CommittedFiles {
  readonly commit: string;
  /** The file's text at the commit, or null if it is not a committed file. */
  read(path: string): string | null;
  /** Committed files at or under `path`. */
  list(path: string): readonly string[];
}

export function gitCommittedFiles(repoRoot: string): CommittedFiles {
  const git = (args: readonly string[]) =>
    spawnSync('git', [...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const commit = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('agent layer: cannot resolve the HEAD commit');
  }
  return {
    commit,
    read(path) {
      const shown = git(['show', `${commit}:${path}`]);
      return shown.status === 0 ? shown.stdout : null;
    },
    list(path) {
      const listed = git(['ls-tree', '-r', '--name-only', '-z', commit, '--', path]);
      if (listed.status !== 0) throw new Error(`agent layer: cannot list ${path}`);
      return listed.stdout.split('\0').filter((entry) => entry !== '');
    },
  };
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-][A-Za-z0-9._/-]*$/;

/** Problems with the layer's evidence at the commit; empty means every statement holds. */
export function verifyAgentLayer(layer: AgentLayer, files: CommittedFiles): string[] {
  const problems: string[] = [];
  const cache = new Map<string, string | null>();
  const text = (path: string): string | null => {
    if (!cache.has(path)) {
      const raw = files.read(path);
      cache.set(path, raw === null ? null : normalize(raw));
    }
    return cache.get(path) ?? null;
  };

  for (const evidence of allEvidence(layer)) {
    const { path } = evidence;
    if (!SAFE_PATH.test(path) || path.includes('//') || path.endsWith('/')) {
      problems.push(`evidence path is not a repository-relative path: ${JSON.stringify(path)}`);
      continue;
    }
    if ('absent' in evidence) {
      if (files.list(path).length > 0) problems.push(`${path}: expected no committed files`);
      continue;
    }
    const content = text(path);
    if (content === null) {
      problems.push(`${path}: not a committed file`);
      continue;
    }
    if ('quote' in evidence) {
      const quote = normalize(evidence.quote);
      if (quote === '' || !content.includes(quote)) problems.push(`${path}: quoted text not found`);
    } else if ('excludes' in evidence) {
      if (content.includes(normalize(evidence.excludes))) {
        problems.push(`${path}: contains text it is stated not to contain`);
      }
    }
  }

  // The displayed tables must be the standard's whole tables, not a selection.
  const standard = files.read(STANDARD);
  if (standard !== null) {
    const rows = (pattern: RegExp) => standard.match(pattern)?.length ?? 0;
    if (rows(/^\| H\d+ +\|/gm) !== layer.gates.length) {
      problems.push(`${STANDARD}: the gate table has rows that are not shown`);
    }
    if (rows(/^\| G-[A-Z]+ +\|/gm) !== layer.guards.length) {
      problems.push(`${STANDARD}: the guard table has rows that are not shown`);
    }
    // The AI-agent components are exactly the standard's agent roles (in any display order).
    const roles = /^\| Agent +\| An LLM-backed role \(([^)]*)\)/m.exec(standard)?.[1]?.split(', ');
    const shown = layer.components
      .filter((c) => c.kind === 'AI agent')
      .map((c) => c.name.replace(/ agent$/, ''));
    if (roles === undefined || [...roles].sort().join(',') !== [...shown].sort().join(',')) {
      problems.push(`${STANDARD}: the AI agent components are not the standard's agent roles`);
    }
  }
  return problems;
}

export interface AgentLayerPluginOptions {
  /** Absolute path of the repository root, which must never appear in the output. */
  readonly repoRoot: string;
  /** Defaults to the real facts and git; tests substitute either. */
  readonly layer?: AgentLayer;
  readonly files?: CommittedFiles;
}

export function verifiedAgentLayer({ repoRoot, layer, files }: AgentLayerPluginOptions): Plugin {
  return {
    name: 'verified-agent-layer',
    resolveId(id) {
      return id === AGENT_LAYER_VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      let committed: CommittedFiles;
      try {
        committed = files ?? gitCommittedFiles(repoRoot);
      } catch (error) {
        this.error(error instanceof Error ? error.message : 'agent layer: git is not available');
      }
      const facts = layer ?? AGENT_LAYER;
      const problems = verifyAgentLayer(facts, committed);
      if (problems.length > 0) {
        this.error(
          `agent layer facts do not match the committed files at ${committed.commit}; nothing was embedded:\n  ${problems.join('\n  ')}`,
        );
      }
      const verified = { commit: committed.commit, layer: facts };
      const unsafe = publicSafetyFindings(verified, defaultSafetyContext(repoRoot));
      if (unsafe.length > 0) {
        this.error(
          `agent layer facts are not public-safe; nothing was embedded:\n  ${unsafe.join('\n  ')}`,
        );
      }
      return `export default ${JSON.stringify(verified)};`;
    },
  };
}
