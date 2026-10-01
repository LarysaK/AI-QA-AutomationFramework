/**
 * RequestFlow domain types (Requirements v1.2: Roles, Request entity, Status model).
 */

export const ROLES = ['EMPLOYEE', 'REVIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** A demo user. In v1 every user has exactly one role. */
export interface User {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
}

/** How a requester is represented on a Request. */
export interface UserRef {
  readonly id: string;
  readonly name: string;
}

/** The Request API representation. Timestamps are ISO 8601 strings. */
export interface Request {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly amount: number;
  readonly requester: UserRef;
  readonly status: RequestStatus;
  readonly reviewComment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Validated input for creating a request. */
export interface RequestInput {
  readonly title: string;
  readonly description: string;
  readonly amount: number;
}

/** Validated, non-empty partial input for editing a request. */
export type RequestPatch = Partial<RequestInput>;
