import type { FieldIssue } from '../domain/errors';
import { html, type SafeHtml } from './html';

const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: 'Title',
  description: 'Description',
  amount: 'Amount',
  comment: 'Rejection comment',
  userId: 'Demo user',
};

/** Presentation wording only; the rule itself comes from domain validation. */
function wording(message: string): string {
  return message === 'must be a JSON number' ? 'must be a number' : message;
}

export function issueText(issue: FieldIssue): string {
  const label = FIELD_LABELS[issue.field];
  return label === undefined
    ? `Form ${wording(issue.message)}`
    : `${label} ${wording(issue.message)}`;
}

/** Summary announced to assistive technology; shown at the top of a form. */
export function errorSummary(issues: readonly FieldIssue[]): SafeHtml {
  if (issues.length === 0) return html``;
  return html`
    <div class="error-summary" role="alert">
      <p><strong>Please correct the following:</strong></p>
      <ul>
        ${issues.map((issue) => html`<li>${issueText(issue)}</li>`)}
      </ul>
    </div>
  `;
}

export function fieldIssue(issues: readonly FieldIssue[], field: string): FieldIssue | undefined {
  return issues.find((issue) => issue.field === field);
}

/** `aria-invalid` / `aria-describedby` attributes plus the inline message for one field. */
export function fieldErrorParts(
  issues: readonly FieldIssue[],
  field: string,
): { attributes: SafeHtml; message: SafeHtml } {
  const issue = fieldIssue(issues, field);
  if (!issue) return { attributes: html``, message: html`` };
  return {
    attributes: html` aria-invalid="true" aria-describedby="${field}-error"`,
    message: html`<p class="field-error" id="${field}-error">${issueText(issue)}</p>`,
  };
}
