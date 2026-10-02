import { type FullConfig, request } from '@playwright/test';

/**
 * Resets RequestFlow once per test run, after Playwright's webServer is ready and
 * before any test starts. Resetting once (not per test) keeps parallel tests from
 * wiping each other's data; each test still creates the data it needs.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (baseURL === undefined) throw new Error('RequestFlow global setup: baseURL is not set');

  const context = await request.newContext({ baseURL });
  try {
    const response = await context.post('/__test/reset');
    if (response.status() !== 204) {
      throw new Error(
        `RequestFlow reset failed with HTTP ${String(response.status())}. ` +
          'If a RequestFlow server was already running, restart it with REQUESTFLOW_TEST_HOOKS=1 ' +
          'or stop it so Playwright starts its own.',
      );
    }
  } finally {
    await context.dispose();
  }
}
