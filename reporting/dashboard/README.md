# RequestFlow QA Dashboard

A read-only, static React site that renders two build-time inputs: the validated dashboard
snapshot built from the approved requirements, the approved test plan and the committed
Playwright tests, and, optionally, the published CI execution history exported from the
`ci-history` branch. It has no backend and makes no network requests.

## Build prerequisites and order

The dashboard is **not** buildable on its own. It needs the repository root's install, because
the snapshot it renders is produced by the root project, and because its build reuses the root
project's snapshot validator. Run, from the repository root:

```bash
npm ci                                   # 1. root install (Playwright, Ajv 8, tsx, @types/node)
npm run dashboard:data                   # 2. writes artifacts/dashboard/dashboard-data.json
npm run dashboard:history -- --history <checkout of ci-history>   # optional, see below
npm --prefix reporting/dashboard ci      # 3. dashboard install (React, Vite, Vitest, ESLint)
npm --prefix reporting/dashboard run build   # 4. writes artifacts/dashboard-site/
```

The dashboard's `typecheck`, `lint` and `test` scripts need steps 1–3 as well; `test` and `build`
also need the snapshot from step 2. `npm --prefix reporting/dashboard run dev` serves it locally.

### Why the root install is required

- **Ajv 8.** The Vite build validates the snapshot with `reporting/dashboard-data/validate.ts`,
  the same validator and JSON Schema the snapshot builder uses. That file resolves `ajv` from its
  own location, which is the root `node_modules` (Ajv 8, with `ajv/dist/2020`). The dashboard's
  own `node_modules` contains only Ajv 6, as a dependency of ESLint, which has no `dist/2020`.
- **@types/node.** `tsconfig.node.json` (the Vite config, the snapshot plugin and its tests)
  uses Node types. The dashboard package does not install `@types/node`; TypeScript finds the root
  project's copy by walking up the directory tree.
- **Public-safety scan.** The build also reuses `reporting/dashboard-data/sanitize.ts`.

Keeping one validator, one schema and one safety scan is deliberate; the dashboard does not carry
copies of them.

### The snapshot cleanliness gate

`npm run dashboard:data` refuses to run, and writes nothing, while any discovery input has
uncommitted changes: `specs/<app>/`, `tests/`, `apps/`, `framework/`, `playwright.config.ts`,
`tsconfig.json` or `package.json` (modified, staged, type-changed or untracked files, and ignored
files Node could load). Playwright discovery imports the committed tests and what they load, so
the gate keeps uncommitted code, such as a staged AI proposal copied by hand, from running, and
keeps the snapshot's `source.commit` accurate. It is a git-based gate, not a sandbox.

Commit (or stash) changes to those paths first. `npm run dashboard:test` fails for the same
reason while they are uncommitted.

## CI execution history (optional)

The Executions page, the Overview's execution figures and the per-test-case CI result come from
`artifacts/dashboard/ci-history.json`, written by:

```bash
git clone --branch ci-history https://github.com/LarysaK/AI-QA-AutomationFramework.git ../ci-history
# optional: coverage of unpublished CI runs (read-only GitHub API requests)
npx tsx reporting/ci/reconcile-cli.ts --history ../ci-history > ../reconciliation.json
npm run dashboard:history -- --history ../ci-history --reconciliation ../reconciliation.json
```

- **Read-only and verified.** The exporter reads a git checkout of `ci-history`, refuses to
  write anything unless the history passes the full schema and public-safety validation and the
  immutability audit of its git log, and writes only the output file. A reconciliation report is
  accepted only for the same `ci-history` commit with integrity verified.
- **Build-time snapshot.** The page names the `ci-history` commit and its commit time, and says
  it does not update live. New runs appear only after the export and the build are run again.
- **Missing export.** The build embeds `null` and the page says the history is not included in
  this build (never that no CI runs exist). `DASHBOARD_REQUIRE_CI_HISTORY=1` makes a missing
  export fail the build instead; an invalid or unsafe export always fails it.
- **Published records only.** "Published CI runs" counts records. Unpublished eligible attempts
  are listed separately and are never shown as failed; coverage that was not checked or is
  undetermined is stated as such.
- **Results and test cases.** A Playwright result is related to a test case only when the run
  tested exactly the snapshot's commit with the snapshot's Playwright version, its
  (instance ID, project) is reported once, exactly one committed instance has that ID and project,
  and the test case's `@TC` tag and the snapshot's linkage agree. Otherwise the result is listed
  by instance ID, marked unmatched or ambiguous. Suite counts are never turned into per-test-case
  results, and titles are never compared.

## What the build checks

`build/snapshot-plugin.ts` embeds the snapshot only if it passes, in Node, the same checks the
builder applies before writing it: the JSON Schema and the public-safety scan (local paths,
credentials, environment-variable names, e-mail addresses, stack traces, and the repository,
home and temp directories).
A missing, invalid or unsafe snapshot fails the dev server, the tests and the build, and nothing
is emitted. The scan is pattern-based: it catches what it has patterns for. The real protection
is that the snapshot builder copies allowlisted fields only.

The Vite config is loaded with Vite's bundling config loader, set explicitly
(`--configLoader bundle`) in every script. The experimental `native` loader cannot load this
config, because it imports the shared TypeScript validator from outside the package.

## Content Security Policy

Production pages carry this policy as a `<meta http-equiv="Content-Security-Policy">` tag:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

- No inline scripts or styles; charts are native `<meter>` elements.
- `connect-src 'none'`: the site makes no requests (Vite's modulepreload polyfill is disabled).
- Markdown is rendered without raw HTML; images are never loaded and only `https:` links become
  links.
- The dev server does not get this policy: its React refresh runtime needs an inline script.

A `<meta>` policy **cannot** set `frame-ancestors`, so it does not prevent other sites from
framing the dashboard. That needs an HTTP response header (`Content-Security-Policy:
frame-ancestors 'none'`, or `X-Frame-Options: DENY`) set by the host. Whether the chosen host can
set custom response headers has to be checked when the deployment target is decided.
