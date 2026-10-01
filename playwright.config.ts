import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

/**
 * Deterministic test runtime configuration.
 * This file must never depend on AI agents or LLM services: `npm test` has to
 * work on a machine with no AI tooling at all (see docs/adr/0001).
 */

const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests',
  outputDir: './artifacts/test-results',

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
    ...(process.env['BASE_URL'] ? { baseURL: process.env['BASE_URL'] } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
