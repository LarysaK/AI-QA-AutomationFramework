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

  /** Logs in through POST /api/auth/login. Fails fast, because it is a test precondition. */
  async loginAs(user: DemoUser): Promise<void> {
    const response = await this.request.post('/api/auth/login', { data: { userId: user.id } });
    if (!response.ok()) {
      throw new Error(`Login as ${user.id} failed with HTTP ${String(response.status())}`);
    }
  }

  /** POST /api/requests. The payload is untyped on purpose so tests can send invalid input. */
  createRequest(payload: Record<string, unknown>): Promise<APIResponse> {
    return this.request.post('/api/requests', { data: payload });
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
}
