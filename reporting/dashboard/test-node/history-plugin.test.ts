// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';

import { SUITE_STEPS } from '../../ci/collect';
import { validateExport } from '../../ci/history-export';
import { validatedHistory } from '../build/history-plugin';
import { validatedSnapshot } from '../build/snapshot-plugin';
import { SUITES } from '../src/data/history';

/**
 * Real production builds with a temporary CI history export: the history plugin embeds only an
 * export that passes the exporter's own validation and the public-safety scan; a missing export
 * is embedded as null unless it is required. The fixture is the real export of ci-history at
 * f51780b; variants are derived here.
 */

const DASHBOARD = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(DASHBOARD, '../..');
const SNAPSHOT = resolve(REPO_ROOT, 'artifacts/dashboard/dashboard-data.json');
const FIXTURE = resolve(DASHBOARD, 'test/fixtures/ci-history.json');
type Json = Record<string, unknown>;
const fixture = (): Json => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Json;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function buildWith(history: unknown, required = false): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-history-build-'));
  dirs.push(dir);
  const historyFile = join(dir, 'ci-history.json');
  if (history !== null)
    writeFileSync(historyFile, typeof history === 'string' ? history : JSON.stringify(history));
  const outDir = join(dir, 'site');
  await build({
    root: DASHBOARD,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      react(),
      validatedSnapshot({ snapshotFile: SNAPSHOT, repoRoot: REPO_ROOT }),
      validatedHistory({ historyFile, repoRoot: REPO_ROOT, required }),
    ],
    build: { outDir, emptyOutDir: true },
  });
  return outDir;
}

const outputText = (outDir: string): string =>
  existsSync(outDir)
    ? readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
        .join('\n')
    : '';

async function refused(history: unknown, reason: RegExp, required = false): Promise<void> {
  let error: unknown;
  try {
    await buildWith(history, required);
  } catch (e) {
    error = e;
  }
  expect(String(error)).toMatch(reason);
  expect(outputText(join(dirs[dirs.length - 1] ?? '', 'site'))).not.toContain('39930898982');
}

describe('CI history plugin: production build gate', () => {
  test('the real export is valid and is embedded', async () => {
    expect(validateExport(fixture())).toEqual([]);
    const text = outputText(await buildWith(fixture()));
    expect(text).toContain('39930898982');
    expect(text).toContain('f51780b797545b780c1044b49cbd11d486d9158a');
  });

  test('a missing export is embedded as null, so the page says it is not included', async () => {
    const text = outputText(await buildWith(null));
    expect(text).not.toContain('39930898982');
    expect(text).toContain('Execution history is not included in this build');
  });

  test('a missing export fails the build when it is required', async () => {
    await refused(null, /ci-history\.json is missing and DASHBOARD_REQUIRE_CI_HISTORY=1/, true);
  });

  test('an export that is not JSON fails the build', async () => {
    await refused('{', /is not JSON; nothing was embedded/);
  });

  test('a record that fails the ci-run schema fails the build (derived)', async () => {
    const history = fixture();
    ((history['records'] as Json[])[0] as Json)['conclusion'] = 'neutral';
    await refused(history, /CI history export is not valid; nothing was embedded/);
  });

  test('records out of order or of another repository fail the build (derived)', async () => {
    const reversed = fixture();
    (reversed['records'] as Json[]).reverse();
    await refused(reversed, /records are not newest first/);
    const foreign = fixture();
    ((foreign['records'] as Json[])[0] as Json)['repository'] = 'someone/else';
    await refused(foreign, /another repository/);
  });

  test('a coverage section for another commit fails the build (derived)', async () => {
    const history = fixture();
    (history['coverage'] as Json)['commit'] = 'a'.repeat(40);
    await refused(history, /coverage: checked another commit/);
  });

  test('content that is not public-safe fails the build (derived)', async () => {
    const history = fixture();
    const steps = ((history['records'] as Json[])[0] as Json)['steps'] as Json[];
    (steps[0] as Json)['name'] = 'see /Users/someone/secret';
    await refused(history, /not public-safe; nothing was embedded/);
  });

  test('the dashboard names each suite by its CI step', () => {
    for (const [id, step] of Object.entries(SUITE_STEPS)) {
      expect(SUITES[id as keyof typeof SUITES].label).toBe(step);
    }
  });
});
