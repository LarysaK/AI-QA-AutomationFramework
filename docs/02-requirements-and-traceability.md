# B. Requirements Specification and Traceability

The authoritative specification is
[RequestFlow Requirements v1.2](../specs/requestflow/requirements.md), the frozen, approved
baseline. Any change is made as a new versioned revision. This document summarizes it and maps
each requirement to its test cases and automated tests; it never restates a rule differently.

## Shared definitions (from Requirements v1.2)

- **Roles.** A user has exactly one role: `EMPLOYEE` or `REVIEWER`. An Employee reads only their
  own requests. A Reviewer reads `SUBMITTED`, `APPROVED` and `REJECTED` requests and never a
  `DRAFT`.
- **Demo users.** `emp-alex` (Alex Morgan, EMPLOYEE), `emp-sam` (Sam Rivera, EMPLOYEE),
  `rev-jordan` (Jordan Lee, REVIEWER).
- **Status model.** `DRAFT → SUBMITTED → APPROVED` or `→ REJECTED`; `APPROVED` and `REJECTED` are
  terminal; any other transition is `409 INVALID_STATE_TRANSITION`.
- **Validation.** Title 1–100 characters after trim; description 1–1000 after trim; amount a
  JSON number, `> 0`, `≤ 100000`, at most 2 decimals; rejection comment 1–500 after trim.
  System-managed or unknown fields are rejected with `400 VALIDATION_ERROR`; approval accepts no
  payload.
- **Errors.** Body `{ "error": { "code", "message" } }`; tests assert `code`, never `message`.
  Precedence when several apply: **401 → 403 → 404 → 409 → 400**.

## Requirements at a glance

Counts come from the [coverage matrix](05-automation-coverage-matrix.md). _Automated_ means a
committed Playwright test is traceably linked and exercises the scenario as written.

| Requirement                                         | Endpoint                          | Test cases | Automated | Investigate | Manual by design | Not yet automated | Canonical tests  |
| --------------------------------------------------- | --------------------------------- | ---------: | --------: | ----------: | ---------------: | ----------------: | ---------------- |
| [REQ-001 — Create a request](#req-001)              | `POST /api/requests`              |         18 |        12 |           0 |                0 |                 6 | CAN-001, CAN-002 |
| [REQ-002 — Edit a draft request](#req-002)          | `PATCH /api/requests/:id`         |         11 |         2 |           1 |                0 |                 8 | CAN-003          |
| [REQ-003 — Submit a request](#req-003)              | `PATCH /api/requests/:id/submit`  |          8 |         1 |           0 |                0 |                 7 | CAN-004 (step)   |
| [REQ-004 — Review queue](#req-004)                  | `GET /api/review-queue`           |          8 |         1 |           0 |                1 |                 6 | CAN-004 (step)   |
| [REQ-005 — Approve a request](#req-005)             | `PATCH /api/requests/:id/approve` |          8 |         1 |           0 |                0 |                 7 | CAN-004          |
| [REQ-006 — Reject a request](#req-006)              | `PATCH /api/requests/:id/reject`  |         12 |         2 |           0 |                0 |                10 | CAN-005          |
| [REQ-007 — Authorization](#req-007)                 | All business endpoints            |          7 |         0 |           0 |                0 |                 7 | —                |
| [REQ-008 — Request retrieval through API](#req-008) | `GET /api/requests/:id`           |          8 |         1 |           0 |                0 |                 7 | CAN-004, CAN-005 |
| [REQ-009 — List own requests](#req-009)             | `GET /api/requests`               |          8 |         0 |           0 |                1 |                 7 | —                |
| [REQ-010 — Demo authentication](#req-010)           | `POST /api/auth/login`, `/logout` |          8 |         0 |           0 |                0 |                 8 | —                |
| **All**                                             |                                   |     **96** |    **20** |       **1** |            **2** |            **73** |                  |

Every one of the 10 requirements has test cases in the approved plan. Seven have at least one
automated test case; **REQ-007, REQ-009 and REQ-010 have none.**

---

<a id="req-001"></a>

## REQ-001 — Create a request

An Employee must be able to create a new request (`POST /api/requests`). Acceptance criteria
cover the allowed payload fields, validation with `400 VALIDATION_ERROR`, a unique ID, initial
status `DRAFT` with `reviewComment` `null`, the authenticated Employee as requester, both
timestamps, `201` on success, and `403 FORBIDDEN` for a Reviewer.

**Coverage.** TC-001-01 – TC-001-18. Automated: TC-001-02 – TC-001-12 (CAN-002, 24 data-driven
API tests) and TC-001-17 (CAN-001, UI). Not yet automated: TC-001-01 (full create contract),
TC-001-13 (system-managed or unknown fields), TC-001-14 (nothing created after a rejected
create), TC-001-15 (Reviewer `403`), TC-001-16 (no session `401`) and TC-001-18 (UI validation
feedback).

<a id="req-002"></a>

## REQ-002 — Edit a draft request

An Employee must be able to edit their own request while it is in `DRAFT`
(`PATCH /api/requests/:id`). The update is partial; an empty or disallowed payload is `400`;
invalid values change nothing; non-`DRAFT` is `409`; another Employee's request is `404`; a
Reviewer gets `403`; success updates `updatedAt` and returns `200`.

**Coverage.** TC-002-01 – TC-002-11. Automated (CAN-003): TC-002-04 (atomic failure) and
TC-002-10 (`409` after submission). TC-002-02 is linked but needs investigation: its test patches
`title`, while the scenario names `amount` (see [D](04-test-case-catalog.md#tc-002-02)).
Authorization cases TC-002-07 – TC-002-09 are not yet automated.

<a id="req-003"></a>

## REQ-003 — Submit a request

An Employee must be able to submit their own `DRAFT` request (`PATCH /api/requests/:id/submit`):
only `DRAFT` can be submitted (`409` otherwise), the status becomes `SUBMITTED`, `updatedAt`
changes, the request appears in the review queue and can no longer be edited; another
Employee's request is `404`; a Reviewer gets `403`.

**Coverage.** TC-003-01 – TC-003-08. Automated: TC-003-08 (UI submission, inside CAN-004). The
API cases, including TC-003-07 (the target of the Generator's offline demonstration, see
[I](09-ai-agent-architecture-and-guardrails.md#the-documented-offline-demonstration)), are not
yet automated.

<a id="req-004"></a>

## REQ-004 — Review queue

A Reviewer must be able to see requests waiting for review (`GET /api/review-queue`): all
`SUBMITTED` requests of all Employees, none in other statuses, `{ "items": [...] }` newest first,
details can be opened, and an Employee gets `403`.

**Coverage.** TC-004-01 – TC-004-08. Automated: TC-004-08 (UI queue row and details, inside
CAN-004). Manual by design: TC-004-07 (empty queue; needs isolated state, plan §6).

<a id="req-005"></a>

## REQ-005 — Approve a request

A Reviewer must be able to approve a `SUBMITTED` request (`PATCH /api/requests/:id/approve`): no
payload fields (`400` otherwise), `409` for terminal states, `404` for `DRAFT`, status
`APPROVED`, `updatedAt` changes, `reviewComment` stays `null`, an Employee gets `403`, and the
final status is visible in UI and API.

**Coverage.** TC-005-01 – TC-005-08. Automated: TC-005-08 (E2E approval workflow, CAN-004).

<a id="req-006"></a>

## REQ-006 — Reject a request

A Reviewer must be able to reject a `SUBMITTED` request (`PATCH /api/requests/:id/reject`) with
a mandatory, validated comment stored as `reviewComment`; terminal states are `409`, `DRAFT` is
`404`, an Employee gets `403`, and the comment and final status are visible in UI and API.

**Coverage.** TC-006-01 – TC-006-12. Automated (CAN-005): TC-006-11 (UI whitespace-only comment
refused) and TC-006-12 (E2E rejection workflow).

<a id="req-007"></a>

## REQ-007 — Authorization

Quoted verbatim from [Requirements v1.2](../specs/requestflow/requirements.md#req-007--authorization):

> Business actions must respect the authenticated user's role and ownership.
>
> **Acceptance criteria**
>
> - Employee-only actions (create, edit, submit, list own requests) performed by a Reviewer
>   return `403` with `FORBIDDEN`.
> - Reviewer-only actions (review queue, approve, reject) performed by an Employee return
>   `403` with `FORBIDDEN`.
> - An Employee can read and act on only their own requests. Another Employee's request is
>   treated as non-existent: `404` with `NOT_FOUND`.
> - A Reviewer can read only `SUBMITTED`, `APPROVED` and `REJECTED` requests. A `DRAFT`
>   request is treated as non-existent for a Reviewer: `404` with `NOT_FOUND`.
> - When several errors apply, the error precedence determines the response.
> - Authorization must be enforced by the application, not only by hiding UI controls.

**Meaning.** REQ-007 is the cross-cutting rule for **role-based and ownership-based access**:
which role may call which endpoint (`403`), the invisibility of other Employees' requests and of
`DRAFT` requests for Reviewers (`404`), the fixed error precedence, and server-side enforcement.
The test plan's [authorization matrix (§7.1)](../specs/requestflow/test-plan.md#71-authorization-matrix-req-007)
gives the expected response per endpoint and caller.

**Test cases.** TC-007-01 – TC-007-05 (error precedence 401 → 403 → 404 → 409 → 400),
TC-007-06 (error response shape and codes), TC-007-07 (UI offers actions only where allowed).
Most per-endpoint authorization cases are owned by the requirement of the operation (for
example TC-001-15, TC-002-08, TC-002-09, TC-005-06, TC-008-03).

**Coverage: none automated.** No committed test carries a `@TC-007-…` tag, and none of the
per-endpoint `403`/`404` authorization cases owned by other requirements is automated either.
The E2E tests check, as part of their own scenarios, that some UI controls are hidden after
submission and after review; that is incidental, untagged, and not evidence for TC-007-07 or for
server-side enforcement.

<a id="req-008"></a>

## REQ-008 — Request retrieval through API

A request must be retrievable through `GET /api/requests/:id` with the full representation,
`reviewComment` always present, visibility per REQ-007 (`404` otherwise), and the API state must
reflect actions performed through the UI.

**Coverage.** TC-008-01 – TC-008-08. Automated: TC-008-08 (UI actions reflected in the API,
inside both CAN-004 and CAN-005).

<a id="req-009"></a>

## REQ-009 — List own requests

Quoted verbatim from [Requirements v1.2](../specs/requestflow/requirements.md#req-009--list-own-requests):

> An Employee must be able to view their own requests and their current status.
>
> `GET /api/requests`
>
> **Acceptance criteria**
>
> - The response contains all requests whose requester is the authenticated Employee, in any
>   status.
> - The response contains no requests belonging to other Employees.
> - Success returns `200` with `{ "items": [ <Request>, ... ] }`, ordered by `createdAt`
>   descending (newest first).
> - Only an Employee can list requests; a Reviewer receives `403` with `FORBIDDEN`.

**Meaning.** REQ-009 is the **Employee's own-request list**: every own request in any status,
nothing of other Employees, newest first, and Reviewers refused.

**Test cases.** TC-009-01 – TC-009-08: all statuses listed, other Employees' requests absent,
response shape, ordering, empty list, Reviewer `403`, no session `401`, and the UI My requests
table.

**Coverage: none automated.** TC-009-05 (empty list) is manual by design (plan §6); the other
seven are not yet automated. The UI tests open the My requests page only to navigate to New
request; they do not assert its contents.

<a id="req-010"></a>

## REQ-010 — Demo authentication

Quoted verbatim from [Requirements v1.2](../specs/requestflow/requirements.md#req-010--demo-authentication):

> Users authenticate with simple demo authentication. No password is required in v1.
>
> `POST /api/auth/login`, `POST /api/auth/logout`
>
> **Acceptance criteria**
>
> - A user logs in as one of the predefined demo users by sending their user ID:
>   `{ "userId": "emp-alex" }`.
> - Successful login returns `200` with the authenticated user
>   (`{ "id": "emp-alex", "name": "Alex Morgan", "role": "EMPLOYEE" }`) and sets the session
>   cookie.
> - Successful logout returns `204` with an empty body and invalidates the session.
> - After logout, the invalidated session is no longer authenticated.
> - Every `/api/requests` and `/api/review-queue` endpoint requires an authenticated session;
>   a request without a valid session returns `401` with `UNAUTHENTICATED`.

**Meaning.** REQ-010 is **password-less demo login and logout** with a session cookie, and the
rule that every business endpoint requires a valid session (`401` otherwise). It is a deliberate
demo mechanism, not production authentication (out of scope in v1).

**Test cases.** TC-010-01 – TC-010-08: login for each demo user, the session cookie, logout,
the invalidated cookie, `401` on all 8 business endpoints, UI login and logout, and the UI
redirect to `/login` (TC-010-08, which the plan flags as implemented behaviour that Requirements
v1.2 do not define).

**Coverage: none automated.** Every automated test logs in as a precondition, through
`RequestFlowApi.loginAs` ([`requestflow-api.client.ts`](../apps/requestflow/api/requestflow-api.client.ts))
or the UI login buttons; a failed login stops the test. That exercises login, but no test asserts
the REQ-010 criteria (response body, cookie, logout, `401` after logout or without a session).

---

## Traceability chain

**REQ → TC → test → execution result**, as the [Agent Standard §5](../agents/standard/standard.md#5-traceability) defines it:

1. Requirements are `## REQ-NNN — <title>` headings in `requirements.md`.
2. Test cases are rows `TC-NNN-NN` under `### REQ-NNN` in `test-plan.md`; the TC number equals
   the owning requirement's number.
3. Tests carry Playwright tags `@REQ-…`, `@TC-…` and, for reference tests, `@CAN-…`.
4. Results come from published CI records, keyed by Playwright's test ID and project.

**Integrity checks at the audit commit (verified):**

- 96 test-case rows, 96 unique IDs, no duplicates; every TC belongs to an existing requirement.
- 30 test instances; each carries at least one `@TC-…` tag; no tag names an unknown TC or REQ;
  every `@TC-…` tag is accompanied by its owning `@REQ-…` tag; no orphan tests.
- Linkage is confirmed in both directions by the snapshot builder
  ([`reporting/dashboard-data/`](../reporting/dashboard-data/)).
- Published CI run #23 tested the audit commit; its 30 results match the 30 instances exactly.
