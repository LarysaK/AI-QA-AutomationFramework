import type { Plugin } from 'vite';

/**
 * How the static site is served: its base path, its Content-Security-Policy and, for hosts that
 * serve a 404 page (GitHub Pages), a static not-found page.
 *
 * Routing is in the URL hash (src/router.ts), so every dashboard page, including a refreshed or
 * directly opened nested route such as `#/test-cases/TC-003-07`, is the same document: the host
 * only ever serves index.html and its assets. No server rewrites are needed.
 */

/**
 * Production pages get a strict Content-Security-Policy: same-origin scripts and styles only, no
 * inline code, no network requests, and no external images or fonts. The app is a static bundle
 * with its data embedded, so it never fetches anything. (Not applied to the dev server, whose
 * React refresh runtime needs an inline script and whose HMR client needs a WebSocket.)
 *
 * Delivered as a <meta> tag, which cannot carry `frame-ancestors` (anti-framing); that requires
 * an HTTP response header from the host. See README.md.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

const SUBPATH = /^\/[A-Za-z0-9._-]+\/$/;

/**
 * The site's base path from DASHBOARD_BASE: unset means relative asset URLs (`./`), which work
 * from any directory; a GitHub Pages project site sets its repository subpath, such as
 * `/AI-QA-AutomationFramework/`. Only one path segment is accepted: never a URL, another origin
 * or a protocol-relative path.
 */
export function resolveBase(value: string | undefined): string {
  if (value === undefined || value === '') return './';
  if (!SUBPATH.test(value) || value === '/./' || value === '/../') {
    throw new Error(
      'DASHBOARD_BASE must be one path segment with slashes on both sides, such as /AI-QA-AutomationFramework/',
    );
  }
  return value;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The static not-found page: no script, the same CSP, the dashboard's stylesheet. */
export function notFoundHtml(base: string, stylesheet: string): string {
  const root = escapeHtml(base);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex" />
    <title>Page not found · RequestFlow QA Dashboard</title>
    <link rel="stylesheet" href="${root}${escapeHtml(stylesheet)}" />
  </head>
  <body>
    <main id="main" class="main">
      <header class="page-header">
        <p class="eyebrow">Not found</p>
        <h1>Page not found</h1>
        <div class="page-lede">
          <p>
            This address is not part of the RequestFlow QA Dashboard. Its pages are addressed
            after a <code>#</code>, for example <code>${root}#/test-cases</code>.
          </p>
          <p><a href="${root}">Go to the dashboard</a></p>
        </div>
      </header>
    </main>
  </body>
</html>
`;
}

/**
 * Emits 404.html for hosts that serve it for unknown paths (GitHub Pages). Only with an absolute
 * base: the page can be served at any depth, so its stylesheet and link must not be relative.
 */
export function notFoundPage(base: string): Plugin {
  return {
    name: 'not-found-page',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (base === './') return;
      const styles = Object.values(bundle).filter(
        (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
      );
      if (styles.length !== 1 || styles[0] === undefined) {
        this.error(`expected exactly one stylesheet for 404.html, found ${String(styles.length)}`);
      }
      this.emitFile({
        type: 'asset',
        fileName: '404.html',
        source: notFoundHtml(base, styles[0].fileName),
      });
    },
  };
}
