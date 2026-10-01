import type { FieldIssue } from '../../domain/errors';
import { DEMO_USERS } from '../../domain/users';
import { errorSummary } from '../form-errors';
import { roleLabel } from '../format';
import { html } from '../html';
import { renderPage } from '../layout';

export function renderLoginPage(issues: readonly FieldIssue[] = []): string {
  return renderPage({
    title: 'Log in',
    body: html`
      <section class="card" aria-labelledby="login-heading">
        <h1 id="login-heading">Log in</h1>
        <p class="muted">Choose a demo user. No password is required.</p>
        ${errorSummary(issues)}
        <form method="post" action="/login" class="login-users">
          ${DEMO_USERS.map(
            (user) =>
              html`<div class="login-user">
                <button type="submit" name="userId" value="${user.id}">
                  Log in as ${user.name}
                </button>
                <span class="muted">${roleLabel(user.role)}</span>
              </div>`,
          )}
        </form>
      </section>
    `,
  });
}
