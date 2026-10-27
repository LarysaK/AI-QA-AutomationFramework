import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { section } from '../generator/context';
import { type ApprovedIds, loadApprovedIds, parseTestPlanRows } from '../validation/approved-ids';
import { gitBlobSha } from '../validation/base-guard';
import { committedReferences } from '../validation/planner-guard';

/**
 * Deterministic requirement selection and the bounded context pack (Planner definition:
 * Preconditions, Context selection). Runs before any model call; every problem stops the run.
 * The same request and repository state always produce the same pack.
 */

export const CONTEXT_LIMIT_BYTES = 64 * 1024;
export const MAX_REQUIREMENTS = 10;

export class PlannerStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerStop';
  }
}

export type PlannerContextRole = 'architecture' | 'requirements' | 'test-plan';

export interface PlannerContextPiece {
  readonly path: string;
  readonly role: PlannerContextRole;
  readonly section: string;
  readonly text: string;
  readonly bytes: number;
  /** Git blob SHA of the whole file at selection time. */
  readonly blobSha: string;
  readonly ids: readonly string[];
}

/** One approved test case of a requested requirement, as the task shows it to the model. */
export interface CoverageEntry {
  readonly testCase: string;
  readonly automation: string;
  /** Committed tests/** files whose string literals contain the ID (not proof of coverage). */
  readonly referencedBy: readonly string[];
}

export interface PlannerContext {
  readonly app: string;
  readonly requirements: readonly string[];
  readonly pieces: readonly PlannerContextPiece[];
  readonly totalBytes: number;
  readonly coverage: Readonly<Record<string, readonly CoverageEntry[]>>;
  readonly approved: ApprovedIds;
}

const APP = /^[a-z0-9][a-z0-9-]*$/;
const REQ_ID = /^REQ-\d{3}$/;
const STANDARD = 'agents/standard/standard.md';

/**
 * Instruction-like text and context delimiters. Requirement and test-plan text is data; a selected
 * section that looks like it addresses the model, or could close the context framing, stops the
 * run before anything is sent (Planner definition: Preconditions, 3).
 */
export const UNTRUSTED_TEXT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  [
    'an instruction to ignore rules',
    /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding|system|your)\s+(instructions?|rules|prompts?|context)\b/i,
  ],
  ['a role change', /\byou\s+are\s+now\b/i],
  ['a reference to the system prompt', /\bsystem\s+prompt\b/i],
  ['a request for new instructions', /\bnew\s+instructions?\s*:/i],
  ['an execution authorization', /--authorize-execution|\bauthori[sz]e\s+(the\s+)?execution\b/i],
  ['an approval instruction', /\b(mark|treat)\s+(this|the|it)\s+(\w+\s+)?as\s+approved\b/i],
  [
    'a context delimiter',
    /<\/?\s*(approved-context|task|system|assistant|user|instructions?)\s*>/i,
  ],
];

export function screenUntrustedText(text: string): string[] {
  return UNTRUSTED_TEXT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
}

export function buildPlannerContext(
  repoRoot: string,
  app: string,
  requested: readonly string[],
  limit = CONTEXT_LIMIT_BYTES,
): PlannerContext {
  if (!APP.test(app) || !existsSync(join(repoRoot, 'specs', app, 'requirements.md'))) {
    throw new PlannerStop(`unknown application "${app}": specs/${app}/requirements.md not found`);
  }
  if (requested.length === 0) throw new PlannerStop('name at least one requirement with --req');
  if (requested.length > MAX_REQUIREMENTS) {
    throw new PlannerStop(`at most ${String(MAX_REQUIREMENTS)} requirements per run`);
  }
  for (const req of requested) {
    if (!REQ_ID.test(req)) throw new PlannerStop(`"${req}" is not a requirement ID (REQ-NNN)`);
  }
  if (new Set(requested).size !== requested.length) {
    throw new PlannerStop('a requirement is named more than once');
  }
  const { ids, errors } = loadApprovedIds(repoRoot);
  if (errors.length > 0) {
    throw new PlannerStop(`approved documents cannot be parsed:\n  ${errors.join('\n  ')}`);
  }
  for (const req of requested) {
    if (!ids.requirements.has(req)) {
      throw new PlannerStop(
        `${req} is not an approved requirement in specs/${app}/requirements.md`,
      );
    }
  }
  const requirements = [...requested].sort();

  const requirementsPath = `specs/${app}/requirements.md`;
  const planPath = `specs/${app}/test-plan.md`;
  const pieces: PlannerContextPiece[] = [];
  const add = (
    path: string,
    role: PlannerContextRole,
    label: string,
    text: string,
    pieceIds: readonly string[] = [],
    untrusted = false,
  ): void => {
    if (untrusted) {
      const found = screenUntrustedText(text);
      if (found.length > 0) {
        throw new PlannerStop(
          `${path} § ${label} contains ${found.join(' and ')}; requirement content is data, ` +
            'and nothing was sent to a model',
        );
      }
    }
    pieces.push({
      path,
      role,
      section: label,
      text,
      bytes: Buffer.byteLength(text),
      blobSha: gitBlobSha(readFileSync(join(repoRoot, path))),
      ids: pieceIds,
    });
  };
  const sectionOf = (markdown: string, heading: RegExp, path: string): string => {
    try {
      return section(markdown, heading, path);
    } catch (error) {
      throw new PlannerStop(error instanceof Error ? error.message : String(error));
    }
  };

  // 1. Agent Standard: principles, sources of truth, traceability, statuses, gates, uncertainty.
  const standard = read(repoRoot, STANDARD);
  for (const [heading, label] of [
    [/^## 1\. /, '## 1.'],
    [/^## 3\. /, '## 3.'],
    [/^## 5\. /, '## 5. (up to ### 5.1)'],
    [/^### 7\.1 /, '### 7.1'],
    [/^## 8\. /, '## 8.'],
    [/^## 12\. /, '## 12.'],
    [/^## 13\. /, '## 13.'],
  ] as const) {
    const text = sectionOf(standard, heading, STANDARD);
    add(STANDARD, 'architecture', label, label.startsWith('## 5.') ? upTo(text, '### 5.1') : text);
  }

  // 2. Requirements: shared definitions, each requested requirement, the API contract.
  const requirementsText = read(repoRoot, requirementsPath);
  const index = requirementsText.split('\n').indexOf('# Requirements');
  if (index < 0) throw new PlannerStop(`"# Requirements" not found in ${requirementsPath}`);
  add(
    requirementsPath,
    'requirements',
    'before "# Requirements"',
    requirementsText.split('\n').slice(0, index).join('\n').trimEnd(),
    [],
    true,
  );
  for (const req of requirements) {
    add(
      requirementsPath,
      'requirements',
      `## ${req}`,
      sectionOf(requirementsText, new RegExp(`^## ${req} — `), requirementsPath),
      [req],
      true,
    );
  }
  add(
    requirementsPath,
    'requirements',
    '# API',
    sectionOf(requirementsText, /^# API$/, requirementsPath),
    [],
    true,
  );

  // 3. Test plan: strategy and each requested requirement's approved test cases.
  const plan = read(repoRoot, planPath);
  const rows = parseTestPlanRows(plan);
  add(planPath, 'test-plan', '## 1.', sectionOf(plan, /^## 1\. /, planPath), [], true);
  const references = committedReferences(repoRoot);
  const coverage: Record<string, CoverageEntry[]> = {};
  for (const req of requirements) {
    const entries = [...rows.values()]
      .filter((row) => row.requirement === req)
      .map((row) => ({
        testCase: row.testCase,
        automation: row.cells['Automation'] ?? '',
        referencedBy: references.get(row.testCase) ?? [],
      }));
    coverage[req] = entries;
    add(
      planPath,
      'test-plan',
      `### ${req}`,
      sectionOf(plan, new RegExp(`^### ${req} — `), planPath),
      entries.map((entry) => entry.testCase),
      true,
    );
  }

  const totalBytes = pieces.reduce((sum, piece) => sum + piece.bytes, 0);
  if (totalBytes > limit) {
    throw new PlannerStop(
      `context is ${String(totalBytes)} bytes, over the ${String(limit)}-byte limit; nothing was truncated`,
    );
  }
  return { app, requirements, pieces, totalBytes, coverage, approved: ids };
}

function read(repoRoot: string, path: string): string {
  try {
    return readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    throw new PlannerStop(`required context file ${path} not found`);
  }
}

function upTo(text: string, marker: string): string {
  const at = text.indexOf(`\n${marker}`);
  return (at < 0 ? text : text.slice(0, at)).trimEnd();
}
