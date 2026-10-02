import { loadConfig } from './config';
import { createApp } from './server';

const config = loadConfig();
const server = createApp(undefined, { testHooks: config.testHooks });

server.listen(config.port, config.host, () => {
  console.log(`RequestFlow listening on http://${config.host}:${String(config.port)}`);
  if (config.testHooks) console.log('Test hooks enabled (REQUESTFLOW_TEST_HOOKS=1)');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
