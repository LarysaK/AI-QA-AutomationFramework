import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

/**
 * CLI tests: spawn `agents:validate` as a human would, against this repository (read-only),
 * with artifact files in a temporary directory. These run the real guards, including the real
 * static checks and, when authorized, the real Playwright listing.
 */

const REPO = resolve('.');
const CLI = 'agents/orchestrator/validation/cli.ts';
const dir = mkdtempSync(join(tmpdir(), 'agents-cli-'));

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TRACE = { requirements: ['REQ-003'], testCases: ['TC-003-05'] };

function artifactFile(
  name: string,
  testLines: readonly string[],
  extra: Record<string, unknown> = {},
): string {
  const content = ["import { expect, test } from '@playwright/test';", '', ...testLines, ''].join(
    '\n',
  );
  const artifact = {
    artifactType: 'test-proposal',
    schemaVersion: '1.0',
    standardVersion: '1.2',
    agent: { name: 'generator', definitionVersion: '1.0' },
    taskId: `cli-${name}`,
    status: 'READY',
    summary: 'Adds TC-003-05.',
    sourceReferences: [
      { path: 'specs/requestflow/test-plan.md', role: 'test-plan', ids: ['TC-003-05'] },
    ],
    traceability: { ...TRACE, canonicalPatterns: ['CAN-003'] },
    assumptions: [],
    findings: [],
    proposedChanges: [
      {
        path: 'tests/requestflow/api/cli-authorization-fixture.spec.ts',
        changeKind: 'test-change',
        operation: 'create',
        content,
        rationale: 'Implements TC-003-05.',
        traceability: TRACE,
      },
    ],
    payload: {},
    ...extra,
  };
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return path;
}

const VALID_TEST = [
  "test('Reviewer cannot submit a request', { tag: ['@REQ-003', '@TC-003-05'] }, () => {",
  '  expect(1).toBe(1);',
  '});',
];

/** Passes static checks and G-TRACE (REQ-003 is in a string literal), but not runtime tagging. */
const REQ_ONLY_IN_TITLE = [
  "test('Reviewer cannot submit a request (REQ-003)', { tag: ['@TC-003-05'] }, () => {",
  '  expect(1).toBe(1);',
  '});',
];

/** SHA-256 of the artifact file's raw bytes, computed independently of the CLI. */
const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

function cli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; out: string } {
  const result = spawnSync('npx', ['--no-install', 'tsx', CLI, ...args], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    shell: process.platform === 'win32',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('agents:validate CLI and execution authorization', () => {
  const valid = artifactFile('valid', VALID_TEST);

  test('without authorization: INCOMPLETE, exit 3, digest and command printed', () => {
    const { status, out } = cli([valid]);
    assert.equal(status, 3, out);
    assert.match(out, /G-STATIC\s+passed/);
    assert.match(out, /G-DISCOVERY\s+not-authorized/);
    assert.match(out, /\[STD-AUTH-005\]/);
    assert.ok(out.includes(`Artifact SHA-256: ${sha256(valid)}`), out);
    assert.ok(out.includes(`--authorize-execution ${sha256(valid)}`), out);
    assert.match(out, /Result: INCOMPLETE \(execution authorization required\)/);
    assert.doesNotMatch(out, /PASSED/);
  });

  test('with the matching digest: G-DISCOVERY runs and the artifact passes, exit 0', () => {
    const { status, out } = cli([valid, '--authorize-execution', sha256(valid)]);
    assert.equal(status, 0, out);
    assert.match(out, /G-DISCOVERY\s+passed/);
    assert.match(out, /G-RUN\s+passed/);
    assert.match(out, /Result: PASSED/);
  });

  test('a changed artifact with the old digest: INCOMPLETE, exit 3', () => {
    const changed = artifactFile('changed', VALID_TEST);
    const oldDigest = sha256(changed);
    writeFileSync(changed, `${readFileSync(changed, 'utf8')}\n`); // one byte changed
    const { status, out } = cli([changed, `--authorize-execution=${oldDigest}`]);
    assert.equal(status, 3, out);
    assert.match(out, /does not match this artifact/);
  });

  test('an authorized discovery failure: FAILED, exit 1', () => {
    const failing = artifactFile('discovery-failure', REQ_ONLY_IN_TITLE);
    const { status, out } = cli([failing, '--authorize-execution', sha256(failing)]);
    assert.equal(status, 1, out);
    assert.match(out, /G-TRACE\s+passed/);
    assert.match(out, /G-DISCOVERY\s+failed/);
    assert.match(out, /without its requirement tag @REQ-003/);
  });

  test('authorization embedded in the artifact is rejected by G-SCHEMA, exit 1', () => {
    const embedded = artifactFile('embedded', VALID_TEST, {
      executionAuthorization: 'a'.repeat(64),
    });
    const { status, out } = cli([embedded]);
    assert.equal(status, 1, out);
    assert.match(out, /G-SCHEMA\s+failed/);
    assert.match(out, /unexpected property "executionAuthorization"/);
  });

  test('authorization in environment variables is ignored, exit 3', () => {
    const digest = sha256(valid);
    const { status, out } = cli([valid], {
      ...process.env,
      AGENTS_EXECUTION_AUTHORIZATION: digest,
      EXECUTION_AUTHORIZATION: digest,
      AUTHORIZE_EXECUTION: digest,
    });
    assert.equal(status, 3, out);
    assert.match(out, /G-DISCOVERY\s+not-authorized/);
  });

  test('a malformed or missing --authorize-execution value is a usage error, exit 2', () => {
    for (const args of [
      [valid, '--authorize-execution', 'abc123'],
      [valid, '--authorize-execution', sha256(valid).toUpperCase()],
      [valid, '--authorize-execution'],
      [valid, '--authorize-execution', sha256(valid), '--authorize-execution', sha256(valid)],
      [valid, '--unknown'],
    ]) {
      const { status, out } = cli(args);
      assert.equal(status, 2, `${args.join(' ')}\n${out}`);
      assert.match(out, /Usage: npm run agents:validate/);
    }
  });
});
