import { type FieldIssue, validationError } from './errors';
import type { RequestInput, RequestPatch } from './types';

/**
 * Payload validation (Requirements v1.2: Validation rules, Client-writable fields).
 *
 * Each `validate*Payload` function either returns validated values or throws
 * 400 VALIDATION_ERROR listing every problem found.
 */

export const TITLE_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 1000;
export const COMMENT_MAX_LENGTH = 500;
export const AMOUNT_MAX = 100000;

export const SYSTEM_MANAGED_FIELDS: readonly string[] = [
  'id',
  'requester',
  'status',
  'reviewComment',
  'createdAt',
  'updatedAt',
];

const REQUEST_INPUT_FIELDS: readonly string[] = ['title', 'description', 'amount'];
const REJECT_FIELDS: readonly string[] = ['comment'];
const LOGIN_FIELDS: readonly string[] = ['userId'];

type Check<T> = { ok: true; value: T } | { ok: false; issue: FieldIssue };

function fail(field: string, message: string): { ok: false; issue: FieldIssue } {
  return { ok: false, issue: { field, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw validationError([{ field: 'payload', message: 'must be a JSON object' }]);
  }
  return payload;
}

function disallowedFieldIssues(
  body: Record<string, unknown>,
  allowed: readonly string[],
): FieldIssue[] {
  return Object.keys(body)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      field: key,
      message: SYSTEM_MANAGED_FIELDS.includes(key)
        ? 'is system-managed and cannot be set'
        : 'is not an allowed field',
    }));
}

/** Length in Unicode code points, so one emoji counts as one character. */
function characterCount(value: string): number {
  return Array.from(value).length;
}

/** Trim, then require 1..maxLength characters. Whitespace-only is therefore invalid. */
function checkText(value: unknown, field: string, maxLength: number): Check<string> {
  if (value === undefined) return fail(field, 'is required');
  if (typeof value !== 'string') return fail(field, 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(field, 'must not be empty or whitespace-only');
  if (characterCount(trimmed) > maxLength) {
    return fail(field, `must be at most ${String(maxLength)} characters`);
  }
  return { ok: true, value: trimmed };
}

/** True when `value` has at most 2 decimal places. Exact for doubles nearest to k/100. */
function hasAtMostTwoDecimals(value: number): boolean {
  return Math.round(value * 100) / 100 === value;
}

function checkAmount(value: unknown): Check<number> {
  const field = 'amount';
  if (value === undefined) return fail(field, 'is required');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(field, 'must be a JSON number');
  }
  if (value <= 0) return fail(field, 'must be greater than 0');
  if (value > AMOUNT_MAX) return fail(field, `must be at most ${String(AMOUNT_MAX)}`);
  if (!hasAtMostTwoDecimals(value)) return fail(field, 'must have at most 2 decimal places');
  return { ok: true, value };
}

function issuesOf(...checks: Check<unknown>[]): FieldIssue[] {
  return checks.flatMap((check) => (check.ok ? [] : [check.issue]));
}

/** POST /api/requests — all of title, description and amount are required. */
export function validateCreatePayload(payload: unknown): RequestInput {
  const body = requireObject(payload);
  const title = checkText(body['title'], 'title', TITLE_MAX_LENGTH);
  const description = checkText(body['description'], 'description', DESCRIPTION_MAX_LENGTH);
  const amount = checkAmount(body['amount']);

  const issues = [
    ...disallowedFieldIssues(body, REQUEST_INPUT_FIELDS),
    ...issuesOf(title, description, amount),
  ];
  if (issues.length > 0 || !title.ok || !description.ok || !amount.ok) {
    throw validationError(issues);
  }
  return { title: title.value, description: description.value, amount: amount.value };
}

/** PATCH /api/requests/:id — a non-empty subset of title, description and amount. */
export function validateUpdatePayload(payload: unknown): RequestPatch {
  const body = requireObject(payload);
  if (Object.keys(body).length === 0) {
    throw validationError([{ field: 'payload', message: 'must contain at least one field' }]);
  }

  const issues = disallowedFieldIssues(body, REQUEST_INPUT_FIELDS);
  const patch: { title?: string; description?: string; amount?: number } = {};

  if (Object.hasOwn(body, 'title')) {
    const title = checkText(body['title'], 'title', TITLE_MAX_LENGTH);
    if (title.ok) patch.title = title.value;
    else issues.push(title.issue);
  }
  if (Object.hasOwn(body, 'description')) {
    const description = checkText(body['description'], 'description', DESCRIPTION_MAX_LENGTH);
    if (description.ok) patch.description = description.value;
    else issues.push(description.issue);
  }
  if (Object.hasOwn(body, 'amount')) {
    const amount = checkAmount(body['amount']);
    if (amount.ok) patch.amount = amount.value;
    else issues.push(amount.issue);
  }

  if (issues.length > 0) throw validationError(issues);
  return patch;
}

/** PATCH /api/requests/:id/approve — no payload fields. A missing body is accepted. */
export function validateApprovePayload(payload: unknown): void {
  if (payload === undefined) return;
  const issues = disallowedFieldIssues(requireObject(payload), []);
  if (issues.length > 0) throw validationError(issues);
}

/** PATCH /api/requests/:id/reject — only `comment`, which is mandatory. Returns the trimmed comment. */
export function validateRejectPayload(payload: unknown): string {
  const body = requireObject(payload);
  const comment = checkText(body['comment'], 'comment', COMMENT_MAX_LENGTH);

  const issues = [...disallowedFieldIssues(body, REJECT_FIELDS), ...issuesOf(comment)];
  if (issues.length > 0 || !comment.ok) throw validationError(issues);
  return comment.value;
}

/**
 * POST /api/auth/login — only `userId`, a non-empty string. Returns the user ID.
 * Whether the ID belongs to a demo user is checked by AuthService.
 */
export function validateLoginPayload(payload: unknown): string {
  const body = requireObject(payload);
  const userId = body['userId'];

  const issues = disallowedFieldIssues(body, LOGIN_FIELDS);
  if (typeof userId !== 'string' || userId.length === 0) {
    issues.push({ field: 'userId', message: 'is required and must be a string' });
  }
  if (issues.length > 0 || typeof userId !== 'string') throw validationError(issues);
  return userId;
}
