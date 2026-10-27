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
frame-ancestors 'none'`, or `X-Frame-Options: DENY`) set by the host. GitHub Pages does not allow
custom response headers, so the published dashboard can be framed by other sites. The dashboard
has no forms, sign-in or actions to trick a user into, which keeps the impact low; a host with
custom headers would be needed to close it.

## Publishing on GitHub Pages

The dashboard is published at **https://larysak.github.io/AI-QA-AutomationFramework/** by
[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml). It is the same static,
read-only build as locally: the data is embedded at build time, the browser makes no requests,
and the CSP is unchanged.

### When it is deployed

- **Automatically**, after a run of the `CI history` workflow on `main` that composed **and
  published** a run record. That workflow runs after each CI run on `main` and, once its
  publication is approved, adds the run's record to `ci-history`; the redeploy then includes it.
  The `gate` job ([`reporting/ci/pages-gate.mjs`](../ci/pages-gate.mjs)) reads the triggering
  run's jobs (read-only) and requires both `Compose run record` and `Publish run record` to have
  succeeded.
  - A **product test failure** is recorded and published like any other CI run, so it **is**
    deployed: the dashboard then shows the failed run.
  - A **CI history run** that failed, was cancelled or skipped, or published nothing (publish
    skipped, for example because the record already exists) is **not** deployed. A publication
    that is awaiting approval has not completed, so the deployment waits for it; a rejected one
    fails that run.
  - If the gate cannot read the jobs, it fails the run instead of guessing.
- **Manually**, with _Run workflow_ on `main` (Actions → _Dashboard on GitHub Pages_), for
  example after a change that should be published without a new CI run. The workflow refuses
  any other branch.
- **Never** from pull requests, forks or other branches: there is no `pull_request` or `push`
  trigger, and every job checks the event, branch and repository.
- **Always the current `main`**: the build checks out `main` and stops unless its HEAD is still
  the commit the run was created for, so re-running an older run cannot deploy old code or an
  old workflow revision. Runs are serialized (concurrency group `pages`, a running deployment is
  never cancelled, and a newer waiting run replaces an older waiting one), and `deploy` deploys
  the artifact that `build` uploaded in the same run.

The workflow only reads `ci-history` and never writes it; publication stays the job of
`ci-history.yml` and its approval environment.

### What the deployment runs

| Job      | Permissions                       | Steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gate`   | `contents: read`, `actions: read` | Check out `main`; [`reporting/ci/pages-gate.mjs`](../ci/pages-gate.mjs) decides from the event file and the triggering CI history run's jobs; output `deploy`                                                                                                                                                                                                                                                                                                                                                                              |
| `build`  | `contents: read`, `actions: read` | Check out `main` (and stop if it has moved on since the run was created) and, separately and without credentials, the whole `ci-history` branch; the guard (no model credentials, no staged proposals); `npm run dashboard:data`; read-only reconciliation; `dashboard:history` with optional coverage; dashboard typecheck, lint and tests; the build with `DASHBOARD_REQUIRE_CI_HISTORY=1` and `DASHBOARD_BASE=/AI-QA-AutomationFramework/`; [`build/verify-site.ts`](build/verify-site.ts); upload with `actions/upload-pages-artifact` |
| `deploy` | `pages: write`, `id-token: write` | `actions/deploy-pages` only, in the `github-pages` environment                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

All actions are GitHub's own (`actions/*`), pinned to commit SHAs. No secret is used; the
workflow token reaches only the reconciliation's GET requests and the official actions.

### Base path and routing

- `DASHBOARD_BASE` sets Vite's `base`; unset, asset URLs stay relative (`./`), as before. Only a
  single path segment is accepted ([`build/site.ts`](build/site.ts)).
- Routes are in the URL hash (`#/test-cases/TC-003-07`), so every page, including a refreshed or
  directly opened nested route, is `index.html`; GitHub Pages needs no rewrite rules. Lazy
  route chunks are loaded from `assets/` under the base.
- With an absolute base the build also emits a static `404.html` (no script, the same CSP), which
  GitHub Pages serves for any unknown path below the site and which links back to the dashboard.

To check a Pages build locally:

```bash
npm run dashboard:data
npm run -s dashboard:history -- --history <checkout of ci-history>
DASHBOARD_BASE=/AI-QA-AutomationFramework/ DASHBOARD_REQUIRE_CI_HISTORY=1 \
  npm --prefix reporting/dashboard run build
npx tsx reporting/dashboard/build/verify-site.ts artifacts/dashboard-site /AI-QA-AutomationFramework/ --require-history
```

### Coverage and freshness

The reconciliation compares the published records with the CI runs the Actions API lists. Its
report is optional for the deployment (`--coverage-if-verified`):

- integrity verified and the runs listing complete: the coverage (published and unpublished
  eligible runs, "n of m") is included;
- integrity verified but the listing incomplete (the Actions API unavailable or rate-limited):
  coverage is _undetermined_; the page says _Coverage could not be determined_ and gives no
  "n of m" figure;
- the reconciliation failed (no report) or integrity only _unverified_: the dashboard is built
  without coverage and says _Coverage was not checked for this build_;
- integrity _failed_: the export refuses, and nothing is deployed.

Nothing is estimated in any case.

The Executions page names the `ci-history` commit and its time, so the age of the data is always
visible; the site does not update between deployments.

### One-time repository settings

1. _Settings → Pages → Build and deployment → Source_: **GitHub Actions**.
2. _Settings → Environments → github-pages_ (created by the first deployment, or beforehand):
   _Deployment branches and tags_ limited to **main**. Required reviewers are optional; the data
   is already reviewed through the `ci-history` approval.
3. The `CI history` workflow keeps its own `ci-history` environment and permissions; nothing
   changes there.

### Failure modes and recovery

| Failure                                                                                                       | Effect                                                                                                                                  | Recovery                                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ci-history` invalid or its immutability audit fails                                                          | Export refuses; nothing deployed; the previous site stays online                                                                        | Investigate with `reconcile-cli.ts`; records are never repaired by the deployment |
| Reconciliation reports an integrity failure                                                                   | Export refuses; nothing deployed                                                                                                        | As above                                                                          |
| Actions API unavailable or rate-limited                                                                       | Deployed with coverage _undetermined_ (no "n of m" figure), or without coverage if the reconciliation itself failed; stated on the page | Run the workflow again later                                                      |
| Dashboard tests, the build (data validation, safety scan, agent layer evidence) or the site verification fail | Nothing uploaded or deployed                                                                                                            | Fix on `main`; the next CI history run, or a manual run, deploys                  |
| CI history publication rejected, failed, cancelled or skipped, or nothing new published                       | The gate decides not to deploy                                                                                                          | Run the workflow manually if the code change should be published                  |
| The gate cannot read the triggering run's jobs                                                                | The run fails; nothing deployed                                                                                                         | Re-run the gate, or run the workflow manually                                     |
| `main` moved on after the run was created (or an older run was re-run)                                        | Build stops before anything is built                                                                                                    | None needed: the run for the newer commit deploys it                              |
| Deployment step fails                                                                                         | The previous site stays online                                                                                                          | Re-run the failed jobs                                                            |

A deployment replaces the whole site, so a broken deployment is undone by deploying a good
commit again: fix or revert on `main`, then run the workflow manually (re-running an older run is
refused once `main` has moved on).
