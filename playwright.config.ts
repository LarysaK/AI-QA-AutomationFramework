import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

/**
 * Deterministic test runtime configuration.
 * This file must never depend on AI agents or LLM services: `npm test` has to
 * work on a machine with no AI tooling at all (see docs/adr/0001).
 */

const isCI = !!process.env['CI'];

/** RequestFlow, the application under test. BASE_URL may override the local default. */
const baseURL = process.env['BASE_URL'] || 'http://127.0.0.1:3100';
const aut = new URL(baseURL);

export default defineConfig({
  testDir: './tests',
  outputDir: './artifacts/test-results',
  globalSetup: './apps/requestflow/global-setup.ts',

  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  ...(isCI ? { workers: 2 } : {}),

  reporter: [
    ['list'],
    ['html', { outputFolder: './artifacts/playwright-report', open: 'never' }],
    ['json', { outputFile: './artifacts/results/results.json' }],
  ],

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Starts RequestFlow for the run (or reuses one already running locally).
  // Test hooks are enabled only here, for automated tests.
  webServer: {
    command: 'npm run aut:start',
    url: `${baseURL}/health`,
    reuseExistingServer: !isCI,
    env: { HOST: aut.hostname, PORT: aut.port, REQUESTFLOW_TEST_HOOKS: '1' },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
