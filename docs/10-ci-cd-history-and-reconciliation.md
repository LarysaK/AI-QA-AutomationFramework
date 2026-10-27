# J. CI/CD, History Publication and Reconciliation

Three workflows exist on `main` at the audit commit:
[`ci.yml`](../.github/workflows/ci.yml) (**CI**),
[`ci-history.yml`](../.github/workflows/ci-history.yml) (**CI history**) and
[`pages.yml`](../.github/workflows/pages.yml) (**Dashboard on GitHub Pages**, see
[K](11-dashboard-and-github-pages.md)). They run as a chain: CI → CI history → Pages.
All actions are pinned to full commit SHAs; top-level permissions are `{}`.

## CI (`ci.yml`)

**Triggers:** `push` to `main`, `pull_request` to `main`, `workflow_dispatch`. **Permissions:**
`contents: read`. One job, **Verify**, on `ubuntu-24.04`.

| Step                                              | What it checks                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Guard (no model credentials, no staged proposals) | Fails if `ANTHROPIC_API_KEY` is set or `artifacts/proposals` exists                            |
| Generate dashboard snapshot                       | `npm run dashboard:data`: the validated snapshot of the committed specs and tests              |
| Typecheck, Lint, Format check                     | Root quality gates                                                                             |
| Agent validation and generator tests              | `npm run agents:test` (fake model; no model calls)                                             |
| Dashboard data tests, CI run record tests         | `dashboard:test`, `ci:test`                                                                    |
| Dashboard typecheck, lint, tests, build           | The QA Dashboard                                                                               |
| Playwright tests                                  | `npm test`: the RequestFlow suite                                                              |
| Collect suite results                             | Machine-readable results of every suite (always runs)                                          |
| Stage and upload snapshot and suite results       | Only for `push` or `workflow_dispatch` on `main`: two raw JSON hand-off artifacts, kept 7 days |

Pull-request runs never upload anything and never lead to a published record.

## CI history (`ci-history.yml`)

Publishes one immutable **run record** per eligible CI run to the orphan branch **`ci-history`**.

- **Trigger:** `workflow_run` of `CI` (completed, `main`). It runs the trusted default-branch
  workflow; artifacts of the triggering run are data, never executed.
- **Job `compose`** (`contents: read`, `actions: read`): downloads the two hand-off artifacts by
  ID without extracting archives, verifies name, size, SHA-256 and UTF-8, composes the record,
  validates it fully against the ci-run 1.0 schema and the current history, and hands over at
  most 64 KiB.
- **Job `publish`** (`contents: write` only): runs only when compose plans a new record and
  **waits for human approval of the `ci-history` environment**. It installs nothing and runs only
  [`publish.mjs`](../reporting/ci/publish.mjs), which re-validates everything and pushes exactly
  one commit (one record and the index) to `refs/heads/ci-history`, never forced.
- Pull requests, forks, other branches and other repositories are refused by both job conditions
  and again in code.

**Published history (verified, read-only checkout):** `ci-history` at
`2f7cdd4e03b042101596e71ad641d6bc5593f8a8` holds **5 records**:

| CI run | Commit                   | Conclusion | Suites                                                                 | Playwright results |
| ------ | ------------------------ | ---------- | ---------------------------------------------------------------------- | ------------------ |
| #15    | `55b9e7a`                | success    | 4 passed                                                               | 30 passed          |
| #17    | `3c33bee`                | success    | 4 passed                                                               | 30 passed          |
| #19    | `75ff577`                | success    | 4 passed                                                               | 30 passed          |
| #21    | `a3610d1`                | success    | 4 passed (agents 176, dashboard data 60, dashboard 142, Playwright 30) | 30 passed          |
| #23    | `7624640` (audit commit) | success    | 4 passed (agents 176, dashboard data 60, dashboard 158, Playwright 30) | 30 passed          |

A record states what one CI job reported for one commit. It is not a per-test-case verdict, and a
run without a record is not a failed run.

## Reconciliation

[`reconcile-cli.ts`](../reporting/ci/reconcile-cli.ts) compares the history with the CI runs the
GitHub Actions API lists, **read-only** (GET requests only):

```bash
npx tsx reporting/ci/reconcile-cli.ts --history <checkout of ci-history> [--format markdown]
```

It verifies every record and audits the branch's git log (the root commit holds only the
README; every later commit is a publisher commit adding exactly one record and the index), then
classifies each eligible run attempt as `published`, `inconsistent`, or one of the
`unpublished-…` reasons.

| Verdict   | Values                               | Exit code                                                                  |
| --------- | ------------------------------------ | -------------------------------------------------------------------------- |
| integrity | `verified` / `failed` / `unverified` | `1` if failed                                                              |
| coverage  | `complete` / `gaps` / `undetermined` | `2` if unverified, gaps or undetermined; `0` only if verified and complete |

**Result when this audit ran (2026-10-27, `ci-history` at `2f7cdd4`):** integrity **verified**,
immutability verified; the API listed **12** CI runs on `main`; **5 published**, **7
unpublished** (runs #2, #4, #6, #7 and #9 with no hand-off artifact listed, #11 with only
legacy artifacts, #13 with artifacts retained). All seven ran **before the publisher existed**;
records are never backfilled. Coverage verdict: **gaps** (exit code 2, a known, documented state).

## History export for the dashboard

[`history-export-cli.ts`](../reporting/ci/history-export-cli.ts)
(`npm run dashboard:history -- --history <checkout> [--reconciliation <report>]`) writes
`artifacts/dashboard/ci-history.json` only if the history passes full verification and the
immutability audit from a clean checkout, and accepts a reconciliation report only for the same
commit with integrity verified.

## Failure modes

| Situation                             | Effect                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A CI check fails on `main`            | The run fails; its record (with the failure) is still composed and, once approved, published              |
| Hand-off artifacts missing or invalid | Compose refuses; no record; reconciliation shows the run as unpublished                                   |
| Publication not approved              | No record; the run appears as unpublished                                                                 |
| Concurrent publication                | `publish.mjs` refetches and tries again on a non-fast-forward, at most 3 attempts in total, never forcing |
| History tampered with                 | Verification, the immutability audit and reconciliation fail; the export refuses                          |
