import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ApprovedIds, loadApprovedIds } from '../validation/approved-ids';
import { idsInStringLiterals } from '../validation/trace-guard';

/**
 * Deterministic test-case selection (Generator definition: Preconditions). Runs before any
 * model call; every problem stops the run.
 */

export type TestLevel = 'API' | 'UI' | 'E2E';

export interface SelectedTestCase {
  readonly app: string;
  readonly testCase: string;
  readonly requirement: string;
  readonly level: TestLevel;
  /** The test case's plan row, verbatim. */
  readonly row: string;
  /** Existing test files that mention the ID in a string literal (not proof of coverage). */
  readonly references: readonly string[];
  readonly approved: ApprovedIds;
}

export class GeneratorStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratorStop';
  }
}

const APP = /^[a-z0-9][a-z0-9-]*$/;
const TC_ID = /^TC-\d{3}-\d{2}$/;
const LEVELS: readonly TestLevel[] = ['API', 'UI', 'E2E'];

export function selectTestCase(
  repoRoot: string,
  app: string,
  testCase: string,
  allowReferenced: boolean,
): SelectedTestCase {
  if (!APP.test(app) || !existsSync(join(repoRoot, 'specs', app, 'requirements.md'))) {
    throw new GeneratorStop(`unknown application "${app}": specs/${app}/requirements.md not found`);
  }
  if (!TC_ID.test(testCase))
    throw new GeneratorStop(`"${testCase}" is not a test-case ID (TC-NNN-NN)`);

  const { ids, errors } = loadApprovedIds(repoRoot);
  if (errors.length > 0) {
    throw new GeneratorStop(`approved documents cannot be parsed:\n  ${errors.join('\n  ')}`);
  }
  const requirement = ids.testCases.get(testCase);
  if (requirement === undefined) {
    throw new GeneratorStop(
      `${testCase} is not an approved test case in specs/${app}/test-plan.md`,
    );
  }

  const columns = rowColumns(
    readFileSync(join(repoRoot, 'specs', app, 'test-plan.md'), 'utf8'),
    testCase,
  );
  const level = columns.cells['Level'];
  const automation = columns.cells['Automation'];
  if (level === undefined || automation === undefined) {
    throw new GeneratorStop(
      `the table containing ${testCase} has no "Level" and "Automation" columns`,
    );
  }
  if (!LEVELS.includes(level as TestLevel)) {
    throw new GeneratorStop(
      `${testCase} has an unsupported level "${level}" (expected API, UI or E2E)`,
    );
  }
  if (automation !== 'Yes') {
    throw new GeneratorStop(
      `${testCase} is marked "Automation: ${automation}" in the test plan; it is not generated`,
    );
  }

  const references = referencingFiles(repoRoot, testCase);
  if (references.length > 0 && !allowReferenced) {
    throw new GeneratorStop(
      `${testCase} is referenced by ${references.join(', ')}. ` +
        'This is a static reference, not verified coverage. ' +
        'Re-run with --allow-referenced-tc to generate anyway.',
    );
  }

  return {
    app,
    testCase,
    requirement,
    level: level as TestLevel,
    row: columns.row,
    references,
    approved: ids,
  };
}

/** The test case's row and its cells keyed by the table's header names. */
function rowColumns(
  markdown: string,
  testCase: string,
): { row: string; cells: Record<string, string> } {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => cells(line)[0] === testCase);
  const row = lines[index];
  if (row === undefined) throw new GeneratorStop(`${testCase} row not found in the test plan`);

  // The header is the table line directly above the separator line that starts the table.
  let header: string[] | undefined;
  for (let i = index - 1; i > 0; i -= 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('|')) break;
    if (/^\|[\s|:-]+\|\s*$/.test(line)) {
      header = cells(lines[i - 1] ?? '');
      break;
    }
  }
  if (header === undefined)
    throw new GeneratorStop(`no table header found above the ${testCase} row`);

  const values = cells(row);
  const result: Record<string, string> = {};
  header.forEach((name, i) => {
    result[name] = values[i] ?? '';
  });
  return { row, cells: result };
}

function cells(line: string): string[] {
  if (!line.startsWith('|')) return [];
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Existing `tests/**` TypeScript files whose string literals contain the ID. */
function referencingFiles(repoRoot: string, testCase: string): string[] {
  const testsDir = join(repoRoot, 'tests');
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => idsInStringLiterals(readFileSync(file, 'utf8'), file).includes(testCase))
    .map((file) =>
      file
        .slice(repoRoot.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort();
}
