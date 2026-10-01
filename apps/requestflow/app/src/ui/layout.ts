import type { User } from '../domain/types';
import { roleLabel } from './format';
import { html, SafeHtml } from './html';

const STYLES = `
:root {
  --bg: #f5f6f8; --surface: #ffffff; --text: #1d2330; --muted: #5d6576; --border: #dde1e8;
  --accent: #2f5bd3; --accent-text: #ffffff; --danger: #b42318; --danger-bg: #fdecea;
  --radius: 8px;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.app-header { background: var(--surface); border-bottom: 1px solid var(--border); }
.app-header .inner {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px;
  max-width: 960px; margin: 0 auto; padding: 12px 16px;
}
.brand { font-weight: 700; font-size: 1.125rem; color: var(--text); text-decoration: none; }
.app-header nav ul { display: flex; gap: 16px; margin: 0; padding: 0; list-style: none; }
.app-header nav a { color: var(--accent); text-decoration: none; font-weight: 500; }
.app-header nav a:hover { text-decoration: underline; }
.session { display: flex; align-items: center; gap: 12px; margin-left: auto; color: var(--muted); }
.session p { margin: 0; }
.session strong { color: var(--text); }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 16px; }
h2 { font-size: 1.125rem; margin: 0 0 12px; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 20px; margin-bottom: 16px;
}
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 16px; }
.toolbar h1 { margin: 0; margin-right: auto; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--surface); }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
th { font-size: 0.875rem; color: var(--muted); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
a { color: var(--accent); }
.status {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.02em;
}
.status-draft { background: #eceef2; color: #3d4452; }
.status-submitted { background: #e6eefc; color: #1f47b0; }
.status-approved { background: #e3f4e8; color: #1c6b37; }
.status-rejected { background: var(--danger-bg); color: var(--danger); }
dl.details { display: grid; grid-template-columns: max-content 1fr; gap: 8px 24px; margin: 0; }
dl.details dt { color: var(--muted); font-weight: 500; }
dl.details dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.field { margin-bottom: 16px; }
.field label { display: block; font-weight: 600; margin-bottom: 4px; }
input[type="text"], textarea {
  width: 100%; padding: 8px 10px; font: inherit; color: inherit;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface);
}
input[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: var(--danger); }
.field-error { color: var(--danger); margin: 4px 0 0; font-size: 0.875rem; }
.error-summary {
  border: 1px solid var(--danger); background: var(--danger-bg); color: var(--danger);
  border-radius: var(--radius); padding: 12px 16px; margin-bottom: 16px;
}
.error-summary p, .error-summary ul { margin: 0; }
.error-summary ul { padding-left: 20px; margin-top: 4px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 16px; }
form.inline { display: inline; margin: 0; }
button, .button {
  display: inline-block; padding: 8px 16px; font: inherit; font-weight: 600;
  border-radius: 6px; border: 1px solid var(--accent); cursor: pointer; text-decoration: none;
  background: var(--accent); color: var(--accent-text);
}
button.secondary, .button.secondary { background: var(--surface); color: var(--accent); }
button.danger { background: var(--danger); border-color: var(--danger); }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 3px solid #9db5f2; outline-offset: 2px;
}
.muted { color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
.login-users { display: grid; gap: 12px; max-width: 420px; }
.login-user { display: flex; align-items: center; gap: 12px; }
.login-user button { flex: 1; text-align: left; }
`;

/** The stylesheet is a trusted constant, so it is inserted without escaping. */
const STYLESHEET = new SafeHtml(STYLES);

export interface PageOptions {
  readonly title: string;
  readonly user?: User | undefined;
  readonly body: SafeHtml;
}

function navigation(user: User): SafeHtml {
  const links =
    user.role === 'EMPLOYEE'
      ? html`<li><a href="/requests">My requests</a></li>
          <li><a href="/requests/new">New request</a></li>`
      : html`<li><a href="/review-queue">Review queue</a></li>`;
  return html`<nav aria-label="Main">
    <ul>
      ${links}
    </ul>
  </nav>`;
}

function header(user: User | undefined): SafeHtml {
  return html`
    <header class="app-header">
      <div class="inner">
        <a class="brand" href="/">RequestFlow</a>
        ${user && navigation(user)}
        ${
          user &&
          html`<div class="session">
            <p>Signed in as <strong>${user.name}</strong> · ${roleLabel(user.role)}</p>
            <form class="inline" method="post" action="/logout">
              <button type="submit" class="secondary">Log out</button>
            </form>
          </div>`
        }
      </div>
    </header>
  `;
}

export function renderPage({ title, user, body }: PageOptions): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · RequestFlow</title>
        <style>
          ${STYLESHEET}
        </style>
      </head>
      <body>
        ${header(user)}
        <main>${body}</main>
      </body>
    </html>`.value;
}
