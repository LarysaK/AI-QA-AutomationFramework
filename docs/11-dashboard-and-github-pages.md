# K. Dashboard and GitHub Pages

## The QA Dashboard (implemented)

[`reporting/dashboard/`](../reporting/dashboard/) is a read-only React site built with Vite.
All data is embedded **at build time** after validation; the browser makes no requests
(`connect-src 'none'`), and there is no backend. Details:
[Dashboard README](../reporting/dashboard/README.md).

### Views (verified in [`Layout.tsx`](../reporting/dashboard/src/components/Layout.tsx))

| View                       | Shows                                                                                          | Source                    |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------- |
| Overview                   | Key figures, linkage by requirement, latest execution results, coverage                        | Snapshot, CI history      |
| Test Plan                  | The approved test plan, rendered                                                               | Snapshot                  |
| Test Cases                 | All 96 test cases with filters; per test case its linked tests and, when available, CI results | Snapshot, CI history      |
| Executions                 | Published CI runs, per-run details, coverage of CI runs                                        | CI history export         |
| AI Agents                  | The agent layer: components, guards, gates H1–H7, H7 closed, what is not recorded              | Evidence-checked register |
| Defects                    | An intentional empty state: no defect register is connected                                    | —                         |
| How to read this dashboard | Definitions, provenance, what is deliberately not shown                                        | All                       |

There is no separate _Requirements_ view: requirements and their linkage appear on the Overview
and in each test case's details.

### Build-time inputs and checks

1. **Snapshot** (`npm run dashboard:data`): requirements, test plan and test cases from the
   committed specs, test instances from Playwright discovery. Built only when the discovery
   inputs are committed and unmodified; validated against its JSON Schema and a public-safety
   scan (no local paths, credentials or e-mail addresses).
2. **CI history export** (optional): see [J](10-ci-cd-history-and-reconciliation.md#history-export-for-the-dashboard).
   `DASHBOARD_REQUIRE_CI_HISTORY=1` makes a missing export fail the build.
3. **Agent layer facts**: every statement on the AI Agents page carries evidence in committed
   files (a quotation, an absent path, a tracked file or an excluded text) and is checked at
   build time against HEAD; any drift fails the build.

Measures are kept apart on purpose: _planned_ (a test case exists), _automation intent_ (the
plan's column), _linked_ (a committed test carries the tag) and _executed in CI_ (a published
record for the snapshot's commit). A link is traceability, not proof of full coverage.

### Building locally

```bash
npm run dashboard:data
npm --prefix reporting/dashboard ci
npm --prefix reporting/dashboard run build          # artifacts/dashboard-site/
```

## GitHub Pages deployment

**Public URL: <https://larysak.github.io/AI-QA-AutomationFramework/>**

### Status

| Statement                                                                                                                                                                                                                                           | Basis                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The deployment is implemented in [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) and merged into `main` (pull request #11, merge commit `7624640`)                                                                                  | Repository (verified)                                                         |
| GitHub Pages is enabled and the Dashboard is publicly accessible and working                                                                                                                                                                        | **Confirmation by the project owner**                                         |
| The first Pages run (run #1, ID `40498611050`, 2026-10-27) was started automatically by `workflow_run` after CI history run `40498254204` for `7624640`; its jobs _Check the trigger_, _Build dashboard_ and _Deploy to GitHub Pages_ all succeeded | GitHub Actions API, read-only (observed during this audit)                    |
| The public page answers `200`, carries the exact Content-Security-Policy and loads its assets from `/AI-QA-AutomationFramework/assets/`; an unknown path answers `404`                                                                              | Read-only HTTP requests (observed during this audit)                          |
| The deployed bundle embeds the CI history export of `ci-history` at `2f7cdd4` (5 records, including run #23 for `7624640`) and agent-layer facts checked at `7624640`                                                                               | Read-only inspection of the published JavaScript (observed during this audit) |

**Not yet independently verified:** a second automatic refresh after a later publication; the
"nothing new published" and "main has moved on" refusal paths in production; and the
repository's Pages and `github-pages` environment settings, which the public API does not
show. The workflow's tests cover these paths offline.

### How a deployment happens

| Job                                 | Permissions                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate` (_Check the trigger_)        | `contents: read`, `actions: read`      | [`pages-gate.mjs`](../reporting/ci/pages-gate.mjs) reads the trusted event file and, for an automatic run, the triggering CI history run's jobs (read-only API). It outputs `deploy=true` only for a manual dispatch on `main`, or for a successful CI history run on `main` of this repository, not from a fork, triggered by CI, in which both _Compose run record_ **and** _Publish run record_ succeeded. A run that failed, was cancelled or skipped, or published nothing is not deployed; unreadable jobs fail the run.                                                                       |
| `build` (_Build dashboard_)         | `contents: read`, `actions: read`      | Checks out `main` and **stops unless its HEAD is still the run's commit** (no stale or re-run deployments); checks out the whole `ci-history` branch separately, read-only and without credentials; the same model-credential and proposal guard as CI; `dashboard:data`; read-only reconciliation; `dashboard:history --coverage-if-verified`; dashboard typecheck, lint and tests; the build with `DASHBOARD_REQUIRE_CI_HISTORY=1` and `DASHBOARD_BASE=/AI-QA-AutomationFramework/`; [`verify-site.ts`](../reporting/dashboard/build/verify-site.ts); upload with `actions/upload-pages-artifact`. |
| `deploy` (_Deploy to GitHub Pages_) | `pages: write`, `id-token: write` only | Runs only `actions/deploy-pages`, in the `github-pages` environment, deploying the artifact uploaded by `build` in the same run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

- **Triggers:** `workflow_run` of _CI history_ (completed, `main`) and `workflow_dispatch`. There
  is no `push` or `pull_request` trigger, so pull requests and forks cannot deploy; every job
  checks the repository, `refs/heads/main` and the event again.
- **Concurrency:** group `pages`, `cancel-in-progress: false`: one deployment at a time, a
  running one is never cancelled, and a newer waiting run replaces an older waiting one.
- **Actions:** GitHub's own only, pinned to commit SHAs. No secrets; the workflow token reaches
  only the gate's and the reconciliation's GET requests and the official actions.
- **Separation:** the workflow only reads `ci-history`; publication stays with
  `ci-history.yml` and its approval environment, which this workflow does not use or change.

### Build-time validation and CI history integration

- The CI history must pass full verification and the immutability audit; a missing export fails
  the build (`DASHBOARD_REQUIRE_CI_HISTORY=1`).
- Coverage is optional: a verified reconciliation adds it; an incomplete Actions listing shows
  coverage as _undetermined_ without an "n of m" figure; no report or an unverified one means
  "Coverage was not checked"; an integrity failure stops the deployment.
- `verify-site.ts` checks the exact CSP and no inline script on `index.html` and `404.html`, that
  every script, stylesheet and lazy chunk resolves under the subpath (also from deep 404 paths),
  that nothing loads from another origin, that the CI history is embedded, and that no file
  contains a local path.

### Repository settings the workflow relies on

1. _Settings → Pages → Source_: **GitHub Actions**.
2. _Settings → Environments → `github-pages`_: deployment branches limited to **main**.

The owner's confirmation and the successful first run indicate that the Pages source is set;
the environment's branch rule is not visible through the public API and was not verified here.

### Failure behaviour

| Situation                                                            | Effect                                            |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| CI history run failed, cancelled, skipped or published nothing       | The gate does not deploy                          |
| The gate cannot read the jobs                                        | The run fails; nothing is deployed                |
| `main` moved on after the run was created, or an older run is re-run | Build stops; the run for the newer commit deploys |
| History invalid, or reconciliation integrity failed                  | Export refuses; nothing is deployed               |
| Dashboard tests, build or site verification fail                     | Nothing is uploaded or deployed                   |
| Deployment fails                                                     | The previously deployed site stays online         |

In every failure case the last successful deployment stays online, so the public data can be
older than the newest record; the Executions page always names the `ci-history` commit and time
it shows. Full procedure, recovery and local reproduction:
[Dashboard README, Publishing on GitHub Pages](../reporting/dashboard/README.md#publishing-on-github-pages).

**Limitation:** GitHub Pages cannot send HTTP headers such as `frame-ancestors`, so the site can
be framed by other sites; the dashboard has no forms or actions, which keeps the impact low.
