# H. Test Data, Environments and Configuration

## Test data

| Data            | Source                                                                                                                                            | Notes                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo users      | [Requirements v1.2, Demo users](../specs/requestflow/requirements.md#demo-users); code: [`demo-users.ts`](../apps/requestflow/data/demo-users.ts) | `emp-alex` Alex Morgan (EMPLOYEE), `emp-sam` Sam Rivera (EMPLOYEE), `rev-jordan` Jordan Lee (REVIEWER). Synthetic; no passwords.                                                         |
| Requests        | Created by each test through the API                                                                                                              | Unique titles where tests share a list (the review queue). Preconditions for SUBMITTED, APPROVED and REJECTED are prepared through the API unless the UI flow is under test (plan §1.4). |
| Boundary values | Test plan rows of REQ-001, REQ-002 and REQ-006                                                                                                    | For example title 1/100/101 characters, amount `0.01`/`100000`/`100000.01`/`10.123`, comment 1/500/501 characters.                                                                       |

No production data, personal data or secrets are used anywhere in the test data.

## Application state

- RequestFlow keeps all data **in memory** ([`memory-store.ts`](../apps/requestflow/app/src/store/memory-store.ts)).
  A restart starts empty; request IDs are sequential (`req-0001`, …).
- Automated runs reset the state **once per run** in `globalSetup` through
  `POST /__test/reset`. That route exists only when the server is started with
  `REQUESTFLOW_TEST_HOOKS=1` ([`test-routes.ts`](../apps/requestflow/app/src/http/test-routes.ts));
  otherwise it returns `404`.
- All tests share one server and run in parallel, so no test may rely on an exactly empty list.
  That is why TC-004-07 and TC-009-05 are manual by design (plan §6).

## Environments

| Environment      | How                                            | Purpose                                                                                         |
| ---------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Local, manual    | `npm run aut:start`                            | Exploration and manual testing; no test hooks                                                   |
| Local, automated | `npm test`                                     | Playwright starts its own server with test hooks                                                |
| CI               | GitHub Actions `CI` workflow on `ubuntu-24.04` | The same Playwright run, plus all other checks; see [J](10-ci-cd-history-and-reconciliation.md) |

There is no shared staging or production environment: RequestFlow is a local demonstration AUT.

## Configuration

| Variable                       | Where                  | Default                 | Effect                                                                                                            |
| ------------------------------ | ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `HOST`                         | RequestFlow            | `127.0.0.1`             | Listen address                                                                                                    |
| `PORT`                         | RequestFlow            | `3100`                  | Listen port (1–65535)                                                                                             |
| `REQUESTFLOW_TEST_HOOKS`       | RequestFlow            | unset                   | `1` enables `POST /__test/reset`; automated tests only                                                            |
| `BASE_URL`                     | Playwright, via `.env` | `http://127.0.0.1:3100` | Where Playwright finds RequestFlow                                                                                |
| `CI`                           | Playwright             | unset                   | `forbidOnly`, 1 retry, 2 workers, no server reuse                                                                 |
| `DASHBOARD_REQUIRE_CI_HISTORY` | Dashboard build        | unset                   | `1` fails the build without a CI history export                                                                   |
| `DASHBOARD_BASE`               | Dashboard build        | `./`                    | Site base path; the Pages workflow sets `/AI-QA-AutomationFramework/` (see [K](11-dashboard-and-github-pages.md)) |

`.env` is gitignored and created from [`.env.example`](../.env.example), which only contains
`BASE_URL`. Never commit credentials.

Model credentials are **not configuration of this project**. The CI workflow fails if
`ANTHROPIC_API_KEY` is set, and the test runtime never reads one (see
[I](09-ai-agent-architecture-and-guardrails.md)).

## Tool versions

| Tool       | Requirement                                                                                                                                                     | Evidence                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | `.nvmrc` says `22`. Root `engines`: `^20.19.0 \|\| ^22.13.0 \|\| >=24`. Dashboard `engines`: `^22.22.2 \|\| ^24.15.0 \|\| >=26`; CI enforces Node `>= 22.22.2`. | [`.nvmrc`](../.nvmrc), [`package.json`](../package.json), [`reporting/dashboard/package.json`](../reporting/dashboard/package.json), [`ci.yml`](../.github/workflows/ci.yml) |
| Playwright | `@playwright/test ^1.55.0`; 1.63.0 installed and used in CI run #23                                                                                             | [`package.json`](../package.json), CI record                                                                                                                                 |
| Browser    | Chromium (`npx playwright install chromium`)                                                                                                                    | [`playwright.config.ts`](../playwright.config.ts)                                                                                                                            |

**Limitation:** the root `engines` range allows Node 20 and early 22, but the dashboard and CI
require Node `>= 22.22.2`. Use Node 22.22.2 or later for the full toolchain.
