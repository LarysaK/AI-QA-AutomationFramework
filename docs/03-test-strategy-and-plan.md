# C. Test Strategy and Test Plan

The approved, human-written test design is
[RequestFlow Test Plan v1](../specs/requestflow/test-plan.md). It derives every scenario from the
frozen requirements and does not add, change or interpret business rules. This document explains
how it is organized and how it is applied; the plan itself remains the authority.

## Principles (plan §1.1)

1. **API tests carry detailed coverage**: validation, boundaries, authorization, ownership,
   state transitions and the API contract.
2. **UI tests verify the user's view**: interaction, forms, navigation, visible validation
   feedback, and which actions are offered per role and status.
3. **E2E tests cover only the important cross-role workflows**, from UI action to final API
   state.
4. **The validation matrix is not repeated through the UI**: one representative validation
   scenario per form.
5. **Hiding a control in the UI is not proof of authorization**: every authorization rule is
   verified through the API.
6. **Failed operations must not partially modify a request**: negative scenarios on an existing
   request also check, through `GET /api/requests/:id`, that it is unchanged.
7. **Tests are independent and create their own data** through the API.

## Levels (plan §1.2)

| Level | Interface                                    | Typical assertions                            | Test cases |
| ----- | -------------------------------------------- | --------------------------------------------- | ---------: |
| API   | JSON API with a session cookie per demo user | status code, `error.code`, body, stored state |         82 |
| UI    | Server-rendered pages in a browser           | visible values, feedback, offered controls    |         11 |
| E2E   | Several browser contexts, then the API       | cross-role workflow and final state           |          3 |

## Assertion rules (plan §1.3)

- Errors: assert HTTP status and `error.code`; never `error.message`.
- `amount` is compared as a number, never as formatted text.
- `updatedAt` "changes" means strictly later than before; `createdAt` "unchanged" means equal to
  the creation value.
- Lists: assert inclusion, exclusion and relative order of the test's own requests, not exact
  contents.
- UI: accessible roles, labels and visible text; layout is not part of the requirements.

## Priorities (plan §1.5)

| Priority | Meaning                                                                             | Test cases |              Automated |
| -------- | ----------------------------------------------------------------------------------- | ---------: | ---------------------: |
| P0       | Core workflow, authentication or authorization; a failure blocks release of the AUT |         38 |                      4 |
| P1       | Validation, boundaries, state-transition errors and atomicity                       |         50 | 16 (+1 to investigate) |
| P2       | Contract details, ordering and low-risk edge cases                                  |          8 |                      0 |

## Test design techniques used

- **Equivalence partitioning and boundary values** for title, description, amount and the
  rejection comment (for example TC-001-04/05, TC-001-09/10, TC-006-04/05).
- **Data-driven scenarios**: one test case over several data rows, marked _(data-driven)_ in the
  plan; CAN-002 implements this as one Playwright test per row.
- **State-transition testing** over `DRAFT → SUBMITTED → APPROVED/REJECTED`, including invalid
  and terminal transitions (`409`).
- **Role and ownership matrix** (plan §7.1) for authorization and visibility.
- **Error-precedence testing** (TC-007-01 – TC-007-05).
- **Atomicity checks**: every failed operation is followed by a read-back.

## Canonical reference tests (plan §3)

Five hand-written reference tests, each fixing a pattern for later tests (and for the Generator
agent's context). They are **not the complete automated suite**.

| ID      | Pattern                                                    | Level | Covers                                     | Test                                                                                                  |
| ------- | ---------------------------------------------------------- | ----- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| CAN-001 | Form interaction, semantic locators, initial `DRAFT`       | UI    | TC-001-17                                  | [`ui/create-request.spec.ts`](../tests/requestflow/ui/create-request.spec.ts)                         |
| CAN-002 | Data-driven validation boundaries                          | API   | TC-001-02, TC-001-03 – TC-001-12           | [`api/create-request-validation.spec.ts`](../tests/requestflow/api/create-request-validation.spec.ts) |
| CAN-003 | Partial update, state preservation, atomic failure         | API   | TC-002-02, TC-002-04, TC-002-10            | [`api/edit-draft-request.spec.ts`](../tests/requestflow/api/edit-draft-request.spec.ts)               |
| CAN-004 | Multi-role approval workflow, one browser context per user | E2E   | TC-003-08, TC-004-08, TC-005-08, TC-008-08 | [`e2e/approve-request.spec.ts`](../tests/requestflow/e2e/approve-request.spec.ts)                     |
| CAN-005 | Terminal rejection with review validation                  | E2E   | TC-006-11, TC-006-12, TC-008-08            | [`e2e/reject-request.spec.ts`](../tests/requestflow/e2e/reject-request.spec.ts)                       |

## Scope

**Out of scope (plan §4):** concurrent review or modification; production authentication,
passwords, OAuth, SSO, JWT and multi-role users; behaviour not defined by Requirements v1.2 (login
with an unknown user ID, logout without a session, payloads sent to `/submit`, `error.message`
wording, UI layout and styling, HTML error pages).

## Entry and exit criteria (plan §5)

- **Entry:** RequestFlow starts with `npm run aut:start` and `GET /health` returns `200`.
- **Exit for the canonical baseline:** CAN-001 – CAN-005 automated and passing; **all other P0
  scenarios either automated or explicitly scheduled.**

**Status against the exit criteria (verified):** CAN-001 – CAN-005 are automated and passed in
CI run #23. Of the 38 P0 test cases, 4 are automated; the other **34 P0 test cases are neither
automated nor scheduled** anywhere in the repository. The second exit criterion is therefore not
met at the audit commit.

## Known limitation of the plan (plan §6)

TC-004-07 (empty review queue) and TC-009-05 (empty own-request list) need a server state with no
matching requests. All tests share one in-memory server and run in parallel, so this is not
deterministic. They are **manual by design** until isolated or resettable state is available. The
existing `globalSetup` reset ([`global-setup.ts`](../apps/requestflow/global-setup.ts)) runs once
per test run, not per test, so it does not lift this limitation.

## How a new automated test is added (process)

1. Pick an approved test case with _Automation: Yes_ from the [catalog](04-test-case-catalog.md).
2. Follow the nearest canonical pattern (the catalog's recommendation names one).
3. Tag the test with its `@REQ-…` and `@TC-…` IDs; never add `@CAN-…` (canonical status is a
   human decision, gate H5).
4. Run `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test`.
5. Open a pull request; CI runs the full suite. After merge, the published CI record is the
   execution evidence.
