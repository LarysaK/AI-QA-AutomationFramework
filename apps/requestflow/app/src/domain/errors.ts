/**
 * Application errors (Requirements v1.2: HTTP status semantics and error codes).
 */

export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_STATE_TRANSITION: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

/** A single validation problem, kept for adapters that want field-level detail (e.g. UI). */
export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly issues: readonly FieldIssue[];

  constructor(code: ErrorCode, message: string, issues: readonly FieldIssue[] = []) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.issues = issues;
  }
}

export function validationError(issues: readonly FieldIssue[]): AppError {
  const message = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
  return new AppError('VALIDATION_ERROR', message, issues);
}

export function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'Authentication is required');
}

export function forbidden(): AppError {
  return new AppError('FORBIDDEN', 'This action is not permitted for your role');
}

export function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Request not found');
}

export function invalidStateTransition(message: string): AppError {
  return new AppError('INVALID_STATE_TRANSITION', message);
}
