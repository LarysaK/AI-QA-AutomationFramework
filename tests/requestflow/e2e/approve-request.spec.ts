import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import {
  type ApiRequest,
  RequestFlowApi,
} from '../../../apps/requestflow/api/requestflow-api.client';
import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';
import { LoginPage } from '../../../apps/requestflow/pages/login.page';
import { RequestDetailsPage } from '../../../apps/requestflow/pages/request-details.page';
import { RequestFormPage } from '../../../apps/requestflow/pages/request-form.page';
import { RequestsPage } from '../../../apps/requestflow/pages/requests.page';
import { ReviewQueuePage } from '../../../apps/requestflow/pages/review-queue.page';

test.describe('Request approval workflow (E2E)', () => {
  test(
    'Employee submits a request, Reviewer approves it, and both UI and API show APPROVED',
    {
      tag: [
        '@REQ-003',
        '@REQ-004',
        '@REQ-005',
        '@REQ-008',
        '@TC-003-08',
        '@TC-004-08',
        '@TC-005-08',
        '@TC-008-08',
        '@CAN-004',
      ],
    },
    async ({ browser, request }) => {
      const employee = DEMO_USERS.alex;
      const reviewer = DEMO_USERS.jordan;
      // The review queue is shared by all parallel tests, so this test's request needs a unique title.
      const newRequest = {
        title: `Approval workflow ${randomUUID().slice(0, 8)}`,
        description: 'Canonical approval workflow',
        amount: '250.00',
      };

      // One browser context per user: both stay logged in at the same time, with separate cookies.
      const employeeContext = await browser.newContext();
      const reviewerContext = await browser.newContext();
      try {
        const employeePage = await employeeContext.newPage();
        const reviewerPage = await reviewerContext.newPage();
        const employeeDetails = new RequestDetailsPage(employeePage);
        const reviewerDetails = new RequestDetailsPage(reviewerPage);
        let requestId: string;

        await test.step('Alex creates a request and submits it for review', async () => {
          const login = new LoginPage(employeePage);
          await login.open();
          await login.logInAs(employee);
          await new RequestsPage(employeePage).openNewRequest();
          await new RequestFormPage(employeePage).saveDraft(newRequest);

          await expect(employeePage).toHaveURL(employeeDetails.url);
          await expect(employeeDetails.field('Status')).toHaveText('DRAFT');
          requestId = employeeDetails.requestId();

          await employeeDetails.submitForReview();

          await expect(employeeDetails.field('Status')).toHaveText('SUBMITTED');
          await expect(employeeDetails.editLink).toBeHidden();
          await expect(employeeDetails.submitButton).toBeHidden();
        });

        await test.step('Jordan finds the request in the Review queue and approves it', async () => {
          const login = new LoginPage(reviewerPage);
          const queue = new ReviewQueuePage(reviewerPage);
          await login.open();
          await login.logInAs(reviewer);
          await queue.open();

          // The queue row itself shows the request: Title, Amount, Requester, Status.
          await expect(queue.row(newRequest.title).getByRole('cell')).toHaveText([
            newRequest.title,
            '250.00',
            employee.name,
            'SUBMITTED',
          ]);
          await queue.openRequest(newRequest.title);

          // Identity: the request Jordan opened is the one Alex created.
          await expect(reviewerPage).toHaveURL(reviewerDetails.isUrlOf(requestId));
          await expect(reviewerDetails.field('Title')).toHaveText(newRequest.title);
          await expect(reviewerDetails.field('Requester')).toHaveText(employee.name);
          await expect(reviewerDetails.field('Amount')).toHaveText('250.00');
          await expect(reviewerDetails.field('Status')).toHaveText('SUBMITTED');

          await reviewerDetails.approve();

          await expect(reviewerDetails.field('Status')).toHaveText('APPROVED');
          await expect(reviewerDetails.approveButton).toBeHidden();
          await expect(reviewerDetails.rejectButton).toBeHidden();
          await expect(reviewerDetails.rejectionComment).toBeHidden();
        });

        await test.step('Alex sees the request as APPROVED in the same session', async () => {
          await employeeDetails.open(requestId);

          await expect(employeePage).toHaveURL(employeeDetails.isUrlOf(requestId));
          await expect(employeeDetails.field('Status')).toHaveText('APPROVED');
        });

        await test.step('The API confirms the persisted final state', async () => {
          const api = new RequestFlowApi(request);
          await api.loginAs(employee);

          const response = await api.getRequest(requestId);

          expect(response.status()).toBe(200);
          expect((await response.json()) as ApiRequest).toMatchObject({
            id: requestId,
            title: newRequest.title,
            description: newRequest.description,
            amount: 250,
            requester: { id: employee.id, name: employee.name },
            status: 'APPROVED',
            reviewComment: null,
          });
        });
      } finally {
        await employeeContext.close();
        await reviewerContext.close();
      }
    },
  );
});
