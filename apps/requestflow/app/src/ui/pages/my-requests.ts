import type { Request, User } from '../../domain/types';
import { html } from '../html';
import { renderPage } from '../layout';
import { requestTable } from './request-table';

export function renderMyRequestsPage(user: User, requests: readonly Request[]): string {
  return renderPage({
    title: 'My requests',
    user,
    body: html`
      <div class="toolbar">
        <h1 id="page-heading">My requests</h1>
        <a class="button" href="/requests/new">New request</a>
      </div>
      ${
        requests.length === 0
          ? html`<p class="card muted">You have no requests yet.</p>`
          : requestTable(requests, { labelledBy: 'page-heading', showRequester: false })
      }
    `,
  });
}
