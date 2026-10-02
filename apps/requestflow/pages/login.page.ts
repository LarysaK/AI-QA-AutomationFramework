import type { Page } from '@playwright/test';

import type { DemoUser } from '../data/demo-users';

export class LoginPage {
  constructor(private readonly page: Page) {}

  /** Opens RequestFlow; without a session the start page leads to the login page. */
  async open(): Promise<void> {
    await this.page.goto('/');
  }

  async logInAs(user: DemoUser): Promise<void> {
    await this.page.getByRole('button', { name: `Log in as ${user.name}`, exact: true }).click();
  }
}
