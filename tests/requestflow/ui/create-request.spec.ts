import { expect, test } from '@playwright/test';

import { DEMO_USERS } from '../../../apps/requestflow/data/demo-users';
import { LoginPage } from '../../../apps/requestflow/pages/login.page';
import { RequestDetailsPage } from '../../../apps/requestflow/pages/request-details.page';
import { RequestFormPage } from '../../../apps/requestflow/pages/request-form.page';
import { RequestsPage } from '../../../apps/requestflow/pages/requests.page';

test.describe('REQ-001 Create a request', () => {
  test(
    'Employee creates a valid request and sees it as a DRAFT',
    { tag: ['@REQ-001', '@TC-001-17', '@CAN-001'] },
    async ({ page }) => {
      const employee = DEMO_USERS.alex;
      const request = {
        title: 'Conference ticket',
        description: 'Annual QA conference',
        amount: '120.50',
      };

      const loginPage = new LoginPage(page);
      const requestsPage = new RequestsPage(page);
      const requestForm = new RequestFormPage(page);
      const details = new RequestDetailsPage(page);

      await loginPage.open();
      await loginPage.logInAs(employee);
      await requestsPage.openNewRequest();
      await requestForm.saveDraft(request);

      await expect(page).toHaveURL(details.url);
      expect(details.requestId()).toBeTruthy();

      await expect(details.heading).toHaveText(request.title);
      await expect(details.field('Title')).toHaveText(request.title);
      await expect(details.field('Description')).toHaveText(request.description);
      await expect(details.field('Amount')).toHaveText('120.50');
      await expect(details.field('Requester')).toHaveText(employee.name);
      await expect(details.field('Status')).toHaveText('DRAFT');
    },
  );
});
