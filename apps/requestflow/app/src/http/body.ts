import type { IncomingMessage } from 'node:http';

import { AppError } from '../domain/errors';

const MAX_BODY_BYTES = 64 * 1024;

async function readTextBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError('VALIDATION_ERROR', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads and parses a JSON request body.
 *
 * Returns `undefined` for an empty body, so services can decide whether a payload
 * is required. Malformed or oversized JSON is rejected here, at the HTTP boundary,
 * with 400 VALIDATION_ERROR.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readTextBody(req);
  if (text.trim() === '') return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Request body is not valid JSON');
  }
}

/** Reads an `application/x-www-form-urlencoded` body, as sent by HTML forms. */
export async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readTextBody(req));
}
