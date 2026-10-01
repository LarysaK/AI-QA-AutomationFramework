import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppError, notFound } from '../domain/errors';
import type { User } from '../domain/types';
import type { AuthService } from '../services/auth-service';
import type { RequestService } from '../services/request-service';
import {
  FORBIDDEN_PAGE,
  NOT_FOUND_PAGE,
  SERVER_ERROR_PAGE,
  renderErrorPage,
} from '../ui/pages/error';
import { renderLoginPage } from '../ui/pages/login';
import { renderMyRequestsPage } from '../ui/pages/my-requests';
import { renderRequestDetailsPage } from '../ui/pages/request-details';
import { type RequestFormValues, renderRequestFormPage } from '../ui/pages/request-form';
import { renderReviewQueuePage } from '../ui/pages/review-queue';
import { readFormBody } from './body';
import { expiredSessionCookie, readSessionId, sessionCookie } from './cookies';
import { redirect, sendHtml } from './responses';
import type { Handler, RouteContext, Router } from './router';

export interface UiServices {
  readonly auth: AuthService;
  readonly requests: RequestService;
}

/**
 * Server-rendered UI adapter. Like the JSON API, handlers only translate between
 * HTML forms and the shared services; every business rule lives in the services.
 *
 * Errors map to: 401 → redirect to /login, 403/404/409 → error page,
 * 400 → the form is re-rendered with its feedback.
 */
export function registerUiRoutes(router: Router, { auth, requests }: UiServices): void {
  const actorOf = (req: IncomingMessage): User => auth.authenticate(readSessionId(req));
  const optionalActor = (req: IncomingMessage): User | undefined => {
    try {
      return actorOf(req);
    } catch {
      return undefined;
    }
  };

  const page =
    (handler: Handler): Handler =>
    async (ctx) => {
      try {
        await handler(ctx);
      } catch (error) {
        sendUiError(ctx.res, error, optionalActor(ctx.req));
      }
    };

  router.get(
    '/',
    page(({ req, res }) => {
      const actor = optionalActor(req);
      redirect(res, actor ? homeOf(actor) : '/login');
    }),
  );

  router.get(
    '/login',
    page(({ res }) => {
      sendHtml(res, 200, renderLoginPage());
    }),
  );

  router.post(
    '/login',
    page(async ({ req, res }) => {
      const form = await readFormBody(req);
      try {
        const { sessionId, user } = auth.login({ userId: form.get('userId') ?? undefined });
        res.setHeader('Set-Cookie', sessionCookie(sessionId));
        redirect(res, homeOf(user));
      } catch (error) {
        if (!isValidationError(error)) throw error;
        sendHtml(res, 400, renderLoginPage(error.issues));
      }
    }),
  );

  router.post(
    '/logout',
    page(({ req, res }) => {
      auth.logout(readSessionId(req));
      res.setHeader('Set-Cookie', expiredSessionCookie());
      redirect(res, '/login');
    }),
  );

  router.get(
    '/requests',
    page(({ req, res }) => {
      const actor = actorOf(req);
      sendHtml(res, 200, renderMyRequestsPage(actor, requests.listOwn(actor)));
    }),
  );

  router.get(
    '/requests/new',
    page(({ req, res }) => {
      const actor = actorOf(req);
      requests.assertCanCreate(actor);
      const empty = { title: '', description: '', amount: '' };
      sendHtml(res, 200, renderRequestFormPage(actor, { kind: 'create' }, empty));
    }),
  );

  router.post(
    '/requests',
    page(async ({ req, res }) => {
      const actor = actorOf(req);
      const values = requestFormValues(await readFormBody(req));
      try {
        const created = requests.create(actor, requestPayload(values));
        redirect(res, detailsPath(created.id));
      } catch (error) {
        if (!isValidationError(error)) throw error;
        sendHtml(res, 400, renderRequestFormPage(actor, { kind: 'create' }, values, error.issues));
      }
    }),
  );

  router.get(
    '/requests/:id',
    page(({ req, res, params }) => {
      const actor = actorOf(req);
      sendHtml(res, 200, renderRequestDetailsPage(actor, requests.get(actor, idParam(params))));
    }),
  );

  router.get(
    '/requests/:id/edit',
    page(({ req, res, params }) => {
      const actor = actorOf(req);
      const request = requests.getEditable(actor, idParam(params));
      const values = {
        title: request.title,
        description: request.description,
        amount: String(request.amount),
      };
      sendHtml(
        res,
        200,
        renderRequestFormPage(actor, { kind: 'edit', requestId: request.id }, values),
      );
    }),
  );

  router.post(
    '/requests/:id/edit',
    page(async ({ req, res, params }) => {
      const actor = actorOf(req);
      const id = idParam(params);
      const values = requestFormValues(await readFormBody(req));
      try {
        requests.update(actor, id, requestPayload(values));
        redirect(res, detailsPath(id));
      } catch (error) {
        if (!isValidationError(error)) throw error;
        const mode = { kind: 'edit', requestId: id } as const;
        sendHtml(res, 400, renderRequestFormPage(actor, mode, values, error.issues));
      }
    }),
  );

  router.post(
    '/requests/:id/submit',
    page(({ req, res, params }) => {
      const id = idParam(params);
      requests.submit(actorOf(req), id);
      redirect(res, detailsPath(id));
    }),
  );

  router.get(
    '/review-queue',
    page(({ req, res }) => {
      const actor = actorOf(req);
      sendHtml(res, 200, renderReviewQueuePage(actor, requests.reviewQueue(actor)));
    }),
  );

  router.post(
    '/requests/:id/approve',
    page(({ req, res, params }) => {
      const id = idParam(params);
      requests.approve(actorOf(req), id, undefined);
      redirect(res, detailsPath(id));
    }),
  );

  router.post(
    '/requests/:id/reject',
    page(async ({ req, res, params }) => {
      const actor = actorOf(req);
      const id = idParam(params);
      const comment = (await readFormBody(req)).get('comment') ?? '';
      try {
        requests.reject(actor, id, { comment });
        redirect(res, detailsPath(id));
      } catch (error) {
        if (!isValidationError(error)) throw error;
        const request = requests.get(actor, id);
        const state = { comment, issues: error.issues };
        sendHtml(res, 400, renderRequestDetailsPage(actor, request, state));
      }
    }),
  );
}

/** HTML 404 for paths that match no route outside the JSON API. */
export function sendUiNotFound(res: ServerResponse): void {
  sendHtml(res, 404, renderErrorPage(undefined, NOT_FOUND_PAGE));
}

function sendUiError(res: ServerResponse, error: unknown, actor: User | undefined): void {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'UNAUTHENTICATED':
        redirect(res, '/login');
        return;
      case 'FORBIDDEN':
        sendHtml(res, 403, renderErrorPage(actor, FORBIDDEN_PAGE));
        return;
      case 'NOT_FOUND':
        sendHtml(res, 404, renderErrorPage(actor, NOT_FOUND_PAGE));
        return;
      case 'INVALID_STATE_TRANSITION':
        sendHtml(
          res,
          409,
          renderErrorPage(actor, { heading: 'Action not available', message: error.message }),
        );
        return;
      case 'VALIDATION_ERROR':
        sendHtml(
          res,
          400,
          renderErrorPage(actor, { heading: 'Invalid request', message: error.message }),
        );
        return;
    }
  }
  console.error(error);
  sendHtml(res, 500, renderErrorPage(actor, SERVER_ERROR_PAGE));
}

function isValidationError(error: unknown): error is AppError {
  return error instanceof AppError && error.code === 'VALIDATION_ERROR';
}

function homeOf(user: User): string {
  return user.role === 'EMPLOYEE' ? '/requests' : '/review-queue';
}

function detailsPath(id: string): string {
  return `/requests/${encodeURIComponent(id)}`;
}

function idParam(params: RouteContext['params']): string {
  const id = params['id'];
  if (id === undefined) throw notFound();
  return id;
}

function requestFormValues(form: URLSearchParams): RequestFormValues {
  return {
    title: form.get('title') ?? '',
    description: form.get('description') ?? '',
    amount: form.get('amount') ?? '',
  };
}

/**
 * Converts form text to the service payload. Only the representation changes:
 * numeric text becomes a number, empty amount becomes "missing", and anything
 * else is passed through unchanged so the service rejects it.
 */
function requestPayload(values: RequestFormValues): Record<string, unknown> {
  const amount = values.amount.trim();
  return {
    title: values.title,
    description: values.description,
    amount: amount === '' ? undefined : /^-?\d+(\.\d+)?$/.test(amount) ? Number(amount) : amount,
  };
}
