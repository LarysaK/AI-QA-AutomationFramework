import type { RequestStatus, Role } from '../domain/types';
import { html, type SafeHtml } from './html';

/** Display format only; the API keeps the plain JSON number. */
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

/** Timezone-independent display: `2026-10-01 15:16:16 UTC`. */
export function formatTimestamp(iso: string): SafeHtml {
  const text = iso.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return html`<time datetime="${iso}">${text}</time>`;
}

export function roleLabel(role: Role): string {
  return role === 'EMPLOYEE' ? 'Employee' : 'Reviewer';
}

export function statusBadge(status: RequestStatus): SafeHtml {
  return html`<span class="status status-${status.toLowerCase()}">${status}</span>`;
}
