import type { ServerResponse } from 'node:http';

import { AppError } from '../domain/errors';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

export function sendHtml(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(page),
    'Cache-Control': 'no-store',
  });
  res.end(page);
}

/** 303 See Other: after a form POST the browser follows with a GET (Post/Redirect/Get). */
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * Translates any thrown value into the frozen error contract:
 * `{ "error": { "code", "message" } }`. Unexpected errors are logged on the
 * server and returned as a generic 500 without internal details.
 */
export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof AppError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }

  console.error(error);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
