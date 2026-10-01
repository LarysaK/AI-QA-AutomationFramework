import { forbidden, notFound } from '../domain/errors';
import { applyTransition } from '../domain/transitions';
import type { Request, RequestStatus, Role, User } from '../domain/types';
import {
  validateApprovePayload,
  validateCreatePayload,
  validateRejectPayload,
  validateUpdatePayload,
} from '../domain/validation';
import type { Clock } from '../store/clock';
import type { MemoryStore } from '../store/memory-store';

/**
 * Request business operations (REQ-001 – REQ-009).
 *
 * `actor` is the authenticated user; resolving it (401) is AuthService's job and
 * happens first. Every operation then checks, in the frozen precedence order:
 *
 *   403 role → 404 existence/visibility → 409 status → 400 payload
 */
export class RequestService {
  constructor(
    private readonly store: MemoryStore,
    private readonly clock: Clock,
  ) {}

  /** REQ-001 */
  create(actor: User, payload: unknown): Request {
    requireRole(actor, 'EMPLOYEE');
    const input = validateCreatePayload(payload);

    const timestamp = this.clock.now().toISOString();
    const request: Request = {
      id: this.store.nextRequestId(),
      title: input.title,
      description: input.description,
      amount: input.amount,
      requester: { id: actor.id, name: actor.name },
      status: 'DRAFT',
      reviewComment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.saveRequest(request);
    return request;
  }

  /** REQ-008 — available to both roles, subject to visibility. */
  get(actor: User, id: string): Request {
    return this.findVisible(actor, id);
  }

  /** REQ-009 */
  listOwn(actor: User): Request[] {
    requireRole(actor, 'EMPLOYEE');
    return newestFirst(this.store.listRequests().filter((r) => r.requester.id === actor.id));
  }

  /** REQ-004 */
  reviewQueue(actor: User): Request[] {
    requireRole(actor, 'REVIEWER');
    return newestFirst(this.store.listRequests().filter((r) => r.status === 'SUBMITTED'));
  }

  /** REQ-001 role rule without a payload, e.g. before showing a create form. */
  assertCanCreate(actor: User): void {
    requireRole(actor, 'EMPLOYEE');
  }

  /** REQ-002 checks that do not depend on the payload: role, visibility, DRAFT status. */
  getEditable(actor: User, id: string): Request {
    requireRole(actor, 'EMPLOYEE');
    const current = this.findVisible(actor, id);
    applyTransition('edit', current.status);
    return current;
  }

  /** REQ-002 */
  update(actor: User, id: string, payload: unknown): Request {
    const current = this.getEditable(actor, id);
    const patch = validateUpdatePayload(payload);

    return this.save({ ...current, ...patch });
  }

  /**
   * REQ-003. Requirements v1.2 define no submit payload, so none is read
   * (minimal implementation choice, not a frozen rule).
   */
  submit(actor: User, id: string): Request {
    requireRole(actor, 'EMPLOYEE');
    const current = this.findVisible(actor, id);
    const status = applyTransition('submit', current.status);

    return this.save({ ...current, status });
  }

  /** REQ-005 */
  approve(actor: User, id: string, payload: unknown): Request {
    requireRole(actor, 'REVIEWER');
    const current = this.findVisible(actor, id);
    const status = applyTransition('approve', current.status);
    validateApprovePayload(payload);

    return this.save({ ...current, status });
  }

  /** REQ-006 */
  reject(actor: User, id: string, payload: unknown): Request {
    requireRole(actor, 'REVIEWER');
    const current = this.findVisible(actor, id);
    const status = applyTransition('reject', current.status);
    const reviewComment = validateRejectPayload(payload);

    return this.save({ ...current, status, reviewComment });
  }

  /**
   * REQ-007 visibility: an Employee sees only their own requests; a Reviewer sees
   * every request except DRAFT. Invisible requests are indistinguishable from missing ones.
   */
  private findVisible(actor: User, id: string): Request {
    const request = this.store.getRequest(id);
    if (!request || !isVisibleTo(actor, request)) throw notFound();
    return request;
  }

  /** Persists a changed request with a new `updatedAt`. */
  private save(request: Request): Request {
    const updated: Request = { ...request, updatedAt: this.clock.now().toISOString() };
    this.store.saveRequest(updated);
    return updated;
  }
}

const HIDDEN_FROM_REVIEWERS: readonly RequestStatus[] = ['DRAFT'];

function isVisibleTo(actor: User, request: Request): boolean {
  switch (actor.role) {
    case 'EMPLOYEE':
      return request.requester.id === actor.id;
    case 'REVIEWER':
      return !HIDDEN_FROM_REVIEWERS.includes(request.status);
  }
}

function requireRole(actor: User, role: Role): void {
  if (actor.role !== role) throw forbidden();
}

/** Newest first by `createdAt`. The monotonic clock guarantees no ties. */
function newestFirst(requests: Request[]): Request[] {
  return requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
