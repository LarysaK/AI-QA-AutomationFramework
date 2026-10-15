import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadApprovedIds,
  parseRequirements,
  parseTestPlan,
} from '../../agents/orchestrator/validation/approved-ids';
import { type PlanMetadataRow, type PlanSection, readPlanContent } from './plan-content';

/**
 * The approved behavioural documents, read as the single source of truth. Which IDs exist is
 * decided only by the specification format contract (Agent Standard 5.1) through the same
 * parser G-TRACE uses; this module only reads the cell values of rows that contract approves,
 * verbatim, and fails on anything it cannot read exactly.
 */

export const TEST_CASE_COLUMNS = ['ID', 'Scenario', 'Level', 'Type', 'Automation', 'Priority'];
export const CANONICAL_COLUMNS = ['ID', 'Title', 'Level', 'Covers'];
const LEVELS = ['API', 'UI', 'E2E'];
const INTENTS = ['Yes', 'No'];
const PRIORITIES = ['P0', 'P1', 'P2'];

export interface SourceDocument {
  /** Repository-relative path. */
  readonly path: string;
  /** The document's level-1 heading, verbatim. */
  readonly title: string;
  /** Git blob SHA-1 of the file content, as `git hash-object` reports it. */
  readonly gitBlobSha: string;
}

export interface RequirementRecord {
  readonly id: string;
  readonly title: string;
  /** The requirement's section below its heading, verbatim Markdown. */
  readonly markdown: string;
}

export interface TestCaseRecord {
  readonly id: string;
  readonly requirementId: string;
  /** The Scenario cell, verbatim. */
  readonly scenario: string;
  readonly level: string;
  readonly type: string;
  /** The plan's Automation column: intent, not linkage or execution. */
  readonly automationIntent: string;
  readonly priority: string;
}

export interface CanonicalRecord {
  readonly id: string;
  readonly title: string;
  readonly level: string;
  /** The Covers cell, verbatim. */
  readonly covers: string;
  /** The canonical's `### CAN-NNN — …` subsection heading and body, verbatim. */
  readonly heading: string;
  readonly markdown: string;
}

export interface TestPlanContent {
  readonly title: string;
  readonly metadata: readonly PlanMetadataRow[];
  readonly preamble: string;
  readonly sections: readonly PlanSection[];
}

export interface SpecSources {
  readonly app: string;
  readonly documents: readonly SourceDocument[];
  readonly requirements: readonly RequirementRecord[];
  readonly testCases: readonly TestCaseRecord[];
  readonly canonicals: readonly CanonicalRecord[];
  readonly testPlan: TestPlanContent;
}

export class SnapshotError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`dashboard snapshot cannot be built:\n  ${problems.join('\n  ')}`);
    this.name = 'SnapshotError';
  }
}

const APP = /^[a-z0-9][a-z0-9-]*$/;
const REQUIREMENT_HEADING = /^##\s+(REQ-\d{3})\s+—\s+(\S.*?)\s*$/;
const H1 = /^#\s+(\S.*?)\s*$/;

export function readSpecSources(repoRoot: string, app: string): SpecSources {
  if (!APP.test(app)) throw new SnapshotError([`"${app}" is not a valid application name`]);
  const requirementsPath = `specs/${app}/requirements.md`;
  const testPlanPath = `specs/${app}/test-plan.md`;
  const problems: string[] = [];

  let requirementsText: string;
  let testPlanText: string;
  try {
    requirementsText = readFileSync(join(repoRoot, requirementsPath), 'utf8');
    testPlanText = readFileSync(join(repoRoot, testPlanPath), 'utf8');
  } catch {
    throw new SnapshotError([`${requirementsPath} and ${testPlanPath} must both exist`]);
  }

  // The approved-ID contract, for this application and across all of specs/.
  const global = loadApprovedIds(repoRoot);
  problems.push(...global.errors);
  const approvedRequirements = parseRequirements(requirementsText);
  const approvedPlan = parseTestPlan(testPlanText);
  problems.push(...approvedRequirements.errors.map((error) => `${requirementsPath}: ${error}`));
  problems.push(...approvedPlan.errors.map((error) => `${testPlanPath}: ${error}`));
  if (problems.length > 0) throw new SnapshotError(problems);

  const requirements = readRequirements(requirementsText, requirementsPath, problems);
  const testCases = readTestCases(testPlanText, testPlanPath, problems);
  const canonicalRows = readCanonicals(testPlanText, testPlanPath, problems);
  const plan = readPlanContent(testPlanText, testPlanPath, problems);
  const canonicals: CanonicalRecord[] = canonicalRows.map((row) => {
    const section = plan.canonicalSections.get(row.id);
    if (section === undefined)
      problems.push(`${testPlanPath}: ${row.id} has no "### ${row.id} — …" subsection`);
    return { ...row, heading: section?.heading ?? '', markdown: section?.markdown ?? '' };
  });
  for (const section of plan.sections) {
    if (section.kind !== 'inventory') continue;
    for (const note of section.requirementNotes) {
      if (!approvedRequirements.ids.includes(note.requirementId)) {
        problems.push(
          `${testPlanPath}: inventory subsection ${note.requirementId} is not an approved requirement`,
        );
      }
    }
  }
  for (const id of plan.canonicalSections.keys()) {
    if (!canonicalRows.some((row) => row.id === id)) {
      problems.push(`${testPlanPath}: subsection ${id} has no row in the canonical table`);
    }
  }

  // Cross-check: exactly the IDs the contract approves, with the same owners.
  sameIds(
    requirementsPath,
    'requirements',
    approvedRequirements.ids,
    requirements.map((r) => r.id),
    problems,
  );
  sameIds(
    testPlanPath,
    'test cases',
    [...approvedPlan.testCases.keys()],
    testCases.map((tc) => tc.id),
    problems,
  );
  sameIds(
    testPlanPath,
    'canonical tests',
    approvedPlan.canonicals,
    canonicals.map((can) => can.id),
    problems,
  );
  for (const tc of testCases) {
    if (approvedPlan.testCases.get(tc.id) !== tc.requirementId) {
      problems.push(`${testPlanPath}: ${tc.id} owner does not match the approved-ID contract`);
    }
    if (!approvedRequirements.ids.includes(tc.requirementId)) {
      problems.push(`${testPlanPath}: ${tc.id} belongs to undefined ${tc.requirementId}`);
    }
  }
  const documents = [
    document(requirementsPath, requirementsText, problems),
    document(testPlanPath, testPlanText, problems),
  ];
  if (problems.length > 0) throw new SnapshotError(problems);

  return {
    app,
    testPlan: {
      title: documents[1]?.title ?? '',
      metadata: plan.metadata,
      preamble: plan.preamble,
      sections: plan.sections,
    },
    documents,
    requirements: [...requirements].sort(byId),
    testCases: [...testCases].sort(byId),
    canonicals: [...canonicals].sort(byId),
  };
}

function readRequirements(markdown: string, path: string, problems: string[]): RequirementRecord[] {
  const lines = markdown.split('\n');
  const records: RequirementRecord[] = [];
  lines.forEach((line, index) => {
    const match = REQUIREMENT_HEADING.exec(line);
    if (!match?.[1] || !match[2]) return;
    let end = lines.length;
    for (let i = index + 1; i < lines.length; i += 1) {
      if (/^#{1,2}\s/.test(lines[i] ?? '')) {
        end = i;
        break;
      }
    }
    const body = lines.slice(index + 1, end);
    // The section separator before the next heading is layout, not content.
    while (body.length > 0 && /^\s*(---)?\s*$/.test(body[body.length - 1] ?? '')) body.pop();
    while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift();
    if (body.length === 0) problems.push(`${path}: ${match[1]} has an empty section`);
    records.push({ id: match[1], title: match[2], markdown: body.join('\n') });
  });
  return records;
}

function readTestCases(markdown: string, path: string, problems: string[]): TestCaseRecord[] {
  const records: TestCaseRecord[] = [];
  let section: string | undefined;
  for (const { at, cells, header } of tableRows(markdown, (line) => {
    if (/^#{1,3}\s/.test(line)) section = /^###\s+(REQ-\d{3})\s+—\s+\S/.exec(line)?.[1];
  })) {
    if (section === undefined || !/^TC-\d{3}-\d{2}$/.test(cells[0] ?? '')) continue;
    const row = byColumn(header, cells, TEST_CASE_COLUMNS, `${path} ${at}`, problems);
    if (!row) continue;
    const where = `${path}: ${row['ID'] ?? ''}`;
    const value = (column: string, allowed?: readonly string[]): string => {
      const cell = row[column] ?? '';
      if (cell === '') problems.push(`${where}: empty ${column}`);
      else if (allowed && !allowed.includes(cell)) {
        problems.push(`${where}: ${column} "${cell}" is not one of ${allowed.join(', ')}`);
      }
      return cell;
    };
    records.push({
      id: value('ID'),
      requirementId: section,
      scenario: value('Scenario'),
      level: value('Level', LEVELS),
      type: value('Type'),
      automationIntent: value('Automation', INTENTS),
      priority: value('Priority', PRIORITIES),
    });
  }
  return records;
}

function readCanonicals(
  markdown: string,
  path: string,
  problems: string[],
): Omit<CanonicalRecord, 'heading' | 'markdown'>[] {
  const records: Omit<CanonicalRecord, 'heading' | 'markdown'>[] = [];
  for (const { at, cells, header } of tableRows(markdown)) {
    if (!/^CAN-\d{3}$/.test(cells[0] ?? '')) continue;
    const row = byColumn(header, cells, CANONICAL_COLUMNS, `${path} ${at}`, problems);
    if (!row) continue;
    const where = `${path}: ${row['ID'] ?? ''}`;
    for (const column of CANONICAL_COLUMNS) {
      if ((row[column] ?? '') === '') problems.push(`${where}: empty ${column}`);
    }
    if (!LEVELS.includes(row['Level'] ?? '')) {
      problems.push(`${where}: Level "${row['Level'] ?? ''}" is not one of ${LEVELS.join(', ')}`);
    }
    records.push({
      id: row['ID'] ?? '',
      title: row['Title'] ?? '',
      level: row['Level'] ?? '',
      covers: row['Covers'] ?? '',
    });
  }
  return records;
}

interface TableRow {
  readonly at: string;
  readonly cells: readonly string[];
  readonly header: readonly string[];
}

/** Data rows of every Markdown table, each with the header of its own table. */
function* tableRows(markdown: string, onLine?: (line: string) => void): Generator<TableRow> {
  const lines = markdown.split('\n');
  let header: string[] = [];
  for (const [index, line] of lines.entries()) {
    onLine?.(line);
    if (!line.startsWith('|')) {
      header = [];
      continue;
    }
    if (/^\|[\s|:-]+\|\s*$/.test(line)) continue;
    const cells = splitRow(line);
    const next = lines[index + 1] ?? '';
    if (header.length === 0 && /^\|[\s|:-]+\|\s*$/.test(next)) {
      header = cells;
      continue;
    }
    yield { at: `line ${String(index + 1)}`, cells, header };
  }
}

function splitRow(line: string): string[] {
  // Escaped pipes are not supported: the row is not read, and the cross-check against the
  // approved-ID contract then reports its ID as not read.
  if (/\\\|/.test(line)) return ['<escaped pipe>'];
  return line
    .trim()
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function byColumn(
  header: readonly string[],
  cells: readonly string[],
  expected: readonly string[],
  where: string,
  problems: string[],
): Record<string, string> | undefined {
  if (header.join('|') !== expected.join('|')) {
    problems.push(
      `${where}: table columns are "${header.join(' | ')}", expected "${expected.join(' | ')}"`,
    );
    return undefined;
  }
  if (cells.length !== expected.length) {
    problems.push(
      `${where}: row has ${String(cells.length)} cells, expected ${String(expected.length)}`,
    );
    return undefined;
  }
  return Object.fromEntries(expected.map((column, i) => [column, cells[i] ?? '']));
}

function sameIds(
  path: string,
  what: string,
  approved: readonly string[],
  read: readonly string[],
  problems: string[],
): void {
  const missing = approved.filter((id) => !read.includes(id));
  const extra = read.filter((id) => !approved.includes(id));
  if (missing.length > 0)
    problems.push(`${path}: approved ${what} not read: ${missing.join(', ')}`);
  if (extra.length > 0)
    problems.push(`${path}: ${what} read but not approved: ${extra.join(', ')}`);
  if (new Set(read).size !== read.length) problems.push(`${path}: duplicate ${what}`);
}

function document(path: string, text: string, problems: string[]): SourceDocument {
  const title = text
    .split('\n')
    .map((line) => H1.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (title === undefined) problems.push(`${path}: no level-1 heading`);
  return { path, title: title ?? '', gitBlobSha: gitBlobSha(text) };
}

/** `git hash-object` of the content, computed without git. */
export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
