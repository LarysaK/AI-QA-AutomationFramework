import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  AgentName,
  Artifact,
  ChangeKind,
  GuardFailure,
  GuardResult,
  Operation,
} from './types';

/**
 * G-PATHS (STD-AUTH-002, STD-CAN-001): path classes from Agent Standard v1, section 6.2.
 * Default deny: a change is allowed only if its path is in an allowed class and the agent,
 * changeKind and operation are permitted for that class.
 */

/** Protected class. Matched case-insensitively, so case-insensitive file systems cannot bypass it. */
const PROTECTED: readonly { readonly name: string; readonly matches: (path: string) => boolean }[] =
  [
    { name: 'requirements', matches: (p) => /^specs\/(.+\/)?requirements\.md$/i.test(p) },
    { name: 'AUT source', matches: (p) => /^apps\/[^/]+\/app\//i.test(p) },
    {
      name: 'root configuration',
      matches: (p) =>
        [
          'playwright.config.ts',
          'package.json',
          'package-lock.json',
          'tsconfig.json',
          'eslint.config.mjs',
        ].includes(p.toLowerCase()),
    },
    { name: 'environment file', matches: (p) => /(^|\/)\.env[^/]*$/i.test(p) },
    { name: 'agent layer', matches: (p) => /^agents\//i.test(p) },
    { name: 'ADR', matches: (p) => /^docs\/adr\//i.test(p) },
  ];

/** Allowed classes, matched exactly. */
const ALLOWED: readonly {
  readonly name: string;
  readonly matches: (path: string) => boolean;
  readonly changeKind: ChangeKind;
  readonly permits: Partial<Record<AgentName, readonly Operation[]>>;
}[] = [
  {
    name: 'Plan',
    matches: (p) => /^specs\/(.+\/)?test-plan\.md$/.test(p),
    changeKind: 'plan-change',
    permits: { planner: ['create', 'modify'] },
  },
  {
    name: 'Test',
    matches: (p) => p.startsWith('tests/'),
    changeKind: 'test-change',
    permits: { generator: ['create'], healer: ['modify'] },
  },
  {
    name: 'Support',
    matches: (p) => /^apps\/[^/]+\/(pages|api|data)\//.test(p),
    changeKind: 'support-change',
    permits: { generator: ['create', 'modify'], healer: ['create', 'modify'] },
  },
];

/** A file containing a canonical test tag is a canonical test file. */
const CANONICAL_TAG = /@CAN-\d{3}/;

export function checkPaths(artifact: Artifact, repoRoot: string): GuardResult {
  const failures: GuardFailure[] = [];
  const fail = (
    path: string,
    reason: string,
    ruleIds: readonly string[] = ['STD-AUTH-002'],
  ): void => {
    failures.push({ guard: 'G-PATHS', ruleIds, path, reason });
  };

  const seen = new Set<string>();
  for (const change of artifact.proposedChanges) {
    const { path, changeKind, operation } = change;

    const unsafe = unsafePathReason(path, repoRoot);
    if (unsafe) {
      fail(path, unsafe);
      continue;
    }

    if (seen.has(path.toLowerCase())) {
      fail(path, 'path is proposed more than once in the same artifact');
      continue;
    }
    seen.add(path.toLowerCase());

    const protectedClass = PROTECTED.find((entry) => entry.matches(path));
    if (protectedClass) {
      fail(path, `protected path (${protectedClass.name})`);
      continue;
    }

    if (isCanonicalTestFile(resolve(repoRoot, path))) {
      fail(path, 'protected path (canonical test file: contains a @CAN- tag)', [
        'STD-AUTH-002',
        'STD-CAN-001',
      ]);
      continue;
    }

    const allowedClass = ALLOWED.find((entry) => entry.matches(path));
    if (!allowedClass) {
      fail(path, 'path is not in any allowed path class (default deny)');
      continue;
    }

    if (changeKind !== allowedClass.changeKind) {
      fail(
        path,
        `changeKind "${changeKind}" does not match the ${allowedClass.name} class (requires "${allowedClass.changeKind}")`,
      );
      continue;
    }

    const operations = allowedClass.permits[artifact.agent.name];
    if (!operations) {
      fail(
        path,
        `agent "${artifact.agent.name}" may not propose changes to the ${allowedClass.name} class`,
      );
    } else if (!operations.includes(operation)) {
      fail(
        path,
        `agent "${artifact.agent.name}" may not "${operation}" in the ${allowedClass.name} class (allowed: ${operations.join(', ')})`,
      );
    }
  }

  return { guard: 'G-PATHS', status: failures.length === 0 ? 'passed' : 'failed', failures };
}

/**
 * Rejects anything that is not a plain repository-relative POSIX path inside the repository,
 * including symlinks that resolve outside it. The schema already enforces most of this;
 * the guard re-checks it independently because it protects the file system.
 */
function unsafePathReason(path: string, repoRoot: string): string | undefined {
  if (path === '' || path.includes('\0')) return 'path is empty or contains a NUL character';
  if (isAbsolute(path) || path.startsWith('/')) return 'path must be repository-relative';
  if (path.includes('\\')) return 'path must use forward slashes';
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'path must not contain empty, "." or ".." segments';
  }

  const root = realpathSync(repoRoot);
  const target = resolve(root, path);
  if (!isInside(root, target)) return 'path resolves outside the repository';

  // Resolve symlinks of the nearest existing ancestor (or the file itself).
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!isInside(root, realpathSync(existing)))
    return 'path resolves outside the repository through a symlink';
  return undefined;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function isCanonicalTestFile(absolutePath: string): boolean {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return false;
  return CANONICAL_TAG.test(readFileSync(absolutePath, 'utf8'));
}
