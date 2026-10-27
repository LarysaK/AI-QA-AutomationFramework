import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { verifiedAgentLayer } from './build/agent-layer-plugin';
import { validatedHistory } from './build/history-plugin';
import { contentSecurityPolicy, notFoundPage, resolveBase } from './build/site';
import { validatedSnapshot } from './build/snapshot-plugin';

/**
 * The dashboard renders three build-time inputs, each validated and safety-scanned in Node before
 * it is embedded: the snapshot written by `npm run dashboard:data` (approved requirements, test
 * plan, test cases, committed tests); when present, the CI execution history exported from the
 * ci-history branch by `reporting/ci/history-export-cli.ts`; and the agent layer facts of
 * src/data/agents.ts, checked against the committed files of HEAD. Nothing else from the
 * repository or `artifacts/` reaches the browser, and the browser fetches nothing.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SNAPSHOT_FILE = resolve(REPO_ROOT, 'artifacts/dashboard/dashboard-data.json');
const HISTORY_FILE = resolve(REPO_ROOT, 'artifacts/dashboard/ci-history.json');

/** `./` by default; the GitHub Pages workflow sets the repository subpath (build/site.ts). */
const BASE = resolveBase(process.env['DASHBOARD_BASE']);

export default defineConfig({
  plugins: [
    react(),
    validatedSnapshot({ snapshotFile: SNAPSHOT_FILE, repoRoot: REPO_ROOT }),
    validatedHistory({ historyFile: HISTORY_FILE, repoRoot: REPO_ROOT }),
    verifiedAgentLayer({ repoRoot: REPO_ROOT }),
    contentSecurityPolicy(),
    notFoundPage(BASE),
  ],
  base: BASE,
  build: {
    outDir: resolve(import.meta.dirname, '../../artifacts/dashboard-site'),
    emptyOutDir: true,
    sourcemap: false,
    // The modulepreload polyfill is the bundle's only fetch() call. A single entry chunk has
    // nothing to preload, and connect-src 'none' would block it anyway.
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}', 'test-node/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
