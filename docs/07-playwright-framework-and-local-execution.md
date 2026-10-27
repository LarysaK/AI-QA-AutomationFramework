# G. Playwright Automation Framework and Local Execution Guide

## Structure

| Path                                                                                                  | Contents                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`playwright.config.ts`](../playwright.config.ts)                                                     | Runtime configuration: test directory, reporters, `webServer`, `globalSetup`, project `chromium`                                                                                      |
| [`tests/requestflow/api/`](../tests/requestflow/api/)                                                 | API tests (CAN-002, CAN-003)                                                                                                                                                          |
| [`tests/requestflow/ui/`](../tests/requestflow/ui/)                                                   | UI tests (CAN-001)                                                                                                                                                                    |
| [`tests/requestflow/e2e/`](../tests/requestflow/e2e/)                                                 | Cross-role E2E workflows (CAN-004, CAN-005)                                                                                                                                           |
| [`apps/requestflow/pages/`](../apps/requestflow/pages/)                                               | Page objects: login, My requests, request form, request details, review queue                                                                                                         |
| [`apps/requestflow/api/requestflow-api.client.ts`](../apps/requestflow/api/requestflow-api.client.ts) | A thin typed client over the JSON API                                                                                                                                                 |
| [`apps/requestflow/data/demo-users.ts`](../apps/requestflow/data/demo-users.ts)                       | The three demo users                                                                                                                                                                  |
| [`apps/requestflow/global-setup.ts`](../apps/requestflow/global-setup.ts)                             | Resets the AUT once per run                                                                                                                                                           |
| [`framework/`](../framework/)                                                                         | **Planned** shared runtime (fixtures, base classes, config, data, API). At the audit commit it holds only `.gitkeep` placeholders; tests use Playwright's built-in fixtures directly. |

## Suite at the audit commit (verified)

| File                                                                                                  |            Tests | Test cases                                 | Canonical |
| ----------------------------------------------------------------------------------------------------- | ---------------: | ------------------------------------------ | --------- |
| [`api/create-request-validation.spec.ts`](../tests/requestflow/api/create-request-validation.spec.ts) | 24 (data-driven) | TC-001-02 – TC-001-12                      | CAN-002   |
| [`api/edit-draft-request.spec.ts`](../tests/requestflow/api/edit-draft-request.spec.ts)               |                3 | TC-002-02, TC-002-04, TC-002-10            | CAN-003   |
| [`ui/create-request.spec.ts`](../tests/requestflow/ui/create-request.spec.ts)                         |                1 | TC-001-17                                  | CAN-001   |
| [`e2e/approve-request.spec.ts`](../tests/requestflow/e2e/approve-request.spec.ts)                     |                1 | TC-003-08, TC-004-08, TC-005-08, TC-008-08 | CAN-004   |
| [`e2e/reject-request.spec.ts`](../tests/requestflow/e2e/reject-request.spec.ts)                       |                1 | TC-006-11, TC-006-12, TC-008-08            | CAN-005   |
| **Total**                                                                                             |           **30** | **21 linked**                              | 5         |

All 30 passed, first attempt, in published CI run
[#23](https://github.com/LarysaK/AI-QA-AutomationFramework/actions/runs/40497439668) at the audit
commit. The full per-test listing is in the [coverage matrix](05-automation-coverage-matrix.md#committed-playwright-tests-and-the-test-cases-they-carry).

## Patterns

- **Tags carry traceability.** `test.describe` and `test` use Playwright tags: `@REQ-…`,
  `@TC-…`, and `@CAN-…` for reference tests. AI origin is never recorded in test code
  (Agent Standard STD-TRC-003).
- **API tests** create their own data through `RequestFlowApi`, assert status and `error.code`,
  and read the request back to prove persistence or atomicity (CAN-002, CAN-003).
- **UI tests** use semantic locators (`getByRole`, `getByLabel`) through page objects and assert
  visible business values (CAN-001).
- **E2E tests** use one browser context per user, so Alex and Jordan are logged in at the same
  time with separate cookies, and finish with an API check of the persisted state (CAN-004,
  CAN-005). Shared lists (the review queue) are searched by a unique, random title.
- **Data-driven tests** generate one Playwright test per data row from a table (CAN-002), so each
  boundary is reported separately.

## Running locally

```bash
npm install
npx playwright install chromium
npm test                                   # starts RequestFlow, runs everything headless
npm run test:headed                        # the same, in a visible browser
npx playwright test --grep @CAN-004        # one canonical pattern
npx playwright test --grep @REQ-006        # everything traced to a requirement
npx playwright test --grep @TC-001-10      # one test case (all its data rows)
npx playwright test --list                 # discovery only: 30 tests in 5 files
```

What `npm test` does (verified in [`playwright.config.ts`](../playwright.config.ts) and
[`global-setup.ts`](../apps/requestflow/global-setup.ts)):

1. starts RequestFlow through Playwright's `webServer` (`npm run aut:start`) with
   `REQUESTFLOW_TEST_HOOKS=1`;
2. waits for `GET /health`;
3. resets the in-memory state once with `POST /__test/reset`;
4. runs the tests fully in parallel (2 workers and 1 retry when `CI` is set);
5. stops the server.

Outside CI an already running server is reused; it must have been started with
`REQUESTFLOW_TEST_HOOKS=1`, otherwise `globalSetup` stops the run with an explanatory error.

## Outputs (all gitignored, under `artifacts/`)

| Output                                         | Path                             |
| ---------------------------------------------- | -------------------------------- |
| HTML report                                    | `artifacts/playwright-report/`   |
| JSON results                                   | `artifacts/results/results.json` |
| Traces, screenshots and videos of failed tests | `artifacts/test-results/`        |

Local results are never published as CI evidence and are not used by the dashboard.

## Quality gates

```bash
npm run typecheck      # TypeScript strict mode
npm run lint           # ESLint, including the Playwright plugin and the ADR-0001 import boundary
npm run format:check   # Prettier
```

The ESLint configuration forbids runtime code (`framework/`, `apps/`, `tests/`,
`playwright.config.ts`) from importing `agents/**` or the LLM SDK.

## Adding a test

See [C, "How a new automated test is added"](03-test-strategy-and-plan.md#how-a-new-automated-test-is-added-process).
Pick the canonical pattern the [catalog](04-test-case-catalog.md) recommends, tag the test, and
never add a `@CAN-…` tag.
