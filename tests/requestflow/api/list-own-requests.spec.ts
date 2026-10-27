import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { ApiSessions } from '../../../apps/requestflow/api/api-sessions';
import {
  type ApiErrorBody,
  type ApiRequest,
  RequestFlowApi,
} from '../../../apps/requestflow/api/requestflow-api.client';
import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';

const { alex, sam, jordan } = DEMO_USERS;

/**
 * All tests share one server and the same demo users, so list assertions check only the
 * test's own requests (inclusion, exclusion, status), never the list's length (test plan 1.3).
 */

async function create(api: RequestFlowApi, label: string): Promise<ApiRequest> {
  const response = await api.createRequest({
    title: `${label} ${randomUUID().slice(0, 8)}`,
    description: 'List own requests',
    amount: 15,
  });
  expect(response.status(), `arrange: create ${label}`).toBe(201);
  return (await response.json()) as ApiRequest;
}

async function itemsOf(api: RequestFlowApi): Promise<ApiRequest[]> {
  const response = await api.listRequests();
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: ApiRequest[] }).items;
}

test.describe('REQ-009 List own requests (API)', { tag: '@REQ-009' }, () => {
  test(
    "an Employee's list contains own requests in every status, each with its current status",
    { tag: '@TC-009-01' },
    async ({ playwright, baseURL, request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(alex);
      const draft = await create(api, 'Draft');
      const toSubmit = await create(api, 'Submitted');
      const toApprove = await create(api, 'Approved');
      const toReject = await create(api, 'Rejected');
      const expected: ApiRequest[] = [draft];
      for (const created of [toSubmit, toApprove, toReject]) {
        const submitted = await api.submitRequest(created.id);
        expect(submitted.status(), 'arrange: submit').toBe(200);
        expected.push((await submitted.json()) as ApiRequest);
      }

      const sessions = new ApiSessions(playwright.request, baseURL);
      try {
        const reviewer = await sessions.as(jordan);
        const approved = await reviewer.approveRequest(toApprove.id);
        expect(approved.status(), 'arrange: approve').toBe(200);
        const rejected = await reviewer.rejectRequest(toReject.id, { comment: 'Out of budget' });
        expect(rejected.status(), 'arrange: reject').toBe(200);
        expected[2] = (await approved.json()) as ApiRequest;
        expected[3] = (await rejected.json()) as ApiRequest;
      } finally {
        await sessions.dispose();
      }
      expect(expected.map((r) => r.status)).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);

      const items = await itemsOf(api);

      for (const own of expected) {
        expect(
          items.find((item) => item.id === own.id),
          `${own.status} request in the list`,
        ).toEqual(own);
      }
    },
  );

  test(
    "another Employee's request is absent from the list, and every item is the Employee's own",
    { tag: '@TC-009-02' },
    async ({ playwright, baseURL, request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(alex);
      const own = await create(api, 'Own');

      const sessions = new ApiSessions(playwright.request, baseURL);
      let others: ApiRequest;
      try {
        others = await create(await sessions.as(sam), 'Other');
      } finally {
        await sessions.dispose();
      }

      const items = await itemsOf(api);

      expect(items.map((item) => item.id)).toContain(own.id);
      expect(items.map((item) => item.id)).not.toContain(others.id);
      for (const item of items) {
        expect(item.requester, `requester of ${item.id}`).toEqual({ id: alex.id, name: alex.name });
      }
    },
  );

  test('a Reviewer listing requests is forbidden', { tag: '@TC-009-06' }, async ({ request }) => {
    const api = new RequestFlowApi(request);
    await api.loginAs(jordan);

    const response = await api.listRequests();

    expect(response.status()).toBe(403);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('FORBIDDEN');
  });
});
