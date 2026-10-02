import type { Locator, Page } from '@playwright/test';

/** Request details are served at /requests/:id. */
const DETAILS_PATH = /\/requests\/(?<id>[^/?#]+)$/;

export type RequestField =
  | 'Title'
  | 'Description'
  | 'Amount'
  | 'Requester'
  | 'Status'
  | 'Review comment'
  | 'Created'
  | 'Updated';

export class RequestDetailsPage {
  readonly heading: Locator;
  readonly url = DETAILS_PATH;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
  }

  /** The value shown for a field in the details list (`<dt>` term → its `<dd>` definition). */
  field(name: RequestField): Locator {
    return this.page
      .getByRole('term')
      .filter({ hasText: new RegExp(`^${name}$`) })
      .locator('xpath=following-sibling::dd[1]');
  }

  /** The request ID from the current details URL. Call after the details page has loaded. */
  requestId(): string | undefined {
    return DETAILS_PATH.exec(new URL(this.page.url()).pathname)?.groups?.['id'];
  }
}
