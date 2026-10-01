import type { FieldIssue } from '../../domain/errors';
import { canApply } from '../../domain/transitions';
import type { Request, User } from '../../domain/types';
import { errorSummary, fieldErrorParts } from '../form-errors';
import { formatAmount, formatTimestamp, statusBadge } from '../format';
import { html, type SafeHtml } from '../html';
import { renderPage } from '../layout';

export interface RejectFormState {
  readonly comment: string;
  readonly issues: readonly FieldIssue[];
}

/**
 * Controls are only offered when the action is possible; the server still
 * enforces every rule when the form is posted.
 */
export function renderRequestDetailsPage(
  user: User,
  request: Request,
  reject: RejectFormState = { comment: '', issues: [] },
): string {
  const path = `/requests/${encodeURIComponent(request.id)}`;
  const isEmployee = user.role === 'EMPLOYEE';
  const back = isEmployee
    ? html`<a href="/requests">Back to My requests</a>`
    : html`<a href="/review-queue">Back to Review queue</a>`;

  return renderPage({
    title: request.title,
    user,
    body: html`
      <p>${back}</p>
      <section class="card" aria-labelledby="request-heading">
        <h1 id="request-heading">${request.title}</h1>
        <dl class="details">
          <dt>Title</dt>
          <dd>${request.title}</dd>
          <dt>Description</dt>
          <dd>${request.description}</dd>
          <dt>Amount</dt>
          <dd>${formatAmount(request.amount)}</dd>
          <dt>Requester</dt>
          <dd>${request.requester.name}</dd>
          <dt>Status</dt>
          <dd>${statusBadge(request.status)}</dd>
          ${
            request.reviewComment !== null &&
            html`<dt>Review comment</dt>
              <dd>${request.reviewComment}</dd>`
          }
          <dt>Created</dt>
          <dd>${formatTimestamp(request.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>${formatTimestamp(request.updatedAt)}</dd>
        </dl>
        ${isEmployee && canApply('edit', request.status) && ownerActions(path)}
      </section>
      ${!isEmployee && canApply('approve', request.status) && reviewActions(path, reject)}
    `,
  });
}

function ownerActions(path: string): SafeHtml {
  return html`
    <div class="actions">
      <a class="button secondary" href="${path}/edit">Edit</a>
      <form class="inline" method="post" action="${path}/submit">
        <button type="submit">Submit for review</button>
      </form>
    </div>
  `;
}

function reviewActions(path: string, reject: RejectFormState): SafeHtml {
  const comment = fieldErrorParts(reject.issues, 'comment');
  return html`
    <section class="card" aria-labelledby="review-heading">
      <h2 id="review-heading">Review</h2>
      <form method="post" action="${path}/approve">
        <button type="submit">Approve</button>
      </form>
      <hr />
      <form method="post" action="${path}/reject" novalidate>
        ${errorSummary(reject.issues)}
        <div class="field">
          <label for="comment">Rejection comment</label>
          <textarea id="comment" name="comment" rows="3" ${comment.attributes}>
${reject.comment}</textarea>
          ${comment.message}
        </div>
        <button type="submit" class="danger">Reject</button>
      </form>
    </section>
  `;
}
