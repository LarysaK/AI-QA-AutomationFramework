export interface Config {
  readonly host: string;
  readonly port: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3100;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env['HOST'] ?? DEFAULT_HOST,
    port: parsePort(env['PORT']),
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
