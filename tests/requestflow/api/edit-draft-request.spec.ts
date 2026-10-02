import { expect, test } from '@playwright/test';

import {
  type ApiErrorBody,
  type ApiRequest,
  RequestFlowApi,
} from '../../../apps/requestflow/api/requestflow-api.client';
import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';

const employee = DEMO_USERS.alex;

const ORIGINAL = {
  title: 'Conference ticket',
  description: 'Annual QA conference',
  amount: 120.5,
};

/** Arrange: creates a DRAFT request through the public API and returns it as stored. */
async function createDraft(api: RequestFlowApi): Promise<ApiRequest> {
  const response = await api.createRequest(ORIGINAL);
  expect(response.status(), 'arrange: create DRAFT request').toBe(201);
  return (await response.json()) as ApiRequest;
}

async function retrieve(api: RequestFlowApi, id: string): Promise<ApiRequest> {
  const response = await api.getRequest(id);
  expect(response.status(), 'retrieve request').toBe(200);
  return (await response.json()) as ApiRequest;
}

test.describe('REQ-002 Edit a draft request (API)', { tag: ['@REQ-002', '@CAN-003'] }, () => {
  test(
    'Employee changes only the title of own DRAFT; all other fields are preserved',
    { tag: '@TC-002-02' },
    async ({ request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(employee);
      const original = await createDraft(api);

      const response = await api.updateRequest(original.id, { title: 'QA Conference 2026' });

      expect(response.status()).toBe(200);
      const updated = (await response.json()) as ApiRequest;
      expect(updated).toMatchObject({
        id: original.id,
        title: 'QA Conference 2026',
        description: ORIGINAL.description,
        amount: ORIGINAL.amount,
        status: 'DRAFT',
        requester: { id: employee.id, name: employee.name },
        createdAt: original.createdAt,
      });
      expect(updated.updatedAt).not.toBe(original.updatedAt);

      // Persistence: the stored request is exactly what the PATCH returned.
      expect(await retrieve(api, original.id)).toEqual(updated);
    },
  );

  test(
    'Edit with one valid and one invalid field is rejected and changes nothing',
    { tag: '@TC-002-04' },
    async ({ request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(employee);
      const original = await createDraft(api);

      const response = await api.updateRequest(original.id, {
        title: 'New valid title',
        amount: -1,
      });

      expect(response.status()).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');

      // Atomicity: every field, including title and both timestamps, is as before the PATCH.
      const after = await retrieve(api, original.id);
      expect(after.title).toBe(ORIGINAL.title);
      expect(after).toEqual(original);
    },
  );

  test(
    'Edit of a SUBMITTED request is rejected as an invalid state transition',
    { tag: '@TC-002-10' },
    async ({ request }) => {
      const api = new RequestFlowApi(request);
      await api.loginAs(employee);
      const draft = await createDraft(api);
      const submitResponse = await api.submitRequest(draft.id);
      expect(submitResponse.status(), 'arrange: submit request').toBe(200);
      const submitted = (await submitResponse.json()) as ApiRequest;

      const response = await api.updateRequest(draft.id, { title: 'QA Conference 2026' });

      expect(response.status()).toBe(409);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('INVALID_STATE_TRANSITION');

      // State integrity: the request is exactly as it was right after submission.
      const after = await retrieve(api, draft.id);
      expect(after.status).toBe('SUBMITTED');
      expect(after.title).toBe(ORIGINAL.title);
      expect(after).toEqual(submitted);
    },
  );
});
