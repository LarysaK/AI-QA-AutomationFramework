import type { Locator, Page } from '@playwright/test';

/** Values as a user types them into the form. */
export interface RequestFormInput {
  readonly title: string;
  readonly description: string;
  readonly amount: string;
}

/** The New request / Edit request form. */
export class RequestFormPage {
  readonly title: Locator;
  readonly description: Locator;
  readonly amount: Locator;

  constructor(private readonly page: Page) {
    this.title = page.getByLabel('Title');
    this.description = page.getByLabel('Description');
    this.amount = page.getByLabel('Amount');
  }

  async fill(input: RequestFormInput): Promise<void> {
    await this.title.fill(input.title);
    await this.description.fill(input.description);
    await this.amount.fill(input.amount);
  }

  async saveDraft(input: RequestFormInput): Promise<void> {
    await this.fill(input);
    await this.page.getByRole('button', { name: 'Save draft' }).click();
  }
}
