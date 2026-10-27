// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';

import { CONTENT_SECURITY_POLICY, notFoundHtml, resolveBase } from '../build/site';
import { verifySite } from '../build/verify-site';

/**
 * The GitHub Pages build: the real vite.config.ts with DASHBOARD_BASE set to the repository
 * subpath, as the Pages workflow builds it, with the real snapshot and the real CI history
 * fixture (the export of ci-history at f51780b). The output is checked as GitHub Pages serves it:
 * index.html at the subpath, 404.html at any unknown path below it.
 */

const DASHBOARD = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(DASHBOARD, '../..');
const SUBPATH = '/AI-QA-AutomationFramework/';
const FIXTURE = resolve(DASHBOARD, 'test/fixtures/ci-history.json');

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A production build with the real configuration; `base` as DASHBOARD_BASE (unset if null). */
async function buildSite(base: string | null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-pages-'));
  dirs.push(dir);
  const outDir = join(dir, 'site');
  const previous = { base: process.env['DASHBOARD_BASE'], env: process.env['NODE_ENV'] };
  if (base === null) delete process.env['DASHBOARD_BASE'];
  else process.env['DASHBOARD_BASE'] = base;
  // Vitest sets NODE_ENV=test, which would build React's development variant (with source
  // locations); the Pages workflow builds in production mode.
  process.env['NODE_ENV'] = 'production';
  try {
    await build({
      root: DASHBOARD,
      configFile: resolve(DASHBOARD, 'vite.config.ts'),
      configLoader: 'bundle',
      mode: 'production',
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (previous.base === undefined) delete process.env['DASHBOARD_BASE'];
    else process.env['DASHBOARD_BASE'] = previous.base;
    if (previous.env === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous.env;
  }
  return outDir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
const forbidden = [REPO_ROOT, homedir()];

describe('base path', () => {
  test('unset means relative asset URLs; the Pages subpath is accepted as given', () => {
    expect(resolveBase(undefined)).toBe('./');
    expect(resolveBase('')).toBe('./');
    expect(resolveBase(SUBPATH)).toBe(SUBPATH);
  });

  test.each([
    'AI-QA-AutomationFramework',
    '/AI-QA-AutomationFramework',
    'AI-QA-AutomationFramework/',
    '/a/b/',
    '//evil.example/',
    'https://evil.example/',
    '/../',
    '/./',
    '/with space/',
    '/<script>/',
  ])('rejects %s', (value) => {
    expect(() => resolveBase(value)).toThrow(/DASHBOARD_BASE must be one path segment/);
  });
});

describe('404 page', () => {
  test('static, script-free, with the same CSP and absolute links to the dashboard', () => {
    const html = notFoundHtml(SUBPATH, 'assets/index-abc.css');
    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY}"`);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(`<link rel="stylesheet" href="${SUBPATH}assets/index-abc.css" />`);
    expect(html).toContain(`<a href="${SUBPATH}">Go to the dashboard</a>`);
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });
});

describe('GitHub Pages build (real configuration, repository subpath)', () => {
  test('assets, lazy chunks, CSP and 404 page all resolve under the subpath', async () => {
    const historyFile = resolve(REPO_ROOT, 'artifacts/dashboard/ci-history.json');
    const hadHistory = existsSync(historyFile);
    const saved = hadHistory ? readFileSync(historyFile) : null;
    // The real configuration reads the export from artifacts/; use the fixture, then restore.
    writeFileSync(historyFile, readFileSync(FIXTURE));
    let site: string;
    try {
      site = await buildSite(SUBPATH);
    } finally {
      if (saved === null) rmSync(historyFile, { force: true });
      else writeFileSync(historyFile, saved);
    }

    expect(verifySite(site, SUBPATH, { requireHistory: true, forbidden })).toEqual([]);

    const index = read(site, 'index.html');
    expect(index).toMatch(
      new RegExp(`<script type="module" crossorigin src="${SUBPATH}assets/index-[\\w-]+\\.js">`),
    );
    expect(index).toMatch(
      new RegExp(`<link rel="stylesheet" crossorigin href="${SUBPATH}assets/index-[\\w-]+\\.css">`),
    );
    expect(index).not.toContain('/src/');
    expect(read(site, '404.html')).toContain(`<a href="${SUBPATH}">Go to the dashboard</a>`);

    // Route-level lazy loading is preserved: each lazy page is its own chunk.
    const entry = /src="[^"]*\/(assets\/index-[\w-]+\.js)"/.exec(index)?.[1] ?? '';
    const imports = [...read(site, entry).matchAll(/import\(`\.\/([A-Za-z]+)-[\w-]+\.js`\)/g)].map(
      (m) => m[1],
    );
    for (const page of [
      'TestPlanPage',
      'TestCasesPage',
      'TestCaseDetail',
      'ExecutionsPage',
      'AgentsPage',
      'DefectsPage',
    ]) {
      expect(imports).toContain(page);
    }
  });

  test('without DASHBOARD_BASE the build stays relative, with no 404 page', async () => {
    const site = await buildSite(null);
    expect(verifySite(site, './', { forbidden })).toEqual([]);
    expect(read(site, 'index.html')).toMatch(/src="\.\/assets\/index-[\w-]+\.js"/);
    expect(existsSync(join(site, '404.html'))).toBe(false);
  });
});

describe('site verification', () => {
  test('finds a missing chunk, a missing or changed CSP, inline script, another origin and local paths', async () => {
    const site = await buildSite(SUBPATH);
    const html = read(site, 'index.html');
    const variants: [string, () => void, RegExp][] = [
      [
        'a changed CSP',
        () => {
          writeFileSync(
            join(site, 'index.html'),
            html.replace('connect-src &#39;none&#39;', 'connect-src *'),
          );
        },
        /index\.html: the Content-Security-Policy is missing or different/,
      ],
      [
        'an inline script',
        () => {
          writeFileSync(
            join(site, 'index.html'),
            html.replace('</body>', '<script>1</script></body>'),
          );
        },
        /index\.html: inline script/,
      ],
      [
        'another origin',
        () => {
          writeFileSync(
            join(site, 'index.html'),
            html.replace('</head>', '<script src="https://cdn.example/x.js"></script></head>'),
          );
        },
        /index\.html: references another origin or path/,
      ],
      [
        'a relative asset (breaks on 404.html at depth)',
        () => {
          writeFileSync(
            join(site, '404.html'),
            read(site, '404.html').replace(`href="${SUBPATH}assets/`, 'href="assets/'),
          );
        },
        /404\.html: references a missing file/,
      ],
      [
        'a local path',
        () => {
          writeFileSync(
            join(site, 'index.html'),
            html.replace('</body>', `<!-- ${REPO_ROOT} --></body>`),
          );
        },
        /index\.html: contains a local path/,
      ],
    ];
    for (const [, change, problem] of variants) {
      change();
      expect(verifySite(site, SUBPATH, { forbidden }).join('\n')).toMatch(problem);
      writeFileSync(join(site, 'index.html'), html);
    }

    // A missing lazy chunk, and a build without the CI history when it is required.
    const entry = /src="[^"]*\/(assets\/index-[\w-]+\.js)"/.exec(html)?.[1] ?? '';
    const chunk = /import\(`\.\/(AgentsPage-[\w-]+\.js)`\)/.exec(read(site, entry))?.[1] ?? '';
    rmSync(join(site, 'assets', chunk));
    const problems = verifySite(site, SUBPATH, { requireHistory: true, forbidden });
    expect(problems).toContain(`${entry}: imports a missing chunk`);
  });
});
