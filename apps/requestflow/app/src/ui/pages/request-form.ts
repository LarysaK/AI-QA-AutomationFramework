import type { FieldIssue } from '../../domain/errors';
import type { User } from '../../domain/types';
import { errorSummary, fieldErrorParts } from '../form-errors';
import { html } from '../html';
import { renderPage } from '../layout';

/** Raw form values, re-displayed exactly as entered when validation fails. */
export interface RequestFormValues {
  readonly title: string;
  readonly description: string;
  readonly amount: string;
}

export type RequestFormMode = { kind: 'create' } | { kind: 'edit'; requestId: string };

export function renderRequestFormPage(
  user: User,
  mode: RequestFormMode,
  values: RequestFormValues,
  issues: readonly FieldIssue[] = [],
): string {
  const isEdit = mode.kind === 'edit';
  const heading = isEdit ? 'Edit request' : 'New request';
  const action = isEdit ? `/requests/${encodeURIComponent(mode.requestId)}/edit` : '/requests';
  const cancelHref = isEdit ? `/requests/${encodeURIComponent(mode.requestId)}` : '/requests';

  const title = fieldErrorParts(issues, 'title');
  const description = fieldErrorParts(issues, 'description');
  const amount = fieldErrorParts(issues, 'amount');

  // `novalidate` and no length/number constraints: validation is the server's job,
  // and its feedback must be reachable through the UI.
  return renderPage({
    title: heading,
    user,
    body: html`
      <section class="card" aria-labelledby="form-heading">
        <h1 id="form-heading">${heading}</h1>
        <form method="post" action="${action}" novalidate aria-labelledby="form-heading">
          ${errorSummary(issues)}
          <div class="field">
            <label for="title">Title</label>
            <input
              type="text"
              id="title"
              name="title"
              value="${values.title}"
              ${title.attributes}
            />
            ${title.message}
          </div>
          <div class="field">
            <label for="description">Description</label>
            <textarea id="description" name="description" rows="5" ${description.attributes}>
${values.description}</textarea>
            ${description.message}
          </div>
          <div class="field">
            <label for="amount">Amount</label>
            <input
              type="text"
              id="amount"
              name="amount"
              inputmode="decimal"
              value="${values.amount}"
              ${amount.attributes}
            />
            ${amount.message}
          </div>
          <div class="actions">
            <button type="submit">${isEdit ? 'Save changes' : 'Save draft'}</button>
            <a href="${cancelHref}">Cancel</a>
          </div>
        </form>
      </section>
    `,
  });
}
