# N. Portfolio Demonstration and Interview Guide

A guide for presenting the project honestly: what to show, what to say, and the evidence behind
each claim. Everything marked as a fact here is verified at the audit commit `7624640`.

## The one-minute summary

> RequestFlow QA is a TypeScript and Playwright framework for a small multi-role approval
> application I built as the system under test. The behaviour comes from a frozen requirements
> baseline and a hand-written test plan of 96 traceable test cases. Five canonical reference
> tests (30 Playwright tests over API, UI and E2E) are automated and pass in CI, and every result
> is published, with human approval, to an immutable history branch that a read-only dashboard
> visualizes. On top sits an AI agent layer designed so that AI can only _propose_ tests:
> deterministic guards validate every proposal and a human approves it. The Generator agent is
> implemented and demonstrated offline; no live model has run yet, by design.

## Demonstration script (about 15 minutes)

1. **Requirements and plan** (2 min). Open [REQ-003](../specs/requestflow/requirements.md#req-003--submit-a-request)
   and its rows in the [test plan](../specs/requestflow/test-plan.md#req-003--submit-a-request).
   Point out exact status codes, error codes and the error precedence 401 → 403 → 404 → 409 → 400.
2. **Traceability** (2 min). Show the `@REQ-…`, `@TC-…`, `@CAN-…` tags in
   [`approve-request.spec.ts`](../tests/requestflow/e2e/approve-request.spec.ts) and run
   `npx playwright test --grep @CAN-004`.
3. **A real run** (3 min). `npm test`: Playwright starts RequestFlow, resets it once, runs 55 tests.
   Open the HTML report in `artifacts/playwright-report/`.
4. **Patterns** (3 min). Data-driven boundaries in
   [`create-request-validation.spec.ts`](../tests/requestflow/api/create-request-validation.spec.ts);
   atomicity read-back in [`edit-draft-request.spec.ts`](../tests/requestflow/api/edit-draft-request.spec.ts);
   two browser contexts in the E2E tests; one API session per user and the replayed-cookie check
   in [`demo-authentication.spec.ts`](../tests/requestflow/api/demo-authentication.spec.ts).
5. **CI evidence** (2 min). The `ci-history` branch: one immutable record per run, published only
   after approval; run #23 tested `7624640` and all 30 tests then committed passed. The M10B API
   tests have no published CI result until their first run on `main`.
6. **AI guardrails** (3 min). [Agent Standard §8](../agents/standard/standard.md#8-human-approval-gates)
   gates H1–H7; the validator's seven guards; why H7 is closed; the ESLint boundary that keeps
   AI out of the test runtime.

Show the live dashboard at <https://larysak.github.io/AI-QA-AutomationFramework/> (published by
the Pages workflow after each published CI record; owner-confirmed): Overview, Executions (the
published runs and their coverage) and AI Agents (H7 closed, what is not recorded).

## Talking points with evidence

| Claim                                                 | Evidence                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Requirements-based, not implementation-based, testing | Requirements v1.2 frozen; plan §1; Agent Standard §3                                          |
| API-heavy pyramid on purpose                          | 82 API, 11 UI, 3 E2E test cases (plan §7.2)                                                   |
| Atomicity is verified, not assumed                    | CAN-003 reads the request back after a failed `PATCH`                                         |
| Deterministic parallel tests                          | Unique data per test, one reset per run, `fullyParallel: true`                                |
| Honest coverage                                       | 33 of 96 linked by tags, all consistent; P0 14 of 38 ([E](05-automation-coverage-matrix.md))  |
| Tamper-evident CI history                             | Immutability audit and read-only reconciliation ([J](10-ci-cd-history-and-reconciliation.md)) |
| AI cannot change the repository by itself             | STD-AUTH-001, Protected paths, H2, H7 ([I](09-ai-agent-architecture-and-guardrails.md))       |
| No secrets in CI or tests                             | The CI guard step; synthetic demo users; public-safety scans                                  |

## Questions to expect, and honest answers

**"How much is automated?"** 33 of 96 test cases are automated and consistent with their
scenarios (P0: 14 of 38); 2 are manual by design and 61 are planned. The five canonical tests were
written first, as patterns; a small, risk-based set of authentication, authorization and
list-ownership API tests followed. TC-002-02, whose test once patched a different field than its
scenario names, was corrected under an owner-approved exception for the canonical test.

**"Has the AI generated any of your tests?"** No. All 30 committed tests are hand-written. The
Generator has only been demonstrated offline, with a hand-written fixture in place of model
output; no live model call has been made.

**"What is H7?"** The human execution authorization: no validator guard that imports or runs
proposed code may run until a human authorizes that exact artifact by its SHA-256. It is closed;
nothing is authorized, and CI never authorizes anything.

**"Why not let AI heal failing tests at runtime?"** It could hide genuine regressions behind
passing tests; ADR-0001 keeps AI before or after execution, never inside it.

**"Why are some tests manual?"** Two empty-list scenarios need isolated state, which the shared
in-memory server cannot guarantee under parallel runs (plan §6).

**"What would you do next?"** Automate the remaining P0 cases (for example TC-001-01, TC-001-15,
TC-002-07 – TC-002-09, TC-008-03), triage the unparsable-JSON observation (finding 10 in
[M](13-limitations-risks-and-roadmap.md)), and make first, reviewed live Planner, Generator and
Healer runs.

## Do not claim

- Live AI execution, AI-generated tests, AI usage metrics, approval events or autonomous changes.
- Real defect records or a defect rate.
- Manual test execution results.
- That the dashboard updates live: it is a static build, refreshed only by a new deployment.
- That the Planner or the Healer has run live, repaired a test or resolved a defect (both are
  offline-only).
- Full requirement coverage, or full coverage of REQ-007, REQ-009 or REQ-010 (some of their cases
  remain unautomated).
- That the M10B tests passed in published CI before their first run on `main`.
