import type { APIRequestContext, APIResponse } from '@playwright/test';

import type { DemoUser } from '../data/demo-users';

/**
 * Request representation as defined by the public API contract
 * (Requirements v1.2: Request entity). Written from the requirements, not
 * imported from the AUT, so tests stay external HTTP consumers.
 */
export interface ApiRequest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly amount: number;
  readonly requester: { readonly id: string; readonly name: string };
  readonly status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  readonly reviewComment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Error body as defined by Requirements v1.2: Error response shape. */
export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/**
 * Thin RequestFlow API client over Playwright's APIRequestContext.
 *
 * The context keeps the session cookie set by login, so every later call is made as
 * the logged-in user. Methods return the raw APIResponse; asserting on it is the
 * test's job.
 */
export class RequestFlowApi {
  constructor(private readonly request: APIRequestContext) {}

  /** POST /api/auth/login, returning the raw response; for tests of login itself. */
  login(userId: string): Promise<APIResponse> {
    return this.request.post('/api/auth/login', { data: { userId } });
  }

  /** Logs in through POST /api/auth/login. Fails fast, because it is a test precondition. */
  async loginAs(user: DemoUser): Promise<void> {
    const response = await this.login(user.id);
    if (!response.ok()) {
      throw new Error(`Login as ${user.id} failed with HTTP ${String(response.status())}`);
    }
  }

  /** POST /api/auth/logout. */
  logout(): Promise<APIResponse> {
    return this.request.post('/api/auth/logout');
  }

  /** POST /api/requests. The payload is untyped on purpose so tests can send invalid input. */
  createRequest(payload: Record<string, unknown>): Promise<APIResponse> {
    return this.request.post('/api/requests', { data: payload });
  }

  /** GET /api/requests — the authenticated Employee's own requests. */
  listRequests(): Promise<APIResponse> {
    return this.request.get('/api/requests');
  }

  getRequest(id: string): Promise<APIResponse> {
    return this.request.get(`/api/requests/${encodeURIComponent(id)}`);
  }

  /** PATCH /api/requests/:id — partial update. Untyped payload, as for createRequest. */
  updateRequest(id: string, payload: Record<string, unknown>): Promise<APIResponse> {
    return this.request.patch(`/api/requests/${encodeURIComponent(id)}`, { data: payload });
  }

  submitRequest(id: string): Promise<APIResponse> {
    return this.request.patch(`/api/requests/${encodeURIComponent(id)}/submit`);
  }

  /** PATCH /api/requests/:id/approve. The payload is optional and untyped, as for createRequest. */
  approveRequest(id: string, payload?: Record<string, unknown>): Promise<APIResponse> {
    return this.request.patch(
      `/api/requests/${encodeURIComponent(id)}/approve`,
      payload === undefined ? {} : { data: payload },
    );
  }

  /** PATCH /api/requests/:id/reject. Untyped payload, as for createRequest. */
  rejectRequest(id: string, payload: Record<string, unknown>): Promise<APIResponse> {
    return this.request.patch(`/api/requests/${encodeURIComponent(id)}/reject`, {
      data: payload,
    });
  }

  /** GET /api/review-queue. */
  reviewQueue(): Promise<APIResponse> {
    return this.request.get('/api/review-queue');
  }
}
