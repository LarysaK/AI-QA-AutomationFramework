import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import { validatedSnapshot } from './build/snapshot-plugin';

/**
 * The dashboard renders exactly one input: the snapshot written by `npm run dashboard:data`,
 * schema-validated and safety-scanned by the snapshot plugin before it is embedded. Nothing else
 * from the repository or `artifacts/` reaches the browser.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SNAPSHOT_FILE = resolve(REPO_ROOT, 'artifacts/dashboard/dashboard-data.json');

/**
 * Production pages get a strict Content-Security-Policy: same-origin scripts and styles only, no
 * inline code, no external images, fonts or connections. (Not applied to the dev server, whose
 * React refresh runtime needs an inline script.)
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
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
    contentSecurityPolicy(),
  ],
  // Relative asset URLs, so the static build works from any sub-path.
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '../../artifacts/dashboard-site'),
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}', 'test-node/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
