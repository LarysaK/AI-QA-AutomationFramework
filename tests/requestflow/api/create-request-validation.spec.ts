import { expect, test } from '@playwright/test';

import {
  type ApiErrorBody,
  type ApiRequest,
  RequestFlowApi,
} from '../../../apps/requestflow/api/requestflow-api.client';
import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';

const employee = DEMO_USERS.alex;

/** A valid payload; each case below changes only the field under test. */
const VALID = {
  title: 'Conference ticket',
  description: 'Annual QA conference',
  amount: 120.5,
};

/** Accepted as sent: the stored values equal the sent values. */
const ACCEPTED = [
  { tc: 'TC-001-04', name: 'title of 1 character', payload: { ...VALID, title: 'T' } },
  {
    tc: 'TC-001-04',
    name: 'title of 100 characters',
    payload: { ...VALID, title: 'T'.repeat(100) },
  },
  { tc: 'TC-001-07', name: 'description of 1 character', payload: { ...VALID, description: 'D' } },
  {
    tc: 'TC-001-07',
    name: 'description of 1000 characters',
    payload: { ...VALID, description: 'D'.repeat(1000) },
  },
  { tc: 'TC-001-09', name: 'amount 0.01 (minimum)', payload: { ...VALID, amount: 0.01 } },
  { tc: 'TC-001-09', name: 'amount 100000 (maximum)', payload: { ...VALID, amount: 100000 } },
  {
    tc: 'TC-001-09',
    name: 'amount 10.12 (2 decimal places)',
    payload: { ...VALID, amount: 10.12 },
  },
];

/** Accepted after trimming: whitespace around title and description is not stored. */
const TRIMMED = [
  {
    tc: 'TC-001-02',
    name: 'title and description surrounded by whitespace',
    payload: {
      ...VALID,
      title: '  Conference ticket  ',
      description: '\n Annual QA conference \t',
    },
    stored: { title: 'Conference ticket', description: 'Annual QA conference' },
  },
  {
    tc: 'TC-001-04',
    name: 'title of 100 characters surrounded by whitespace',
    payload: { ...VALID, title: `  ${'T'.repeat(100)}  ` },
    stored: { title: 'T'.repeat(100), description: VALID.description },
  },
];

const REJECTED = [
  { tc: 'TC-001-03', name: 'empty title', payload: { ...VALID, title: '' } },
  { tc: 'TC-001-03', name: 'whitespace-only title', payload: { ...VALID, title: '   ' } },
  {
    tc: 'TC-001-05',
    name: 'title of 101 characters',
    payload: { ...VALID, title: 'T'.repeat(101) },
  },
  { tc: 'TC-001-06', name: 'empty description', payload: { ...VALID, description: '' } },
  {
    tc: 'TC-001-06',
    name: 'whitespace-only description',
    payload: { ...VALID, description: '   ' },
  },
  {
    tc: 'TC-001-08',
    name: 'description of 1001 characters',
    payload: { ...VALID, description: 'D'.repeat(1001) },
  },
  { tc: 'TC-001-10', name: 'amount 0', payload: { ...VALID, amount: 0 } },
  { tc: 'TC-001-10', name: 'negative amount', payload: { ...VALID, amount: -1 } },
  { tc: 'TC-001-10', name: 'amount 100000.01', payload: { ...VALID, amount: 100000.01 } },
  { tc: 'TC-001-10', name: 'amount with 3 decimal places', payload: { ...VALID, amount: 10.123 } },
  {
    tc: 'TC-001-11',
    name: 'numeric amount sent as a string',
    payload: { ...VALID, amount: '10.50' },
  },
  { tc: 'TC-001-11', name: 'non-numeric amount', payload: { ...VALID, amount: 'abc' } },
  {
    tc: 'TC-001-12',
    name: 'missing title',
    payload: { description: VALID.description, amount: VALID.amount },
  },
  {
    tc: 'TC-001-12',
    name: 'missing description',
    payload: { title: VALID.title, amount: VALID.amount },
  },
  {
    tc: 'TC-001-12',
    name: 'missing amount',
    payload: { title: VALID.title, description: VALID.description },
  },
];

test.describe(
  'REQ-001 Create a request: validation boundaries (API)',
  { tag: ['@REQ-001', '@CAN-002'] },
  () => {
    for (const { tc, name, payload } of ACCEPTED) {
      test(`accepts ${name}`, { tag: `@${tc}` }, async ({ request }) => {
        const api = new RequestFlowApi(request);
        await api.loginAs(employee);

        const response = await api.createRequest(payload);

        expect(response.status()).toBe(201);
        const created = (await response.json()) as ApiRequest;
        expect(created.id).toBeTruthy();
        expect(created).toMatchObject({
          title: payload.title,
          description: payload.description,
          amount: payload.amount,
          requester: { id: employee.id, name: employee.name },
          status: 'DRAFT',
          reviewComment: null,
        });
      });
    }

    for (const { tc, name, payload, stored } of TRIMMED) {
      test(`stores trimmed values for ${name}`, { tag: `@${tc}` }, async ({ request }) => {
        const api = new RequestFlowApi(request);
        await api.loginAs(employee);

        const response = await api.createRequest(payload);
        expect(response.status()).toBe(201);
        const created = (await response.json()) as ApiRequest;

        // Persistence: the stored request, read back through the API, has the trimmed values.
        const retrieved = await api.getRequest(created.id);
        expect(retrieved.status()).toBe(200);
        expect((await retrieved.json()) as ApiRequest).toMatchObject({
          id: created.id,
          title: stored.title,
          description: stored.description,
          amount: payload.amount,
          requester: { id: employee.id, name: employee.name },
          status: 'DRAFT',
          reviewComment: null,
        });
      });
    }

    for (const { tc, name, payload } of REJECTED) {
      test(`rejects ${name}`, { tag: `@${tc}` }, async ({ request }) => {
        const api = new RequestFlowApi(request);
        await api.loginAs(employee);

        const response = await api.createRequest(payload);

        expect(response.status()).toBe(400);
        const body = (await response.json()) as ApiErrorBody;
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
    }
  },
);
