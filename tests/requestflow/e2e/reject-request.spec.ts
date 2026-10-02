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

test.describe('Request rejection workflow (E2E)', () => {
  test(
    'Reviewer must give a comment to reject; the rejected request and its comment reach the Employee and the API',
    {
      tag: [
        '@REQ-003',
        '@REQ-006',
        '@REQ-008',
        '@TC-006-11',
        '@TC-006-12',
        '@TC-008-08',
        '@CAN-005',
      ],
    },
    async ({ browser, request }) => {
      const employee = DEMO_USERS.alex;
      const reviewer = DEMO_USERS.jordan;
      // The review queue is shared by all parallel tests, so this test's request needs a unique title.
      const newRequest = {
        title: `Rejection workflow ${randomUUID().slice(0, 8)}`,
        description: 'Canonical rejection workflow',
        amount: '175.50',
      };
      const rejectionComment = 'Missing supporting documentation';

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
        });

        await test.step('Jordan opens the request from the Review queue', async () => {
          const login = new LoginPage(reviewerPage);
          const queue = new ReviewQueuePage(reviewerPage);
          await login.open();
          await login.logInAs(reviewer);
          await queue.open();

          await expect(queue.row(newRequest.title)).toContainText('SUBMITTED');
          await queue.openRequest(newRequest.title);

          // Identity: the request Jordan opened is the one Alex created.
          await expect(reviewerPage).toHaveURL(reviewerDetails.isUrlOf(requestId));
          await expect(reviewerDetails.field('Title')).toHaveText(newRequest.title);
          await expect(reviewerDetails.field('Requester')).toHaveText(employee.name);
          await expect(reviewerDetails.field('Amount')).toHaveText('175.50');
          await expect(reviewerDetails.field('Status')).toHaveText('SUBMITTED');
          await expect(reviewerDetails.field('Review comment')).toBeHidden();
        });

        await test.step('A whitespace-only rejection comment is refused by the server', async () => {
          await reviewerDetails.reject('   ');

          await expect(reviewerDetails.validationAlert).toBeVisible();
          await expect(reviewerDetails.rejectionComment).toHaveAttribute('aria-invalid', 'true');
          await expect(reviewerDetails.rejectionComment).toHaveAccessibleDescription(/\S/);
          // Not rejected: still SUBMITTED, no comment stored, review still possible.
          await expect(reviewerDetails.field('Status')).toHaveText('SUBMITTED');
          await expect(reviewerDetails.field('Review comment')).toBeHidden();
          await expect(reviewerDetails.approveButton).toBeVisible();
          await expect(reviewerDetails.rejectButton).toBeVisible();
        });

        await test.step('Jordan rejects the request with a comment', async () => {
          await reviewerDetails.reject(rejectionComment);

          await expect(reviewerPage).toHaveURL(reviewerDetails.isUrlOf(requestId));
          await expect(reviewerDetails.field('Status')).toHaveText('REJECTED');
          await expect(reviewerDetails.field('Review comment')).toHaveText(rejectionComment);
          // Terminal state: no review action is offered any more.
          await expect(reviewerDetails.approveButton).toBeHidden();
          await expect(reviewerDetails.rejectButton).toBeHidden();
          await expect(reviewerDetails.rejectionComment).toBeHidden();
        });

        await test.step('Alex sees the rejection and its comment in the same session', async () => {
          await employeeDetails.open(requestId);

          await expect(employeePage).toHaveURL(employeeDetails.isUrlOf(requestId));
          await expect(employeeDetails.field('Status')).toHaveText('REJECTED');
          await expect(employeeDetails.field('Review comment')).toHaveText(rejectionComment);
          await expect(employeeDetails.editLink).toBeHidden();
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
            amount: 175.5,
            requester: { id: employee.id, name: employee.name },
            status: 'REJECTED',
            reviewComment: rejectionComment,
          });
        });
      } finally {
        await employeeContext.close();
        await reviewerContext.close();
      }
    },
  );
});
