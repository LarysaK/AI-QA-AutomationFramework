import type { Locator, Page } from '@playwright/test';

/** The Reviewer's "Review queue" page. */
export class ReviewQueuePage {
  readonly heading: Locator;
  readonly table: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Review queue', level: 1 });
    this.table = page.getByRole('table', { name: 'Review queue' });
  }

  async open(): Promise<void> {
    await this.page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Review queue' })
      .click();
  }

  /** The queue row whose title link is exactly `title`. Titles are unique per test. */
  row(title: string): Locator {
    return this.table
      .getByRole('row')
      .filter({ has: this.page.getByRole('link', { name: title, exact: true }) });
  }

  async openRequest(title: string): Promise<void> {
    await this.row(title).getByRole('link', { name: title, exact: true }).click();
  }
}
