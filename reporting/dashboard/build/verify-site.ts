import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONTENT_SECURITY_POLICY } from './site';

/**
 * Checks a built site before it is published, as GitHub Pages will serve it under `base`:
 *
 *   tsx reporting/dashboard/build/verify-site.ts <site dir> <base> [--require-history]
 *
 * - index.html and 404.html carry the exact Content-Security-Policy, and have no inline script;
 * - every script and stylesheet they reference is a file of the site under `base`, also when
 *   404.html is served at a deep path; nothing is loaded from another origin;
 * - every chunk a script imports is a file of the site (route-level lazy loading);
 * - with --require-history, the CI history export is embedded;
 * - no file contains the repository's absolute path or the home directory.
 * Prints the problems and exits 1 if there are any; reads only, never writes.
 */

const HOST = 'https://pages.invalid';

/** Every file of the site, as a path relative to its root with forward slashes. */
function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

/** The site file a URL resolves to when the page is at `pageUrl`, or null if outside the site. */
function siteFile(reference: string, pageUrl: string, base: string): string | null {
  const url = new URL(reference, pageUrl);
  if (url.origin !== HOST) return null;
  const root = new URL(base, `${HOST}/`).pathname;
  return url.pathname.startsWith(root) ? decodeURIComponent(url.pathname.slice(root.length)) : null;
}

export function verifySite(
  dir: string,
  base: string,
  options: { readonly requireHistory?: boolean; readonly forbidden?: readonly string[] } = {},
): string[] {
  const problems: string[] = [];
  if (!existsSync(dir)) return [`${dir}: no built site`];
  const files = new Set(filesOf(dir));
  const text = (file: string) => readFileSync(join(dir, file), 'utf8');
  const absolute = base.startsWith('/');
  const pageAt = (path: string) => `${HOST}${absolute ? base : '/'}${path}`;

  const pages: [string, string[]][] = [['index.html', [pageAt('')]]];
  if (absolute) pages.push(['404.html', [pageAt('missing'), pageAt('a/b/c/missing')]]);
  else if (files.has('404.html')) problems.push('404.html: emitted with a relative base');

  for (const [page, urls] of pages) {
    if (!files.has(page)) {
      problems.push(`${page}: missing`);
      continue;
    }
    const html = text(page);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
    if (csp?.replace(/&#39;/g, "'") !== CONTENT_SECURITY_POLICY) {
      problems.push(`${page}: the Content-Security-Policy is missing or different`);
    }
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push(`${page}: inline script`);
    const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const reference of references) {
      for (const url of urls) {
        const file = siteFile(reference, url, absolute ? base : '/');
        if (file === null) problems.push(`${page}: references another origin or path`);
        else if (file !== '' && !files.has(file))
          problems.push(`${page}: references a missing file`);
      }
    }
  }

  // Lazy chunks: every relative import of every script is a file next to it.
  for (const file of [...files].filter((f) => f.endsWith('.js'))) {
    const source = text(file);
    for (const m of source.matchAll(/import\(\s*["'`](\.\/[^"'`]+)["'`]\s*\)/g)) {
      const target = new URL(m[1] ?? '', `${HOST}/${file}`).pathname.slice(1);
      if (!files.has(target)) problems.push(`${file}: imports a missing chunk`);
    }
    if (/\bhttps?:\/\/(?:localhost|127\.0\.0\.1)\b/.test(source)) {
      problems.push(`${file}: refers to a local server`);
    }
  }

  if (options.requireHistory === true) {
    const embedded = [...files]
      .filter((f) => f.endsWith('.js'))
      .some((f) => /kind:\s*["'`]ci-history-export["'`]|"kind":"ci-history-export"/.test(text(f)));
    if (!embedded) problems.push('the CI history export is not embedded');
  }

  const forbidden = (options.forbidden ?? []).filter((s) => s.length > 1);
  for (const file of files) {
    const content = text(file);
    if (forbidden.some((literal) => content.includes(literal))) {
      problems.push(`${file}: contains a local path`);
    }
  }
  return [...new Set(problems)];
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  const [dir, base, ...flags] = process.argv.slice(2);
  if (dir === undefined || base === undefined) {
    console.error('usage: verify-site.ts <site dir> <base> [--require-history]');
    process.exit(2);
  }
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const problems = verifySite(resolve(dir), base, {
    requireHistory: flags.includes('--require-history'),
    forbidden: [repoRoot, homedir()],
  });
  if (problems.length > 0) {
    console.error(`the built site is not ready to publish:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`site verified: ${dir} under ${base}`);
}
