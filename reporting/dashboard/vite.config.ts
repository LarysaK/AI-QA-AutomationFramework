import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import { verifiedAgentLayer } from './build/agent-layer-plugin';
import { validatedHistory } from './build/history-plugin';
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

/**
 * Production pages get a strict Content-Security-Policy: same-origin scripts and styles only, no
 * inline code, no network requests, and no external images or fonts. The app is a static bundle
 * with the snapshot embedded, so it never fetches anything. (Not applied to the dev server, whose
 * React refresh runtime needs an inline script and whose HMR client needs a WebSocket.)
 *
 * Delivered as a <meta> tag, which cannot carry `frame-ancestors` (anti-framing); that requires
 * an HTTP response header from the host. See README.md.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [
    react(),
    validatedSnapshot({ snapshotFile: SNAPSHOT_FILE, repoRoot: REPO_ROOT }),
    validatedHistory({ historyFile: HISTORY_FILE, repoRoot: REPO_ROOT }),
    verifiedAgentLayer({ repoRoot: REPO_ROOT }),
    contentSecurityPolicy(),
  ],
  // Relative asset URLs, so the static build works from any sub-path.
  base: './',
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
