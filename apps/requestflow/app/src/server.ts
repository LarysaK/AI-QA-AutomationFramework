import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AppError } from './domain/errors';
import { registerApiRoutes } from './http/api-routes';
import { sendError, sendJson } from './http/responses';
import { Router } from './http/router';
import { registerTestRoutes } from './http/test-routes';
import { registerUiRoutes, sendUiNotFound } from './http/ui-routes';
import { AuthService } from './services/auth-service';
import { RequestService } from './services/request-service';
import { type Clock, createMonotonicClock } from './store/clock';
import { MemoryStore } from './store/memory-store';

export interface AppDependencies {
  readonly store: MemoryStore;
  readonly clock: Clock;
}

export interface AppOptions {
  /** Registers test-only routes (see http/test-routes.ts). */
  readonly testHooks: boolean;
}

/** Composes state, services and routes into an HTTP server (not yet listening). */
export function createApp(
  deps: AppDependencies = { store: new MemoryStore(), clock: createMonotonicClock() },
  options: AppOptions = { testHooks: false },
): Server {
  const auth = new AuthService(deps.store);
  const requests = new RequestService(deps.store, deps.clock);

  const router = new Router();
  router.get('/health', ({ res }) => {
    sendJson(res, 200, { status: 'ok' });
  });
  registerApiRoutes(router, { auth, requests });
  registerUiRoutes(router, { auth, requests });
  if (options.testHooks) registerTestRoutes(router, deps.store);

  return createServer((req, res) => {
    void handle(router, req, res);
  });
}

async function handle(router: Router, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const match = router.match(req.method ?? 'GET', pathname);
    if (!match) {
      if (!isJsonPath(pathname)) {
        sendUiNotFound(res);
        return;
      }
      throw new AppError('NOT_FOUND', 'Route not found');
    }
    await match.handler({ req, res, params: match.params });
  } catch (error) {
    sendError(res, error);
  }
}

function isJsonPath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/api' || pathname.startsWith('/api/');
}
