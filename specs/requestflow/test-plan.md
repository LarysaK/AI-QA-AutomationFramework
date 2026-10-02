# RequestFlow — Test Plan v1

| Item                | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Application         | RequestFlow (local AUT, `apps/requestflow/app/`)           |
| Requirements source | [RequestFlow Requirements v1.2](requirements.md) (frozen)  |
| Scope               | REQ-001 – REQ-010                                          |
| Authorship          | Human QA test design, created before the Planner Agent     |
| Status              | Baseline for the first canonical automated reference tests |

This plan derives test scenarios from the frozen requirements. It does not add, change or
interpret business rules. Where the requirements define exact behaviour (status codes, error
codes, field rules), the expected result is taken from them verbatim.

---

## 1. Test strategy

### 1.1 Principles

1. **API tests carry detailed coverage** of validation, boundary values, authorization,
   ownership, state transitions and the API contract (status codes, error codes, response
   shapes).
2. **UI tests verify the user's view:** interaction, forms, navigation, visible validation
   feedback, and which actions are offered for a given role and status.
3. **E2E tests cover only the important cross-role business workflows**, from UI action to
   final API state.
4. **The validation matrix is not repeated through the UI.** The UI gets one representative
   validation scenario per form; every boundary is covered at API level.
5. **Hiding a control in the UI is not proof of authorization.** Every authorization rule is
   verified through the API, where the server must enforce it (REQ-007).
6. **Failed operations must not partially modify a request.** Every negative scenario that
   targets an existing request also verifies, through `GET /api/requests/:id`, that the
   request is unchanged.
7. **Tests are independent and create their own data** through the API, unless the
   scenario is about creating data through the UI.

### 1.2 Test levels

| Level | Interface                                    | Typical assertions                                     |
| ----- | -------------------------------------------- | ------------------------------------------------------ |
| API   | JSON API with a session cookie per demo user | status code, `error.code`, response body, stored state |
| UI    | Server-rendered pages through a browser      | visible values, feedback, offered controls             |
| E2E   | Browser contexts for several users, then API | cross-role workflow and final state in UI and API      |

### 1.3 Assertion rules

- Error responses are asserted on HTTP status and `error.code`. `error.message` is
  informational and is never asserted exactly (Requirements: Error response shape).
- `amount` is compared as a number, never as formatted text (Requirements: Amount).
- `updatedAt` "changes" is asserted as strictly later than the previous value; `createdAt`
  "unchanged" is asserted as equal to the value returned at creation.
- List assertions check inclusion, exclusion and relative order of the test's own requests,
  not exact list contents (see 1.4).
- UI assertions use the accessible roles, labels and visible text of the implemented UI.
  The page layout is not part of the frozen requirements; UI tests assert business outcomes
  that the requirements say must be visible.

### 1.4 Test data and environment

- **Demo users:** `emp-alex` (Alex Morgan, EMPLOYEE), `emp-sam` (Sam Rivera, EMPLOYEE),
  `rev-jordan` (Jordan Lee, REVIEWER). Each test logs in through `POST /api/auth/login`.
- **Unique data:** each test creates its own requests with a unique title, so tests running in
  parallel against the same server do not interfere.
- **Shared state:** all tests share one in-memory server and the same three users. Scenarios
  that need an exactly empty list cannot be asserted deterministically while other tests run;
  they are marked _Automation: No_ until isolated state is available (see 6).
- **Preconditions for transitions** (SUBMITTED, APPROVED, REJECTED) are created through the
  API, not the UI, unless the UI flow is under test.

### 1.5 Priorities

| Priority | Meaning                                                                                |
| -------- | -------------------------------------------------------------------------------------- |
| P0       | Core workflow, authentication or authorization; a failure blocks release of the AUT    |
| P1       | Validation, boundaries, state-transition errors and atomicity; important, not blocking |
| P2       | Contract details, ordering and edge cases with low business risk                       |

---

## 2. Test inventory

Test case IDs use the form `TC-<REQ number>-<sequence>`. Scenarios marked _(data-driven)_ are
one test case executed over the listed data rows.

### REQ-001 — Create a request

| ID        | Scenario                                                                                                                                                                                                                                                                                                                 | Level | Type          | Automation | Priority |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------- | ---------- | -------- |
| TC-001-01 | Alex creates a valid request → `201`; response has a non-empty `id`, the sent title, description and amount, `status` `DRAFT`, `reviewComment` `null`, `requester` `{ id: "emp-alex", name: "Alex Morgan" }`, `createdAt` = `updatedAt`; `GET` by `id` returns the same values; a second create returns a different `id` | API   | Positive      | Yes        | P0       |
| TC-001-02 | Title and description with leading/trailing whitespace are stored trimmed                                                                                                                                                                                                                                                | API   | Positive      | Yes        | P1       |
| TC-001-03 | Title `""` and `"   "` → `400 VALIDATION_ERROR` _(data-driven)_                                                                                                                                                                                                                                                          | API   | Negative      | Yes        | P1       |
| TC-001-04 | Title of 1 character, 100 characters, and 100 characters surrounded by whitespace → `201` _(data-driven)_                                                                                                                                                                                                                | API   | Boundary      | Yes        | P1       |
| TC-001-05 | Title of 101 characters → `400 VALIDATION_ERROR`                                                                                                                                                                                                                                                                         | API   | Boundary      | Yes        | P1       |
| TC-001-06 | Description `""` and `"   "` → `400 VALIDATION_ERROR` _(data-driven)_                                                                                                                                                                                                                                                    | API   | Negative      | Yes        | P1       |
| TC-001-07 | Description of 1 and 1000 characters → `201` _(data-driven)_                                                                                                                                                                                                                                                             | API   | Boundary      | Yes        | P1       |
| TC-001-08 | Description of 1001 characters → `400 VALIDATION_ERROR`                                                                                                                                                                                                                                                                  | API   | Boundary      | Yes        | P1       |
| TC-001-09 | Amount `0.01`, `100000` and `10.12` → `201`, stored with the same numeric value _(data-driven)_                                                                                                                                                                                                                          | API   | Boundary      | Yes        | P1       |
| TC-001-10 | Amount `0`, `-1`, `100000.01` and `10.123` → `400 VALIDATION_ERROR` _(data-driven)_                                                                                                                                                                                                                                      | API   | Boundary      | Yes        | P1       |
| TC-001-11 | Amount as a string (`"10.50"`, `"abc"`) → `400 VALIDATION_ERROR` _(data-driven)_                                                                                                                                                                                                                                         | API   | Negative      | Yes        | P1       |
| TC-001-12 | Payload missing title, description or amount → `400 VALIDATION_ERROR` _(data-driven, one row per field)_                                                                                                                                                                                                                 | API   | Negative      | Yes        | P1       |
| TC-001-13 | Payload with a system-managed field (`status`) or an unknown field → `400 VALIDATION_ERROR` _(data-driven)_                                                                                                                                                                                                              | API   | Negative      | Yes        | P1       |
| TC-001-14 | After any rejected create (TC-001-03 – 13), Alex's `GET /api/requests` contains no request with the test's title                                                                                                                                                                                                         | API   | Negative      | Yes        | P1       |
| TC-001-15 | Jordan (Reviewer) creates a request → `403 FORBIDDEN`                                                                                                                                                                                                                                                                    | API   | Authorization | Yes        | P0       |
| TC-001-16 | Create without a session → `401 UNAUTHENTICATED`                                                                                                                                                                                                                                                                         | API   | Authorization | Yes        | P0       |
| TC-001-17 | Alex creates a request through the New request form; details page shows the entered values, requester Alex Morgan and status `DRAFT`                                                                                                                                                                                     | UI    | Positive      | Yes        | P0       |
| TC-001-18 | Form submitted with a whitespace-only title → validation feedback is visible and associated with the Title field; no request is created                                                                                                                                                                                  | UI    | Negative      | Yes        | P1       |

### REQ-002 — Edit a draft request

| ID        | Scenario                                                                                                                                       | Level | Type          | Automation | Priority |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-002-01 | Alex edits title, description and amount of own DRAFT → `200`; new values returned; `status` `DRAFT`; `createdAt` unchanged; `updatedAt` later | API   | Positive      | Yes        | P0       |
| TC-002-02 | Partial PATCH with only `amount` → only amount changes; title and description unchanged                                                        | API   | Positive      | Yes        | P1       |
| TC-002-03 | PATCH with an invalid value (title of 101 characters) → `400 VALIDATION_ERROR`; request unchanged                                              | API   | Negative      | Yes        | P1       |
| TC-002-04 | PATCH with a valid title and an invalid amount (`0`) → `400 VALIDATION_ERROR`; neither field changed (atomic)                                  | API   | Negative      | Yes        | P1       |
| TC-002-05 | Empty PATCH `{}` → `400 VALIDATION_ERROR`; request unchanged                                                                                   | API   | Negative      | Yes        | P1       |
| TC-002-06 | PATCH with a system-managed field (`status: "APPROVED"`) → `400 VALIDATION_ERROR`; status still `DRAFT`                                        | API   | Negative      | Yes        | P2       |
| TC-002-07 | PATCH without a session → `401 UNAUTHENTICATED`                                                                                                | API   | Authorization | Yes        | P0       |
| TC-002-08 | Jordan PATCHes a request → `403 FORBIDDEN`; request unchanged                                                                                  | API   | Authorization | Yes        | P0       |
| TC-002-09 | Sam PATCHes Alex's DRAFT → `404 NOT_FOUND`; request unchanged                                                                                  | API   | Authorization | Yes        | P0       |
| TC-002-10 | Alex PATCHes own SUBMITTED request → `409 INVALID_STATE_TRANSITION`; request unchanged                                                         | API   | Negative      | Yes        | P1       |
| TC-002-11 | Alex edits own DRAFT through the Edit form; details page shows the new values and status `DRAFT`                                               | UI    | Positive      | Yes        | P1       |

### REQ-003 — Submit a request

| ID        | Scenario                                                                                                                                           | Level | Type          | Automation | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-003-01 | Alex submits own DRAFT → `200`, `status` `SUBMITTED`; title, description, amount and requester unchanged; `createdAt` unchanged; `updatedAt` later | API   | Positive      | Yes        | P0       |
| TC-003-02 | After submission the request is in Jordan's `GET /api/review-queue`                                                                                | API   | Positive      | Yes        | P0       |
| TC-003-03 | After submission the request is still in Alex's `GET /api/requests` with `status` `SUBMITTED`                                                      | API   | Positive      | Yes        | P1       |
| TC-003-04 | Submit without a session → `401 UNAUTHENTICATED`                                                                                                   | API   | Authorization | Yes        | P0       |
| TC-003-05 | Jordan submits a request → `403 FORBIDDEN`                                                                                                         | API   | Authorization | Yes        | P0       |
| TC-003-06 | Sam submits Alex's DRAFT → `404 NOT_FOUND`; request still `DRAFT`                                                                                  | API   | Authorization | Yes        | P0       |
| TC-003-07 | Alex submits an already SUBMITTED request → `409 INVALID_STATE_TRANSITION`; request unchanged, including `updatedAt`                               | API   | Negative      | Yes        | P1       |
| TC-003-08 | Alex submits through Submit for review; details page shows `SUBMITTED` and no longer offers Edit or Submit for review                              | UI    | Positive      | Yes        | P1       |

The API rule that a submitted request can no longer be edited is covered by TC-002-10.

### REQ-004 — Review queue

| ID        | Scenario                                                                                                                     | Level | Type          | Automation | Priority |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-004-01 | Jordan's queue contains a SUBMITTED request with correct title, description, amount, `status` and `requester` `{ id, name }` | API   | Positive      | Yes        | P0       |
| TC-004-02 | A DRAFT request is absent from the queue                                                                                     | API   | Negative      | Yes        | P1       |
| TC-004-03 | Requests that were APPROVED or REJECTED are absent from the queue _(data-driven)_                                            | API   | Negative      | Yes        | P1       |
| TC-004-04 | Response shape is `{ "items": [...] }`; two SUBMITTED requests created by the test appear newest first                       | API   | Positive      | Yes        | P2       |
| TC-004-05 | Alex requests the queue → `403 FORBIDDEN`                                                                                    | API   | Authorization | Yes        | P0       |
| TC-004-06 | Queue without a session → `401 UNAUTHENTICATED`                                                                              | API   | Authorization | Yes        | P1       |
| TC-004-07 | With no SUBMITTED requests, the queue returns `200` with `{ "items": [] }`                                                   | API   | Positive      | No         | P2       |
| TC-004-08 | Jordan sees the request in the Review queue table with title, amount, requester and status, and opens its details            | UI    | Positive      | Yes        | P1       |

### REQ-005 — Approve a request

| ID        | Scenario                                                                                                                             | Level | Type          | Automation | Priority |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------- | ---------- | -------- |
| TC-005-01 | Jordan approves a SUBMITTED request → `200`, `status` `APPROVED`; business data unchanged; `reviewComment` `null`; `updatedAt` later | API   | Positive      | Yes        | P0       |
| TC-005-02 | Approving an APPROVED request → `409 INVALID_STATE_TRANSITION` (terminal); request unchanged                                         | API   | Negative      | Yes        | P1       |
| TC-005-03 | Approving a REJECTED request → `409 INVALID_STATE_TRANSITION` (terminal); request unchanged                                          | API   | Negative      | Yes        | P1       |
| TC-005-04 | Approving a DRAFT request → `404 NOT_FOUND` (not visible to Reviewers); request still `DRAFT`                                        | API   | Negative      | Yes        | P1       |
| TC-005-05 | Approve with a payload field (e.g. `comment`) → `400 VALIDATION_ERROR`; request still `SUBMITTED`                                    | API   | Negative      | Yes        | P2       |
| TC-005-06 | Alex (the requester) approves own SUBMITTED request → `403 FORBIDDEN`; request still `SUBMITTED`                                     | API   | Authorization | Yes        | P0       |
| TC-005-07 | Approve without a session → `401 UNAUTHENTICATED`                                                                                    | API   | Authorization | Yes        | P0       |
| TC-005-08 | Approval workflow across roles, ending with `APPROVED` in UI and API (CAN-004)                                                       | E2E   | Positive      | Yes        | P0       |

### REQ-006 — Reject a request

| ID        | Scenario                                                                                                                                              | Level | Type          | Automation | Priority |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-006-01 | Jordan rejects a SUBMITTED request with a comment → `200`, `status` `REJECTED`, `reviewComment` = comment; business data unchanged; `updatedAt` later | API   | Positive      | Yes        | P0       |
| TC-006-02 | Comment with leading/trailing whitespace is stored trimmed as `reviewComment`                                                                         | API   | Positive      | Yes        | P1       |
| TC-006-03 | Comment `""`, `"   "` or missing → `400 VALIDATION_ERROR`; request still `SUBMITTED` with `reviewComment` `null` _(data-driven)_                      | API   | Negative      | Yes        | P1       |
| TC-006-04 | Comment of 1 and 500 characters → `200` _(data-driven, one request per row)_                                                                          | API   | Boundary      | Yes        | P1       |
| TC-006-05 | Comment of 501 characters → `400 VALIDATION_ERROR`; request unchanged                                                                                 | API   | Boundary      | Yes        | P1       |
| TC-006-06 | Rejecting a REJECTED or APPROVED request → `409 INVALID_STATE_TRANSITION` (terminal); `status` and `reviewComment` unchanged _(data-driven)_          | API   | Negative      | Yes        | P1       |
| TC-006-07 | Rejecting a DRAFT request → `404 NOT_FOUND`; request still `DRAFT`                                                                                    | API   | Negative      | Yes        | P1       |
| TC-006-08 | Reject payload with a field other than `comment` (e.g. `reviewComment`) → `400 VALIDATION_ERROR`; request unchanged                                   | API   | Negative      | Yes        | P2       |
| TC-006-09 | Alex (the requester) rejects own SUBMITTED request → `403 FORBIDDEN`; request unchanged                                                               | API   | Authorization | Yes        | P0       |
| TC-006-10 | Reject without a session → `401 UNAUTHENTICATED`                                                                                                      | API   | Authorization | Yes        | P0       |
| TC-006-11 | Jordan submits Reject with a whitespace-only Rejection comment → validation feedback is visible; request still `SUBMITTED`                            | UI    | Negative      | Yes        | P1       |
| TC-006-12 | Rejection workflow across roles; Alex sees `REJECTED` and the rejection comment on the request details; API confirms final state (CAN-005)            | E2E   | Positive      | Yes        | P0       |

### REQ-007 — Authorization

Most authorization cases are owned by the requirement of the operation (see the matrix in
7.1). This section adds the cross-cutting checks: the frozen error precedence, the error
contract and role-based availability of UI actions.

| ID        | Scenario                                                                                                                                                                                       | Level | Type          | Automation | Priority |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-007-01 | **401 before 403:** no session on a Reviewer-only endpoint (`approve`) with an invalid payload → `401 UNAUTHENTICATED`                                                                         | API   | Authorization | Yes        | P0       |
| TC-007-02 | **403 before 404:** Alex approves a non-existent request ID → `403 FORBIDDEN`                                                                                                                  | API   | Authorization | Yes        | P0       |
| TC-007-03 | **403 before 400:** Jordan creates a request with an invalid payload → `403 FORBIDDEN`                                                                                                         | API   | Authorization | Yes        | P1       |
| TC-007-04 | **404 before 409:** Sam edits Alex's SUBMITTED request → `404 NOT_FOUND`                                                                                                                       | API   | Authorization | Yes        | P1       |
| TC-007-05 | **409 before 400:** Alex edits own SUBMITTED request with an invalid title → `409`; Jordan rejects an APPROVED request with an empty comment → `409` _(data-driven)_                           | API   | Negative      | Yes        | P1       |
| TC-007-06 | Every error response has the shape `{ "error": { "code", "message" } }` with the code from the frozen table (sampled over 400, 401, 403, 404 and 409 responses)                                | API   | Negative      | Yes        | P0       |
| TC-007-07 | UI offers actions only where allowed: Alex sees Edit and Submit for review on own DRAFT only; Jordan sees Approve, Rejection comment and Reject on SUBMITTED only, not on APPROVED or REJECTED | UI    | Authorization | Yes        | P1       |

### REQ-008 — Request retrieval through API

| ID        | Scenario                                                                                                                                                                                    | Level | Type          | Automation | Priority |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-008-01 | Alex retrieves own request → `200` with exactly the fields `id`, `title`, `description`, `amount`, `requester` `{ id, name }`, `status`, `reviewComment` (`null`), `createdAt`, `updatedAt` | API   | Positive      | Yes        | P0       |
| TC-008-02 | After rejection, `GET` returns `reviewComment` with the rejection comment for both Alex and Jordan                                                                                          | API   | Positive      | Yes        | P1       |
| TC-008-03 | Sam retrieves Alex's request → `404 NOT_FOUND`                                                                                                                                              | API   | Authorization | Yes        | P0       |
| TC-008-04 | Jordan retrieves a DRAFT request → `404 NOT_FOUND`                                                                                                                                          | API   | Authorization | Yes        | P0       |
| TC-008-05 | Jordan retrieves SUBMITTED, APPROVED and REJECTED requests → `200` _(data-driven)_                                                                                                          | API   | Positive      | Yes        | P1       |
| TC-008-06 | Retrieving a non-existent ID → `404 NOT_FOUND`                                                                                                                                              | API   | Negative      | Yes        | P1       |
| TC-008-07 | Retrieval without a session → `401 UNAUTHENTICATED`                                                                                                                                         | API   | Authorization | Yes        | P1       |
| TC-008-08 | A request created, submitted and reviewed through the UI is returned by the API with the same values and final status (verified in CAN-004/005)                                             | E2E   | Positive      | Yes        | P0       |

### REQ-009 — List own requests

| ID        | Scenario                                                                                                                | Level | Type          | Automation | Priority |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-009-01 | Alex's list contains own requests in each status: DRAFT, SUBMITTED, APPROVED and REJECTED, each with its current status | API   | Positive      | Yes        | P0       |
| TC-009-02 | A request created by Sam is absent from Alex's list                                                                     | API   | Authorization | Yes        | P0       |
| TC-009-03 | Response shape is `{ "items": [...] }`, each item a full Request representation                                         | API   | Positive      | Yes        | P1       |
| TC-009-04 | Two requests created by the test appear newest first (`createdAt` descending)                                           | API   | Positive      | Yes        | P2       |
| TC-009-05 | An Employee without requests gets `200` with `{ "items": [] }`                                                          | API   | Positive      | No         | P2       |
| TC-009-06 | Jordan lists requests → `403 FORBIDDEN`                                                                                 | API   | Authorization | Yes        | P0       |
| TC-009-07 | List without a session → `401 UNAUTHENTICATED`                                                                          | API   | Authorization | Yes        | P1       |
| TC-009-08 | My requests table shows Alex's request with title, amount and status, linking to its details                            | UI    | Positive      | Yes        | P1       |

### REQ-010 — Demo authentication

| ID        | Scenario                                                                                                                                                    | Level | Type          | Automation | Priority |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ---------- | -------- |
| TC-010-01 | Login as `emp-alex`, `emp-sam` and `rev-jordan` → `200` with `{ id, name, role }` matching the demo user, and an `rf_session` cookie is set _(data-driven)_ | API   | Positive      | Yes        | P0       |
| TC-010-02 | The session cookie from login authenticates subsequent API calls (Alex: `GET /api/requests` → `200`)                                                        | API   | Positive      | Yes        | P0       |
| TC-010-03 | Logout → `204` with an empty body                                                                                                                           | API   | Positive      | Yes        | P0       |
| TC-010-04 | The cookie value from before logout → `401 UNAUTHENTICATED` on a protected endpoint                                                                         | API   | Negative      | Yes        | P0       |
| TC-010-05 | Every protected endpoint without a session → `401 UNAUTHENTICATED` _(data-driven over the 8 `/api/requests` and `/api/review-queue` endpoints)_             | API   | Authorization | Yes        | P1       |
| TC-010-06 | Login through the UI with each demo user button → the user's name and role are shown as signed in _(data-driven)_                                           | UI    | Positive      | Yes        | P0       |
| TC-010-07 | Log out through the UI → the session ends; the API with the old cookie returns `401`                                                                        | UI    | Positive      | Yes        | P1       |
| TC-010-08 | Opening a protected page without a session redirects to `/login` ¹                                                                                          | UI    | Negative      | Yes        | P2       |

¹ This behaviour is implemented but not defined in Requirements v1.2, which only specify the
API `401`. TC-010-08 documents current UI behaviour; it must not be a canonical test, and it
must be revisited if the requirements change.

---

## 3. Canonical automation candidates

These five tests are **not the complete automated suite**. They are the first hand-written
reference tests. Each one establishes a pattern (structure, locators, data handling,
assertions) that the Generator Agent will later follow when it proposes further tests from
this inventory.

| ID      | Title                            | Level | Covers                                                     |
| ------- | -------------------------------- | ----- | ---------------------------------------------------------- |
| CAN-001 | Employee creates a valid request | UI    | TC-001-17                                                  |
| CAN-002 | Request validation boundaries    | API   | TC-001-02, TC-001-03 – TC-001-12                           |
| CAN-003 | Employee edits own draft         | API   | TC-002-02, TC-002-04, TC-002-10                            |
| CAN-004 | Request approval workflow        | E2E   | TC-003-08, TC-004-08, TC-005-08, TC-008-08 (approval path) |
| CAN-005 | Request rejection workflow       | E2E   | TC-006-11, TC-006-12, TC-008-08 (rejection path)           |

### CAN-001 — Employee creates a valid request (UI)

**Purpose:** reference form interaction with semantic locators (`getByRole`, `getByLabel`),
persistence and the initial `DRAFT` state.

**Flow:** Alex logs in → New request → fills Title, Description and Amount → Save draft →
details page shows the entered values, requester Alex Morgan and status `DRAFT`.

### CAN-002 — Request validation boundaries (API)

**Purpose:** reference data-driven API validation using equivalence partitioning and
boundary values.

**Flow:** as Alex, one data table drives `POST /api/requests` over the title, description
and amount partitions and boundaries of TC-001-03 – TC-001-12. Each row asserts the status
code and, for rejections, `error.code` `VALIDATION_ERROR`. The trimming rows (TC-001-02) also
read the request back through `GET` to confirm the trimmed values were stored.

### CAN-003 — Employee edits own draft (API)

**Purpose:** reference partial update, state preservation and atomic failure.

**Flow:** Alex creates a DRAFT → partial PATCH of one field (only that field changes,
`status` stays `DRAFT`, `createdAt` unchanged, `updatedAt` later) → PATCH with one valid and
one invalid field returns `400`, and `GET` shows the request unchanged → a separately created
request is submitted, an edit of it returns `409`, and `GET` shows it unchanged.

TC-002-04 names `0` as an example invalid amount. Any value from the same invalid partition,
`amount ≤ 0`, exercises the scenario; CAN-003 uses `-1`. TC-002-01 (editing all three fields)
remains in the inventory as a non-canonical scenario.

### CAN-004 — Request approval workflow (E2E)

**Purpose:** reference multi-role business workflow with one browser context per user.

**Flow:** Alex logs in → creates a request → submits it → Jordan logs in, in a separate
browser context → the request appears in the Review queue → Jordan approves it → Alex sees
`APPROVED` → `GET /api/requests/:id` confirms `APPROVED`.

### CAN-005 — Request rejection workflow (E2E)

**Purpose:** reference terminal transition and cross-role state propagation.

**Flow:** Alex creates and submits a request → Jordan's whitespace-only rejection comment is
refused with visible validation feedback and the request stays `SUBMITTED` → Jordan rejects it
with a comment → Alex sees
`REJECTED` and the rejection comment on the request details → `GET /api/requests/:id`
confirms `REJECTED` and `reviewComment`.

---

## 4. Out of scope

- Concurrent review or modification (Requirements: Out of Scope).
- Production authentication, passwords, OAuth / SSO / JWT, multi-role users.
- Behaviour not defined by Requirements v1.2, including: login with an unknown user ID,
  logout without a session, payloads sent to `/submit`, wording of `error.message`, UI
  layout and styling, and HTML error pages.

---

## 5. Entry and exit criteria

- **Entry:** RequestFlow starts with `npm run aut:start` and `GET /health` returns `200`.
- **Exit for the canonical baseline:** CAN-001 – CAN-005 automated and passing; all other P0
  scenarios either automated or explicitly scheduled.

---

## 6. Known limitations

- **Empty-list scenarios (TC-004-07, TC-009-05)** need a server state with no matching
  requests. With shared in-memory state and parallel tests this is not deterministic. They
  are kept for manual execution on a freshly started server until an isolated or resettable
  state is available to the test run.

---

## 7. Traceability

### 7.1 Authorization matrix (REQ-007)

Expected response for each endpoint and caller, assuming a syntactically valid request.
`own` / `other` refer to the Employee's ownership of the request.

| Endpoint                         | No session | Alex (own)             | Alex (Sam's request) | Jordan                                   |
| -------------------------------- | ---------- | ---------------------- | -------------------- | ---------------------------------------- |
| `POST /api/requests`             | 401        | 201                    | n/a                  | 403                                      |
| `GET /api/requests`              | 401        | 200 (own only)         | n/a                  | 403                                      |
| `GET /api/requests/:id`          | 401        | 200                    | 404                  | 404 if DRAFT, otherwise 200              |
| `PATCH /api/requests/:id`        | 401        | 200 if DRAFT, else 409 | 404                  | 403                                      |
| `PATCH /api/requests/:id/submit` | 401        | 200 if DRAFT, else 409 | 404                  | 403                                      |
| `PATCH …/:id/approve`            | 401        | 403                    | 403                  | 404 if DRAFT; 200 if SUBMITTED; else 409 |
| `PATCH …/:id/reject`             | 401        | 403                    | 403                  | 404 if DRAFT; 200 if SUBMITTED; else 409 |
| `GET /api/review-queue`          | 401        | 403                    | 403                  | 200 (SUBMITTED only)                     |

Precedence when several errors apply: **401 → 403 → 404 → 409 → 400** (TC-007-01 – 05).

### 7.2 Requirement coverage

| REQ     | Test cases            | API | UI  | E2E | Canonical               |
| ------- | --------------------- | --- | --- | --- | ----------------------- |
| REQ-001 | TC-001-01 – TC-001-18 | 16  | 2   | 0   | CAN-001, CAN-002        |
| REQ-002 | TC-002-01 – TC-002-11 | 10  | 1   | 0   | CAN-003                 |
| REQ-003 | TC-003-01 – TC-003-08 | 7   | 1   | 0   | CAN-004; CAN-005 (step) |
| REQ-004 | TC-004-01 – TC-004-08 | 7   | 1   | 0   | CAN-004                 |
| REQ-005 | TC-005-01 – TC-005-08 | 7   | 0   | 1   | CAN-004                 |
| REQ-006 | TC-006-01 – TC-006-12 | 10  | 1   | 1   | CAN-005                 |
| REQ-007 | TC-007-01 – TC-007-07 | 6   | 1   | 0   | —                       |
| REQ-008 | TC-008-01 – TC-008-08 | 7   | 0   | 1   | CAN-004, CAN-005        |
| REQ-009 | TC-009-01 – TC-009-08 | 7   | 1   | 0   | —                       |
| REQ-010 | TC-010-01 – TC-010-08 | 5   | 3   | 0   | —                       |
| **All** | **96**                | 82  | 11  | 3   |                         |
