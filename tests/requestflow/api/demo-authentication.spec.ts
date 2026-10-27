import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';

import { ApiSessions } from '../../../apps/requestflow/api/api-sessions';
import {
  type ApiErrorBody,
  RequestFlowApi,
} from '../../../apps/requestflow/api/requestflow-api.client';
import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';

const SESSION_COOKIE = 'rf_session';

/** The value of the session cookie the context holds, or undefined. */
async function sessionCookieOf(context: APIRequestContext): Promise<string | undefined> {
  const { cookies } = await context.storageState();
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value;
}

/**
 * The protected endpoints of Requirements v1.2 (API: Endpoints): every `/api/requests` and
 * `/api/review-queue` endpoint. Payloads are syntactically valid; the ID need not exist,
 * because authentication is checked first (Error precedence).
 */
const PROTECTED: readonly {
  readonly name: string;
  readonly call: (api: RequestFlowApi) => Promise<APIResponse>;
}[] = [
  {
    name: 'POST /api/requests',
    call: (api) => api.createRequest({ title: 'T', description: 'D', amount: 1 }),
  },
  { name: 'GET /api/requests', call: (api) => api.listRequests() },
  { name: 'GET /api/requests/:id', call: (api) => api.getRequest('req-unauthenticated') },
  {
    name: 'PATCH /api/requests/:id',
    call: (api) => api.updateRequest('req-unauthenticated', { title: 'T' }),
  },
  {
    name: 'PATCH /api/requests/:id/submit',
    call: (api) => api.submitRequest('req-unauthenticated'),
  },
  {
    name: 'PATCH /api/requests/:id/approve',
    call: (api) => api.approveRequest('req-unauthenticated'),
  },
  {
    name: 'PATCH /api/requests/:id/reject',
    call: (api) => api.rejectRequest('req-unauthenticated', { comment: 'C' }),
  },
  { name: 'GET /api/review-queue', call: (api) => api.reviewQueue() },
];

test.describe('REQ-010 Demo authentication (API)', { tag: '@REQ-010' }, () => {
  for (const user of Object.values(DEMO_USERS)) {
    test(
      `login as ${user.id} returns the demo user and sets the session cookie`,
      { tag: '@TC-010-01' },
      async ({ request }) => {
        const response = await new RequestFlowApi(request).login(user.id);

        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ id: user.id, name: user.name, role: user.role });
        const setCookie = response
          .headersArray()
          .filter((header) => header.name.toLowerCase() === 'set-cookie')
          .map((header) => header.value);
        expect(setCookie.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
        expect(await sessionCookieOf(request)).toMatch(/.+/);
      },
    );
  }

  test(
    'the session cookie from login authenticates later API calls',
    { tag: '@TC-010-02' },
    async ({ request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(DEMO_USERS.alex);

      const response = await api.listRequests();

      expect(response.status()).toBe(200);
      expect(Array.isArray(((await response.json()) as { items: unknown }).items)).toBe(true);
    },
  );

  test('logout returns 204 with an empty body', { tag: '@TC-010-03' }, async ({ request }) => {
    const api = new RequestFlowApi(request);
    await api.loginAs(DEMO_USERS.alex);

    const response = await api.logout();

    expect(response.status()).toBe(204);
    expect(await response.body()).toHaveLength(0);
  });

  test(
    'the session cookie value from before logout is no longer authenticated',
    { tag: '@TC-010-04' },
    async ({ playwright, baseURL, request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(DEMO_USERS.alex);
      const saved = await sessionCookieOf(request);
      expect(saved, 'arrange: session cookie after login').toMatch(/.+/);
      const replayedCookie = `${SESSION_COOKIE}=${String(saved)}`;

      const sessions = new ApiSessions(playwright.request, baseURL);
      try {
        // Control: replaying the saved value in a fresh context authenticates before logout,
        // so the 401 below comes from the invalidated session, not from the replay itself.
        const before = await sessions.context(replayedCookie);
        expect((await new RequestFlowApi(before).listRequests()).status()).toBe(200);

        expect((await api.logout()).status(), 'arrange: logout').toBe(204);

        const after = new RequestFlowApi(await sessions.context(replayedCookie));
        const response = await after.listRequests();

        expect(response.status()).toBe(401);
        expect(((await response.json()) as ApiErrorBody).error.code).toBe('UNAUTHENTICATED');
      } finally {
        await sessions.dispose();
      }
    },
  );

  for (const endpoint of PROTECTED) {
    test(
      `${endpoint.name} without a session returns 401`,
      { tag: '@TC-010-05' },
      async ({ request }) => {
        const response = await endpoint.call(new RequestFlowApi(request));

        expect(response.status()).toBe(401);
        expect(((await response.json()) as ApiErrorBody).error.code).toBe('UNAUTHENTICATED');
      },
    );
  }
});
