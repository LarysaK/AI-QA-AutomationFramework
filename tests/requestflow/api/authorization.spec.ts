import { randomUUID } from 'node:crypto';

import { type APIResponse, expect, test } from '@playwright/test';

import { ApiSessions } from '../../../apps/requestflow/api/api-sessions';
import {
  type ApiErrorBody,
  type ApiRequest,
  RequestFlowApi,
} from '../../../apps/requestflow/api/requestflow-api.client';
import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';

const { alex, sam, jordan } = DEMO_USERS;

/** Arrange: Alex's own request, created (and optionally submitted) through the public API. */
async function createRequest(api: RequestFlowApi, submit: boolean): Promise<ApiRequest> {
  const created = await api.createRequest({
    title: `Authorization ${randomUUID().slice(0, 8)}`,
    description: 'Authorization check',
    amount: 42.5,
  });
  expect(created.status(), 'arrange: create request').toBe(201);
  const draft = (await created.json()) as ApiRequest;
  if (!submit) return draft;
  const submitted = await api.submitRequest(draft.id);
  expect(submitted.status(), 'arrange: submit request').toBe(200);
  return (await submitted.json()) as ApiRequest;
}

async function retrieve(api: RequestFlowApi, id: string): Promise<ApiRequest> {
  const response = await api.getRequest(id);
  expect(response.status(), 'retrieve request').toBe(200);
  return (await response.json()) as ApiRequest;
}

async function expectError(response: APIResponse, status: number, code: string): Promise<void> {
  expect(response.status()).toBe(status);
  expect(((await response.json()) as ApiErrorBody).error.code).toBe(code);
}

test.describe('REQ-007 Authorization (API)', { tag: '@REQ-007' }, () => {
  test(
    '401 before 403: approve without a session and with an invalid payload is unauthenticated',
    { tag: '@TC-007-01' },
    async ({ playwright, baseURL, request }) => {
      const owner = new RequestFlowApi(request);
      await owner.loginAs(alex);
      const submitted = await createRequest(owner, true);

      const sessions = new ApiSessions(playwright.request, baseURL);
      try {
        const anonymous = await sessions.anonymous();

        // `unexpected` is a disallowed field: with a session, the payload would be rejected.
        const response = await anonymous.approveRequest(submitted.id, { unexpected: true });

        await expectError(response, 401, 'UNAUTHENTICATED');
      } finally {
        await sessions.dispose();
      }
      expect(await retrieve(owner, submitted.id)).toEqual(submitted);
    },
  );

  test(
    '403 before 404: an Employee approving a non-existent request is forbidden',
    { tag: '@TC-007-02' },
    async ({ request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(alex);
      const missing = `missing-${randomUUID()}`;
      await expectError(await api.getRequest(missing), 404, 'NOT_FOUND');

      const response = await api.approveRequest(missing);

      expect(response.status()).toBe(403);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('FORBIDDEN');
    },
  );

  test(
    "404 before 409: an Employee editing another Employee's SUBMITTED request gets not found",
    { tag: '@TC-007-04' },
    async ({ playwright, baseURL, request }) => {
      const owner = new RequestFlowApi(request);
      await owner.loginAs(alex);
      const submitted = await createRequest(owner, true);

      const sessions = new ApiSessions(playwright.request, baseURL);
      try {
        const other = await sessions.as(sam);

        const response = await other.updateRequest(submitted.id, { title: 'Changed by Sam' });

        await expectError(response, 404, 'NOT_FOUND');
      } finally {
        await sessions.dispose();
      }
      expect(await retrieve(owner, submitted.id)).toEqual(submitted);
    },
  );

  // One representative response per status of the frozen table (Requirements v1.2:
  // HTTP status semantics and error codes).
  const ERRORS: readonly {
    readonly status: number;
    readonly code: string;
    readonly name: string;
    readonly act: (sessions: ApiSessions) => Promise<APIResponse>;
  }[] = [
    {
      status: 400,
      code: 'VALIDATION_ERROR',
      name: 'an empty title on create',
      act: async (sessions) =>
        (await sessions.as(alex)).createRequest({ title: '', description: 'D', amount: 1 }),
    },
    {
      status: 401,
      code: 'UNAUTHENTICATED',
      name: 'a list without a session',
      act: async (sessions) => (await sessions.anonymous()).listRequests(),
    },
    {
      status: 403,
      code: 'FORBIDDEN',
      name: 'a Reviewer listing own requests',
      act: async (sessions) => (await sessions.as(jordan)).listRequests(),
    },
    {
      status: 404,
      code: 'NOT_FOUND',
      name: 'a non-existent request',
      act: async (sessions) => (await sessions.as(alex)).getRequest(`missing-${randomUUID()}`),
    },
    {
      status: 409,
      code: 'INVALID_STATE_TRANSITION',
      name: 'a second submit',
      act: async (sessions) => {
        const api = await sessions.as(alex);
        const submitted = await createRequest(api, true);
        return api.submitRequest(submitted.id);
      },
    },
  ];

  for (const { status, code, name, act } of ERRORS) {
    test(
      `error response shape for ${String(status)} ${code} (${name})`,
      { tag: '@TC-007-06' },
      async ({ playwright, baseURL }) => {
        const sessions = new ApiSessions(playwright.request, baseURL);
        try {
          const response = await act(sessions);

          expect(response.status()).toBe(status);
          const body = (await response.json()) as Record<string, unknown>;
          expect(Object.keys(body)).toEqual(['error']);
          const error = body['error'] as Record<string, unknown>;
          expect(Object.keys(error).sort()).toEqual(['code', 'message']);
          expect(error['code']).toBe(code);
          // `message` is informational: its type is asserted, never its wording.
          expect(typeof error['message']).toBe('string');
        } finally {
          await sessions.dispose();
        }
      },
    );
  }
});
