import type { IncomingMessage } from 'node:http';

import { notFound } from '../domain/errors';
import type { User } from '../domain/types';
import type { AuthService } from '../services/auth-service';
import type { RequestService } from '../services/request-service';
import { readJsonBody } from './body';
import { expiredSessionCookie, readSessionId, sessionCookie } from './cookies';
import { sendJson, sendNoContent } from './responses';
import type { RouteContext, Router } from './router';

export interface ApiServices {
  readonly auth: AuthService;
  readonly requests: RequestService;
}

/**
 * JSON API adapter (Requirements v1.2: API). Handlers only translate HTTP to
 * service calls and back; every business rule lives in the services.
 *
 * Protected handlers resolve the actor first (401), then read the body, so a
 * missing session wins over a malformed body.
 */
export function registerApiRoutes(router: Router, { auth, requests }: ApiServices): void {
  const actorOf = (req: IncomingMessage): User => auth.authenticate(readSessionId(req));

  router.post('/api/auth/login', async ({ req, res }) => {
    const { sessionId, user } = auth.login(await readJsonBody(req));
    res.setHeader('Set-Cookie', sessionCookie(sessionId));
    sendJson(res, 200, { id: user.id, name: user.name, role: user.role });
  });

  router.post('/api/auth/logout', ({ req, res }) => {
    auth.logout(readSessionId(req));
    res.setHeader('Set-Cookie', expiredSessionCookie());
    sendNoContent(res);
  });

  router.post('/api/requests', async ({ req, res }) => {
    const actor = actorOf(req);
    sendJson(res, 201, requests.create(actor, await readJsonBody(req)));
  });

  router.get('/api/requests', ({ req, res }) => {
    sendJson(res, 200, { items: requests.listOwn(actorOf(req)) });
  });

  router.get('/api/requests/:id', ({ req, res, params }) => {
    sendJson(res, 200, requests.get(actorOf(req), idParam(params)));
  });

  router.patch('/api/requests/:id', async ({ req, res, params }) => {
    const actor = actorOf(req);
    sendJson(res, 200, requests.update(actor, idParam(params), await readJsonBody(req)));
  });

  router.patch('/api/requests/:id/submit', ({ req, res, params }) => {
    sendJson(res, 200, requests.submit(actorOf(req), idParam(params)));
  });

  router.patch('/api/requests/:id/approve', async ({ req, res, params }) => {
    const actor = actorOf(req);
    sendJson(res, 200, requests.approve(actor, idParam(params), await readJsonBody(req)));
  });

  router.patch('/api/requests/:id/reject', async ({ req, res, params }) => {
    const actor = actorOf(req);
    sendJson(res, 200, requests.reject(actor, idParam(params), await readJsonBody(req)));
  });

  router.get('/api/review-queue', ({ req, res }) => {
    sendJson(res, 200, { items: requests.reviewQueue(actorOf(req)) });
  });
}

function idParam(params: RouteContext['params']): string {
  const id = params['id'];
  if (id === undefined) throw notFound();
  return id;
}
