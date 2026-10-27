import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { GuardResult } from './types';
import { GUARD_ORDER, outcomeOf, validateArtifact } from './validate';

/**
 * Usage: npm run agents:validate -- <artifact.json> [--authorize-execution <sha256>]
 *
 * Validates one agent artifact against the repository in the current directory. Read-only.
 *
 * Execution-capable guards (G-DISCOVERY) run proposed code and therefore run only with a human
 * execution authorization (gate H7): the SHA-256 of the exact artifact bytes, given on the
 * command line. It is never read from the artifact or the environment. Authorization is a
 * human checkpoint; it is not proof of code review and not a security sandbox.
 *
 * Exit codes: 0 = every guard passed, 1 = a guard failed, 2 = usage error or unreadable
 * artifact file, 3 = incomplete: execution authorization missing or not matching.
 *
 * The outcomes correspond to the Standard's pipeline statuses (section 7.2): exit 0 =
 * `VALIDATED`, exit 1 = `VALIDATION_FAILED`, exit 3 = `EXECUTION_AUTHORIZATION_REQUIRED`.
 */

const USAGE = 'Usage: npm run agents:validate -- <artifact.json> [--authorize-execution <sha256>]';
const SHA256 = /^[0-9a-f]{64}$/;

function main(args: readonly string[]): number {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    console.error(USAGE);
    return 2;
  }

  // Read once: the same bytes are digested and validated.
  let bytes: Buffer;
  try {
    bytes = readFileSync(parsed.artifactFile);
  } catch {
    console.error(`Cannot read artifact file: ${parsed.artifactFile}`);
    return 2;
  }
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');

  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
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
    console.log('Result: FAILED');
    return 1;
  }

  const results = validateArtifact(document, {
    repoRoot: process.cwd(),
    artifactSha256,
    ...(parsed.authorization === undefined ? {} : { executionAuthorization: parsed.authorization }),
  });
  print(results);

  const outcome = outcomeOf(results);
  if (outcome === 'failed') {
    console.log('Result: FAILED');
    return 1;
  }
  if (outcome === 'incomplete') {
    printAuthorizationGuidance(document, parsed.artifactFile, artifactSha256);
    console.log('Result: INCOMPLETE (execution authorization required)');
    return 3;
  }
  console.log(`Result: PASSED (${GUARD_ORDER.join(', ')})`);
  return 0;
}

function parseArgs(
  args: readonly string[],
): { artifactFile: string; authorization?: string } | string {
  let artifactFile: string | undefined;
  let authorization: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--authorize-execution' || arg.startsWith('--authorize-execution=')) {
      if (authorization !== undefined) return '--authorize-execution was given more than once';
      authorization = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[(index += 1)];
      if (authorization === undefined || !SHA256.test(authorization)) {
        return '--authorize-execution needs the 64-character lowercase hex SHA-256 of the artifact';
      }
    } else if (arg.startsWith('-')) {
      return `Unknown option: ${arg}`;
    } else if (artifactFile === undefined) {
      artifactFile = arg;
    } else {
      return 'Only one artifact file can be validated at a time';
    }
  }
  if (artifactFile === undefined) return 'Missing artifact file';
  return authorization === undefined ? { artifactFile } : { artifactFile, authorization };
}

function print(results: readonly GuardResult[]): void {
  for (const result of results) {
    console.log(`${result.guard.padEnd(12)} ${result.status}`);
    for (const failure of result.failures) {
      const where = failure.path === undefined ? '' : ` ${failure.path}:`;
      // Multi-line reasons (tool output) are indented under their failure line.
      const reason = failure.reason.split('\n').join('\n      ');
      console.log(`  [${failure.ruleIds.join(', ')}]${where} ${reason}`);
    }
    for (const note of result.notes ?? []) console.log(`  ${note}`);
  }
}

function printAuthorizationGuidance(document: unknown, artifactFile: string, sha256: string): void {
  const changes =
    (document as { proposedChanges?: readonly { path: string }[] }).proposedChanges ?? [];
  console.log(`Artifact SHA-256: ${sha256}`);
  if (changes.length === 0) {
    // For example a Planner test-plan proposal: there is no proposed code, so there is nothing
    // that H7 could authorize. No authorization command is offered.
    console.log('The artifact proposes no files: there is no proposed code to execute.');
    console.log('Do not authorize execution (H7) for it; it is reviewed at its approval gate.');
    return;
  }
  console.log('Proposed files that execution-capable guards would load:');
  for (const change of changes) console.log(`  ${change.path}`);
  console.log('Review the artifact. To authorize execution of its proposed code, run:');
  console.log(`  npm run agents:validate -- ${artifactFile} --authorize-execution ${sha256}`);
}

process.exitCode = main(process.argv.slice(2));
