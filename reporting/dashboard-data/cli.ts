import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { buildSnapshot, serializeSnapshot } from './build';
import { SnapshotError } from './spec-source';

/**
 * Builds the QA Dashboard data snapshot and prints a summary.
 *
 *   npm run dashboard:data
 *
 * Writes artifacts/dashboard/dashboard-data.json (gitignored). Exit 0 on success, 1 if the
 * snapshot cannot be built safely. Reads only specs/ and the committed tests/; never
 * artifacts/, never the environment beyond what Playwright and git need to start.
 */

interface Summary {
  readonly requirements: number;
  readonly testCases: number;
  readonly testCasesByLevel: Record<string, number>;
  readonly testCasesByPriority: Record<string, number>;
  readonly testCasesByAutomationIntent: Record<string, number>;
  readonly canonicals: number;
  readonly testInstances: number;
  readonly linkedTestCases: number;
  readonly linkedTestCasesWithIntentYes: number;
}

const repoRoot = resolve(__dirname, '..', '..');
const outFile = join(repoRoot, 'artifacts', 'dashboard', 'dashboard-data.json');

try {
  const snapshot = buildSnapshot(repoRoot) as {
    source: { commit: string };
    summary: Summary;
  };
  mkdirSync(join(repoRoot, 'artifacts', 'dashboard'), { recursive: true });
  writeFileSync(outFile, serializeSnapshot(snapshot));

  const s = snapshot.summary;
  const pairs = (record: Record<string, number>): string =>
    Object.entries(record)
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(' / ');
  const lines = [
    `Snapshot:           ${relative(repoRoot, outFile)} (schema-valid, public-safe)`,
    `Source commit:      ${snapshot.source.commit}`,
    `Requirements:       ${String(s.requirements)}`,
    `Test cases:         ${String(s.testCases)}`,
    `  by level:         ${pairs(s.testCasesByLevel)}`,
    `  by priority:      ${pairs(s.testCasesByPriority)}`,
    `  automation intent: ${pairs(s.testCasesByAutomationIntent)}`,
    `Canonical tests:    ${String(s.canonicals)}`,
    `Test instances:     ${String(s.testInstances)} committed (Playwright discovery)`,
    `Linked test cases:  ${String(s.linkedTestCases)} (tagged on a committed test; not an execution result)`,
    `  of intent Yes:    ${String(s.linkedTestCasesWithIntentYes)} / ${String(s.testCasesByAutomationIntent['Yes'] ?? 0)}`,
    'Execution (CI):     no CI runs recorded; local Playwright results are not used',
  ];
  console.log(lines.join('\n'));
} catch (error) {
  if (error instanceof SnapshotError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
