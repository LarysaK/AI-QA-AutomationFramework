// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';

import { validateSnapshot } from '../../dashboard-data/validate';
import { verifiedAgentLayer } from '../build/agent-layer-plugin';
import { validatedHistory } from '../build/history-plugin';
import { validatedSnapshot } from '../build/snapshot-plugin';

/**
 * Real production builds with a temporary snapshot: the snapshot plugin must refuse anything the
 * builder itself would refuse, and nothing may reach the bundle when it does.
 */

const DASHBOARD = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(DASHBOARD, '../..');
const REAL_SNAPSHOT = resolve(REPO_ROOT, 'artifacts/dashboard/dashboard-data.json');
const SECRET = 'sk-ant-api03-TESTSECRETNOTAREALKEY';

type Json = Record<string, unknown>;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function realSnapshot(): Json {
  return JSON.parse(readFileSync(REAL_SNAPSHOT, 'utf8')) as Json;
}

/** Builds the site with `snapshot` (or a missing file when it is null); returns the output dir. */
async function buildWith(snapshot: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-build-'));
  dirs.push(dir);
  const snapshotFile = join(dir, 'dashboard-data.json');
  if (snapshot !== null) writeFileSync(snapshotFile, JSON.stringify(snapshot));
  const outDir = join(dir, 'site');
  await build({
    root: DASHBOARD,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      react(),
      validatedSnapshot({ snapshotFile, repoRoot: REPO_ROOT }),
      // No CI history export in these builds (embedded as null); see history-plugin.test.ts.
      validatedHistory({
        historyFile: join(dir, 'no-ci-history.json'),
        repoRoot: REPO_ROOT,
        required: false,
      }),
      verifiedAgentLayer({ repoRoot: REPO_ROOT }),
    ],
    build: { outDir, emptyOutDir: true },
  });
  return outDir;
}

function outputText(outDir: string): string {
  if (!existsSync(outDir)) return '';
  return readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

function outDirOf(error: unknown): string {
  // The output directory is inside the temp directory created for this build.
  const dir = dirs[dirs.length - 1];
  expect(dir, String(error)).toBeDefined();
  return join(dir ?? '', 'site');
}

function at(snapshot: Json, path: readonly (string | number)[]): Json {
  let node: unknown = snapshot;
  for (const key of path) node = (node as Record<string | number, unknown>)[key];
  return node as Json;
}

describe('snapshot plugin: production build safety gate', () => {
  test('control: the real snapshot builds, and the bundle contains its data but no test secret', async () => {
    const outDir = await buildWith(realSnapshot());
    const text = outputText(outDir);
    expect(text).toContain('TC-003-07');
    expect(text).not.toContain(SECRET);
  }, 60_000);

  const unsafe: [string, (snapshot: Json) => void, RegExp][] = [
    [
      'a credential in a requirement',
      (s) => {
        const requirement = at(s, ['requirements', 0]);
        requirement['markdown'] = `${String(requirement['markdown'])}\n\nKey: ${SECRET}`;
      },
      /\/requirements\/0\/markdown: credential/,
    ],
    [
      'an absolute local path in a scenario',
      (s) => {
        const tc = at(s, ['testCases', 0]);
        tc['scenario'] = `${String(tc['scenario'])} (see /Users/alex/.ssh/id_rsa ${SECRET})`;
      },
      /\/testCases\/0\/scenario: absolute path/,
    ],
    [
      "the repository's absolute path in the plan preamble",
      (s) => {
        const plan = at(s, ['testPlan']);
        plan['preamble'] = `${String(plan['preamble'])} ${REPO_ROOT}/x ${SECRET}`;
      },
      /\/testPlan\/preamble: local path/,
    ],
    [
      "an e-mail address in a canonical's Purpose/Flow",
      (s) => {
        const canonical = at(s, ['canonicals', 0]);
        canonical['markdown'] =
          `${String(canonical['markdown'])} Contact someone@example.com ${SECRET}`;
      },
      /\/canonicals\/0\/markdown: e-mail address/,
    ],
  ];

  for (const [name, inject, expected] of unsafe) {
    test(`a schema-valid snapshot with ${name} fails the build and nothing is emitted`, async () => {
      const snapshot = realSnapshot();
      inject(snapshot);
      expect(validateSnapshot(snapshot), 'the unsafe snapshot is schema-valid').toEqual([]);
      let failure: unknown;
      try {
        await buildWith(snapshot);
      } catch (error) {
        failure = error;
      }
      expect(failure, 'the build must fail').toBeDefined();
      const message = (failure as Error).message;
      expect(message).toMatch(/not public-safe; nothing was embedded/);
      expect(message).toMatch(expected);
      expect(message, 'findings never echo the value').not.toContain(SECRET);
      expect(outputText(outDirOf(failure))).not.toContain(SECRET);
    }, 60_000);
  }

  test('a schema-invalid snapshot fails the build', async () => {
    const snapshot = realSnapshot();
    at(snapshot, ['execution', 'ci'])['runs'] = [{ status: 'passed' }];
    await expect(buildWith(snapshot)).rejects.toThrow(/not valid \(schema 1\.1\)/);
  }, 60_000);

  test('a missing snapshot fails the build', async () => {
    await expect(buildWith(null)).rejects.toThrow(/missing or not JSON/);
  }, 60_000);
});
