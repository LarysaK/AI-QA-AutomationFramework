import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'rf_session';

/** Attributes shared by setting and expiring the cookie, so the browser treats them as one cookie. */
const SESSION_COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Lax; Path=/';

export function readSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = pair.slice(separator + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; ${SESSION_COOKIE_ATTRIBUTES}`;
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`;
}
