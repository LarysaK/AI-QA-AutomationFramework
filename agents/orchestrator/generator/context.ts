import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { gitBlobSha } from '../validation/base-guard';
import { GeneratorStop, type SelectedTestCase } from './select';

/**
 * Deterministic, bounded context pack (Generator definition: Context selection). The same
 * selected test case and repository state always produce the same pack. Nothing is truncated:
 * a missing piece or an exceeded limit stops the run.
 */

export const CONTEXT_LIMIT_BYTES = 64 * 1024;
export const MAX_CANONICAL_EXAMPLES = 2;

export type ContextRole =
  'architecture' | 'requirements' | 'test-plan' | 'canonical-test' | 'support';

export interface ContextPiece {
  readonly path: string;
  readonly role: ContextRole;
  /** Which part of the file; "whole file" for complete files. */
  readonly section: string;
  readonly text: string;
  readonly bytes: number;
  /** Git blob SHA of the whole file at selection time. */
  readonly blobSha: string;
  readonly ids: readonly string[];
}

export interface ContextPack {
  readonly pieces: readonly ContextPiece[];
  readonly totalBytes: number;
  readonly canonicals: readonly string[];
}

const STANDARD = 'agents/standard/standard.md';
const FORBIDDEN = [/(^|\/)\.env/, /^artifacts\//, /(^|\/)node_modules\//, /^apps\/[^/]+\/app\//];

export function buildContext(
  repoRoot: string,
  selected: SelectedTestCase,
  limit = CONTEXT_LIMIT_BYTES,
): ContextPack {
  const { app, requirement } = selected;
  const requirementsPath = `specs/${app}/requirements.md`;
  const planPath = `specs/${app}/test-plan.md`;
  const pieces: ContextPiece[] = [];
  const add = (
    path: string,
    role: ContextRole,
    section: string,
    text: string,
    ids: readonly string[] = [],
  ): void => {
    if (FORBIDDEN.some((pattern) => pattern.test(path)))
      throw new GeneratorStop(`refusing excluded context path ${path}`);
    pieces.push({
      path,
      role,
      section,
      text,
      bytes: Buffer.byteLength(text),
      blobSha: blobSha(repoRoot, path),
      ids,
    });
  };

  // 1. Agent Standard: the rules a generated test must follow.
  const standard = read(repoRoot, STANDARD);
  add(
    STANDARD,
    'architecture',
    '## 5. (up to ### 5.1)',
    upTo(section(standard, /^## 5\. /, STANDARD), '### 5.1'),
  );
  for (const [heading, label] of [
    [/^### 6\.2 /, '### 6.2'],
    [/^## 10\. /, '## 10.'],
    [/^## 11\. /, '## 11.'],
    [/^## 13\. /, '## 13.'],
  ] as const) {
    add(STANDARD, 'architecture', label, section(standard, heading, STANDARD));
  }

  // 2. Requirements: shared definitions, the owning requirement, the API contract.
  const requirements = read(repoRoot, requirementsPath);
  add(
    requirementsPath,
    'requirements',
    'before "# Requirements"',
    before(requirements, '# Requirements', requirementsPath),
  );
  add(
    requirementsPath,
    'requirements',
    `## ${requirement}`,
    section(requirements, new RegExp(`^## ${requirement} — `), requirementsPath),
    [requirement],
  );
  add(
    requirementsPath,
    'requirements',
    '# API',
    section(requirements, /^# API$/, requirementsPath),
  );

  // 3. Test plan: strategy and the owning requirement's test-case section.
  const plan = read(repoRoot, planPath);
  add(planPath, 'test-plan', '## 1.', section(plan, /^## 1\. /, planPath));
  add(
    planPath,
    'test-plan',
    `### ${requirement}`,
    section(plan, new RegExp(`^### ${requirement} — `), planPath),
    [selected.testCase],
  );

  // 4. Canonical examples at the test case's level, at most two.
  const canonicals = chooseCanonicals(plan, selected);
  const canonicalFiles = canonicals.map((can) => [can, canonicalFile(repoRoot, can)] as const);
  for (const [can, path] of canonicalFiles)
    add(path, 'canonical-test', 'whole file', read(repoRoot, path), [can]);

  // 5. Support code imported by the canonical examples.
  for (const path of supportFiles(
    repoRoot,
    app,
    canonicalFiles.map(([, path]) => path),
  )) {
    add(path, 'support', 'whole file', read(repoRoot, path));
  }

  const totalBytes = pieces.reduce((sum, piece) => sum + piece.bytes, 0);
  if (totalBytes > limit) {
    throw new GeneratorStop(
      `context is ${String(totalBytes)} bytes, over the ${String(limit)}-byte limit; nothing was truncated`,
    );
  }
  return { pieces, totalBytes, canonicals };
}

/**
 * Canonical tests whose canonical-index Level equals the test case's level. Priority: those whose
 * Covers column lists a test case of the same requirement, then ascending CAN ID; first two.
 */
export function chooseCanonicals(plan: string, selected: SelectedTestCase): string[] {
  const lines = plan.split('\n');
  const headerIndex = lines.findIndex((line) => /^\| ID\s*\|.*\|\s*Level\s*\|.*Covers/.test(line));
  if (headerIndex < 0)
    throw new GeneratorStop(
      'canonical index table (ID | … | Level | Covers) not found in the test plan',
    );
  const header = cellsOf(lines[headerIndex] ?? '');
  const levelAt = header.indexOf('Level');
  const coversAt = header.indexOf('Covers');

  const candidates: { can: string; sameRequirement: boolean }[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    const cells = cellsOf(line);
    const can = cells[0];
    if (can === undefined || !/^CAN-\d{3}$/.test(can)) break;
    if (cells[levelAt] !== selected.level) continue;
    const ownerNumber = selected.requirement.slice('REQ-'.length);
    candidates.push({
      can,
      sameRequirement: (cells[coversAt] ?? '').includes(`TC-${ownerNumber}-`),
    });
  }
  if (candidates.length === 0) {
    throw new GeneratorStop(`no canonical test at level ${selected.level} in the canonical index`);
  }
  return candidates
    .sort(
      (a, b) => Number(b.sameRequirement) - Number(a.sameRequirement) || a.can.localeCompare(b.can),
    )
    .slice(0, MAX_CANONICAL_EXAMPLES)
    .map(({ can }) => can);
}

/** The single tests/** file carrying the canonical tag. */
function canonicalFile(repoRoot: string, can: string): string {
  const testsDir = join(repoRoot, 'tests');
  const matches = readdirSync(testsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file, 'utf8').includes(`@${can}`))
    .map((file) => toRepoPath(repoRoot, file));
  if (matches.length !== 1) {
    throw new GeneratorStop(
      `expected exactly one file tagged @${can}, found ${String(matches.length)}`,
    );
  }
  return matches[0] ?? '';
}

/** Relative imports into apps/<app>/{api,data,pages}/, followed transitively, sorted. */
function supportFiles(repoRoot: string, app: string, from: readonly string[]): string[] {
  const allowed = new RegExp(`^apps/${app}/(api|data|pages)/`);
  const found = new Set<string>();
  const queue = [...from];
  while (queue.length > 0) {
    const file = queue.shift() ?? '';
    for (const match of read(repoRoot, file).matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const target = toRepoPath(repoRoot, resolve(repoRoot, dirname(file), `${match[1] ?? ''}.ts`));
      if (!allowed.test(target) || found.has(target)) continue;
      if (!existsSync(join(repoRoot, target)))
        throw new GeneratorStop(`imported support file ${target} not found`);
      found.add(target);
      queue.push(target);
    }
  }
  return [...found].sort();
}

/** A heading's section: from the heading to the next heading of the same or a higher level. */
export function section(markdown: string, heading: RegExp, path: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0)
    throw new GeneratorStop(`required section ${String(heading)} not found in ${path}`);
  const level = /^(#+)/.exec(lines[start] ?? '')?.[1]?.length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const depth = /^(#+)\s/.exec(lines[i] ?? '')?.[1]?.length;
    if (depth !== undefined && depth <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

function before(markdown: string, heading: string, path: string): string {
  const lines = markdown.split('\n');
  const end = lines.indexOf(heading);
  if (end < 0) throw new GeneratorStop(`required heading "${heading}" not found in ${path}`);
  return lines.slice(0, end).join('\n').trimEnd();
}

function upTo(text: string, marker: string): string {
  const index = text.indexOf(`\n${marker}`);
  return (index < 0 ? text : text.slice(0, index)).trimEnd();
}

function read(repoRoot: string, path: string): string {
  try {
    return readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    throw new GeneratorStop(`required context file ${path} not found`);
  }
}

function blobSha(repoRoot: string, path: string): string {
  return gitBlobSha(readFileSync(join(repoRoot, path)));
}

function cellsOf(line: string): string[] {
  return line.startsWith('|')
    ? line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    : [];
}

function toRepoPath(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).split('\\').join('/');
}
