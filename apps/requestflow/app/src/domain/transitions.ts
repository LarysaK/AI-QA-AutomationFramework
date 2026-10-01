import { invalidStateTransition } from './errors';
import type { RequestStatus } from './types';

/**
 * Status model (Requirements v1.2):
 *
 *   DRAFT → SUBMITTED → APPROVED
 *                     ↘ REJECTED
 *
 * `edit` is not a status change, but it is guarded by status like a transition.
 */
export type RequestAction = 'edit' | 'submit' | 'approve' | 'reject';

const TRANSITIONS: Readonly<Record<RequestAction, { from: RequestStatus; to: RequestStatus }>> = {
  edit: { from: 'DRAFT', to: 'DRAFT' },
  submit: { from: 'DRAFT', to: 'SUBMITTED' },
  approve: { from: 'SUBMITTED', to: 'APPROVED' },
  reject: { from: 'SUBMITTED', to: 'REJECTED' },
};

export const TERMINAL_STATUSES: readonly RequestStatus[] = ['APPROVED', 'REJECTED'];

/** Whether `action` is allowed from `current`. Lets adapters decide which controls to offer. */
export function canApply(action: RequestAction, current: RequestStatus): boolean {
  return TRANSITIONS[action].from === current;
}

/** Returns the resulting status, or throws 409 INVALID_STATE_TRANSITION. */
export function applyTransition(action: RequestAction, current: RequestStatus): RequestStatus {
  const transition = TRANSITIONS[action];
  if (current !== transition.from) {
    throw invalidStateTransition(
      `Cannot ${action} a request in status ${current}; status ${transition.from} is required`,
    );
  }
  return transition.to;
}
