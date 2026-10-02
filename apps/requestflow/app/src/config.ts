export interface Config {
  readonly host: string;
  readonly port: number;
  /** Enables test-only routes such as POST /__test/reset. Never enable outside automated tests. */
  readonly testHooks: boolean;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3100;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env['HOST'] ?? DEFAULT_HOST,
    port: parsePort(env['PORT']),
    testHooks: env['REQUESTFLOW_TEST_HOOKS'] === '1',
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${value}"`);
  }
  return port;
}
