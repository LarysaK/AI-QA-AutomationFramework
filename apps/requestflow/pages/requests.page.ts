import type { Locator, Page } from '@playwright/test';

/** The Employee's "My requests" page. */
export class RequestsPage {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'My requests', level: 1 });
  }

  async openNewRequest(): Promise<void> {
    // The header navigation has a link with the same name; use the one in the page content.
    await this.page.getByRole('main').getByRole('link', { name: 'New request' }).click();
  }
}
