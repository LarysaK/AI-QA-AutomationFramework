import type { Request } from '../../domain/types';
import { formatAmount, statusBadge } from '../format';
import { html, type SafeHtml } from '../html';

/** Shared request table. The table is named by the page heading via `labelledBy`. */
export function requestTable(
  requests: readonly Request[],
  options: { labelledBy: string; showRequester: boolean },
): SafeHtml {
  return html`
    <div class="table-wrap">
      <table aria-labelledby="${options.labelledBy}">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col" class="num">Amount</th>
            ${options.showRequester && html`<th scope="col">Requester</th>`}
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          ${requests.map(
            (request) => html`
              <tr>
                <td><a href="/requests/${encodeURIComponent(request.id)}">${request.title}</a></td>
                <td class="num">${formatAmount(request.amount)}</td>
                ${options.showRequester && html`<td>${request.requester.name}</td>`}
                <td>${statusBadge(request.status)}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}
