import type { Request, User } from '../../domain/types';
import { html } from '../html';
import { renderPage } from '../layout';
import { requestTable } from './request-table';

export function renderReviewQueuePage(user: User, requests: readonly Request[]): string {
  return renderPage({
    title: 'Review queue',
    user,
    body: html`
      <div class="toolbar">
        <h1 id="page-heading">Review queue</h1>
      </div>
      ${
        requests.length === 0
          ? html`<p class="card muted">No requests are waiting for review.</p>`
          : requestTable(requests, { labelledBy: 'page-heading', showRequester: true })
      }
    `,
  });
}
