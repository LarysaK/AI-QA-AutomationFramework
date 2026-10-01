import { loadConfig } from './config';
import { createApp } from './server';

const config = loadConfig();
const server = createApp();

server.listen(config.port, config.host, () => {
  console.log(`RequestFlow listening on http://${config.host}:${String(config.port)}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
