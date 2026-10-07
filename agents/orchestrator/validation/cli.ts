import { readFileSync } from 'node:fs';

import type { GuardResult } from './types';
import { GUARD_ORDER, hasFailed, validateArtifact } from './validate';

/**
 * Usage: npm run agents:validate -- <artifact.json>
 *
 * Validates one agent artifact against the repository in the current directory.
 * Read-only. Exit codes: 0 = all implemented guards passed, 1 = validation failed,
 * 2 = usage error or unreadable artifact file.
 */
function main(args: readonly string[]): number {
  const [artifactFile, ...extra] = args;
  if (artifactFile === undefined || extra.length > 0) {
    console.error('Usage: npm run agents:validate -- <artifact.json>');
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(artifactFile, 'utf8');
  } catch {
    console.error(`Cannot read artifact file: ${artifactFile}`);
    return 2;
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    print([
      {
        guard: 'G-SCHEMA',
        status: 'failed',
        failures: [
          { guard: 'G-SCHEMA', ruleIds: ['STD-ART-001'], reason: 'artifact is not valid JSON' },
        ],
      },
    ]);
    return 1;
  }

  const results = validateArtifact(document, { repoRoot: process.cwd() });
  print(results);
  return hasFailed(results) ? 1 : 0;
}

function print(results: readonly GuardResult[]): void {
  for (const result of results) {
    console.log(`${result.guard.padEnd(9)} ${result.status}`);
    for (const failure of result.failures) {
      const where = failure.path === undefined ? '' : ` ${failure.path}:`;
      console.log(`  [${failure.ruleIds.join(', ')}]${where} ${failure.reason}`);
    }
  }
  console.log(hasFailed(results) ? 'Result: FAILED' : `Result: PASSED (${GUARD_ORDER.join(', ')})`);
}

process.exitCode = main(process.argv.slice(2));
