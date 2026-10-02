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

  /** Owner actions, offered only on the Employee's own DRAFT. */
  readonly editLink: Locator;
  readonly submitButton: Locator;

  /** Review actions, offered only to a Reviewer on a SUBMITTED request. */
  readonly approveButton: Locator;
  readonly rejectButton: Locator;
  readonly rejectionComment: Locator;

  /** Validation feedback rendered by the server after a rejected form submission. */
  readonly validationAlert: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
    this.editLink = page.getByRole('main').getByRole('link', { name: 'Edit' });
    this.submitButton = page.getByRole('button', { name: 'Submit for review' });
    this.approveButton = page.getByRole('button', { name: 'Approve' });
    this.rejectButton = page.getByRole('button', { name: 'Reject' });
    this.rejectionComment = page.getByLabel('Rejection comment');
    this.validationAlert = page.getByRole('alert');
  }

  async open(id: string): Promise<void> {
    await this.page.goto(`/requests/${encodeURIComponent(id)}`);
  }

  /** The value shown for a field in the details list (`<dt>` term → its `<dd>` definition). */
  field(name: RequestField): Locator {
    return this.page
      .getByRole('term')
      .filter({ hasText: new RegExp(`^${name}$`) })
      .locator('xpath=following-sibling::dd[1]');
  }

  /** The request ID from the current details URL. Call after the details page has loaded. */
  requestId(): string {
    const id = DETAILS_PATH.exec(new URL(this.page.url()).pathname)?.groups?.['id'];
    if (id === undefined) throw new Error(`Not on a request details page: ${this.page.url()}`);
    return id;
  }

  /** Matches the details URL of one specific request, for `expect(page).toHaveURL(...)`. */
  isUrlOf(id: string): (url: URL) => boolean {
    return (url) => url.pathname === `/requests/${encodeURIComponent(id)}`;
  }

  async submitForReview(): Promise<void> {
    await this.submitButton.click();
  }

  async approve(): Promise<void> {
    await this.approveButton.click();
  }

  async reject(comment: string): Promise<void> {
    await this.rejectionComment.fill(comment);
    await this.rejectButton.click();
  }
}
