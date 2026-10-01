# RequestFlow — Business Requirements v1.2

## Baseline

RequestFlow Requirements v1.2 is the approved baseline for implementation and deterministic
test design. Any further change to these requirements is made as a new versioned revision.

---

## Purpose

RequestFlow is a small demonstration application used as the Application Under Test (AUT)
for the AI-Assisted QA Automation Framework.

The application models a generic request-and-approval business workflow.

It is intentionally domain-neutral and exists to demonstrate realistic QA automation
scenarios including:

- positive and negative testing;
- multi-role workflows;
- authorization rules;
- UI and API validation;
- state transitions;
- test data management;
- AI-assisted test planning and generation;
- failure analysis and controlled test healing.

---

## Revision history

### v1.2

- Error precedence defined.
- Login and logout endpoints defined.
- Fixed demo users defined.
- `requester` representation defined.
- Amount must be a JSON number.
- Client-writable fields defined; system-managed, unknown and empty payloads are rejected.
- Approval accepts no payload.
- `reviewComment` is always present (`null` until rejection).
- Success status codes, response bodies and list ordering defined.
- Document marked as the approved v1 baseline.

### v1.1

- Roles are mutually exclusive; the "requester cannot review their own request" rule is
  removed because it is unreachable in v1.
- Read visibility rules added for both roles.
- Demo cookie-based authentication defined (REQ-010).
- Exact validation rules defined for title, description, amount and rejection comment.
- `PATCH /api/requests/:id` defined as a partial update.
- List endpoints added: `GET /api/requests` (REQ-009) and `GET /api/review-queue` (REQ-004).
- Timestamp semantics defined.
- Common API error shape, HTTP status semantics and error codes defined.
- Out of Scope section added.

---

## Roles

A user has exactly one role in v1: `EMPLOYEE` or `REVIEWER`.

### Employee

An Employee can:

- create a request;
- edit their own request while it is in `DRAFT`;
- submit their own `DRAFT` request for review;
- view their own requests and their current status.

An Employee can read only their own requests.

### Reviewer

A Reviewer can:

- view requests waiting for review;
- inspect request details;
- approve a submitted request;
- reject a submitted request with a mandatory rejection comment.

A Reviewer can read requests with status `SUBMITTED`, `APPROVED` or `REJECTED`.
A Reviewer cannot access any `DRAFT` request.

---

## Demo users

The application contains these fixed users. They are synthetic demo identities.

| User ID      | Name        | Role       |
| ------------ | ----------- | ---------- |
| `emp-alex`   | Alex Morgan | `EMPLOYEE` |
| `emp-sam`    | Sam Rivera  | `EMPLOYEE` |
| `rev-jordan` | Jordan Lee  | `REVIEWER` |

---

## Request entity

The Request API representation contains:

| Field           | Description                                                                          |
| --------------- | ------------------------------------------------------------------------------------ |
| `id`            | Unique identifier assigned on creation                                               |
| `title`         | See [Validation rules](#validation-rules)                                            |
| `description`   | See [Validation rules](#validation-rules)                                            |
| `amount`        | JSON number; see [Validation rules](#validation-rules)                               |
| `requester`     | The Employee who created the request: `{ "id": "<user ID>", "name": "<name>" }`      |
| `status`        | One of the statuses in the [Status model](#status-model)                             |
| `reviewComment` | Always present: `null` until rejection, then the rejection comment                   |
| `createdAt`     | Set when the request is created; never changes                                       |
| `updatedAt`     | Set on creation; changes when the request is edited, submitted, approved or rejected |

Example:

```json
{
  "id": "<id>",
  "title": "Conference ticket",
  "description": "Ticket for the annual QA conference",
  "amount": 10.5,
  "requester": { "id": "emp-alex", "name": "Alex Morgan" },
  "status": "DRAFT",
  "reviewComment": null,
  "createdAt": "<timestamp>",
  "updatedAt": "<timestamp>"
}
```

### Client-writable fields

Only `title`, `description` and `amount` are client-writable.

The system-managed fields `id`, `requester`, `status`, `reviewComment`, `createdAt` and
`updatedAt` are never client-settable.

---

## Status model

```
DRAFT → SUBMITTED → APPROVED
                  ↘ REJECTED
```

Valid statuses:

- `DRAFT`
- `SUBMITTED`
- `APPROVED`
- `REJECTED`

`APPROVED` and `REJECTED` are terminal states. No transition leaves a terminal state.

Any transition not shown in the diagram is an invalid state transition (`409`).

---

## Validation rules

These rules apply wherever the field is accepted (creation, editing, rejection).

### Title

- Trimmed before validation; the trimmed value is stored.
- Required.
- 1–100 characters after trim.
- Whitespace-only is invalid.

### Description

- Trimmed before validation; the trimmed value is stored.
- Required.
- 1–1000 characters after trim.
- Whitespace-only is invalid.

### Amount

- Required.
- Must be a JSON number. A string is invalid: `10.5` is accepted, `"10.50"` is rejected.
- Greater than 0.
- Less than or equal to 100000.
- At most 2 decimal places.

API tests compare the numeric value of `amount`. They must not depend on textual decimal
formatting (for example, `10.50` vs `10.5`).

### Rejection comment

- Mandatory when rejecting.
- Sent as the `comment` field of the rejection payload.
- Trimmed before validation; the trimmed value is stored as `reviewComment`.
- 1–500 characters after trim.
- Whitespace-only is invalid.

### Payload fields

- A payload containing a system-managed field or an unknown field returns `400` with
  `VALIDATION_ERROR`.
- Approval accepts no payload fields; any field sent to the approval endpoint returns `400`
  with `VALIDATION_ERROR`. Approval does not use a review comment in v1.

---

# Requirements

## REQ-001 — Create a request

An Employee must be able to create a new request.

`POST /api/requests`

### Acceptance criteria

- The payload accepts only `title`, `description` and `amount`.
- Title, description and amount are validated according to [Validation rules](#validation-rules).
- An invalid payload is not accepted, no request is created, and the API returns `400` with
  `VALIDATION_ERROR`.
- A successfully created request receives a unique ID.
- A newly created request has status `DRAFT` and `reviewComment` `null`.
- The authenticated Employee becomes the requester.
- `createdAt` and `updatedAt` are set at creation.
- Success returns `201` with the created Request.
- Only an Employee can create a request; a Reviewer receives `403` with `FORBIDDEN`.

---

## REQ-002 — Edit a draft request

An Employee must be able to edit their own request while it is in `DRAFT`.

`PATCH /api/requests/:id`

### Acceptance criteria

- The update is partial: any non-empty subset of `title`, `description` and `amount` may be
  provided. Fields not provided keep their current values.
- An empty payload `{}` returns `400` with `VALIDATION_ERROR`.
- A system-managed or unknown field returns `400` with `VALIDATION_ERROR`.
- Every provided field is validated according to [Validation rules](#validation-rules);
  an invalid value returns `400` with `VALIDATION_ERROR` and the request is not changed.
- Only the owner of a `DRAFT` request may edit it.
- Editing a request that is not in `DRAFT` returns `409` with `INVALID_STATE_TRANSITION`.
- An Employee attempting to edit another Employee's request receives `404` with `NOT_FOUND`.
- A Reviewer attempting to edit any request receives `403` with `FORBIDDEN`.
- A successful edit updates `updatedAt`.
- Success returns `200` with the updated Request.

---

## REQ-003 — Submit a request

An Employee must be able to submit their own `DRAFT` request for review.

`PATCH /api/requests/:id/submit`

### Acceptance criteria

- Only a `DRAFT` request can be submitted; submitting a request in any other status returns
  `409` with `INVALID_STATE_TRANSITION`.
- Submission changes the status from `DRAFT` to `SUBMITTED`.
- Submission updates `updatedAt`.
- Success returns `200` with the updated Request.
- A submitted request appears in the review queue (REQ-004).
- A submitted request can no longer be edited by the requester (REQ-002).
- An Employee attempting to submit another Employee's request receives `404` with `NOT_FOUND`.
- A Reviewer attempting to submit any request receives `403` with `FORBIDDEN`.

---

## REQ-004 — Review queue

A Reviewer must be able to see requests waiting for review.

`GET /api/review-queue`

### Acceptance criteria

- The review queue contains all requests with status `SUBMITTED`, from all Employees.
- Requests with status `DRAFT`, `APPROVED` or `REJECTED` are not present in the review queue.
- Success returns `200` with `{ "items": [ <Request>, ... ] }`, ordered by `createdAt`
  descending (newest first).
- The Reviewer can open a request from the queue and inspect its details.
- Only a Reviewer can access the review queue; an Employee receives `403` with `FORBIDDEN`.

---

## REQ-005 — Approve a request

A Reviewer must be able to approve a submitted request.

`PATCH /api/requests/:id/approve`

### Acceptance criteria

- The endpoint accepts no payload fields; any field sent returns `400` with
  `VALIDATION_ERROR`.
- Only a `SUBMITTED` request can be approved; approving a request with status `APPROVED` or
  `REJECTED` returns `409` with `INVALID_STATE_TRANSITION`.
- Approving a `DRAFT` request returns `404` with `NOT_FOUND`, because `DRAFT` requests are
  not visible to Reviewers.
- Approval changes the status to `APPROVED`.
- Approval updates `updatedAt`.
- Approval leaves `reviewComment` as `null`.
- Success returns `200` with the updated Request.
- `APPROVED` is a terminal state.
- Only a Reviewer can approve; an Employee receives `403` with `FORBIDDEN`.
- The final status is visible through both UI and API.

---

## REQ-006 — Reject a request

A Reviewer must be able to reject a submitted request.

`PATCH /api/requests/:id/reject`

### Acceptance criteria

- The payload accepts only `comment`; a system-managed or unknown field returns `400` with
  `VALIDATION_ERROR`.
- Only a `SUBMITTED` request can be rejected; rejecting a request with status `APPROVED` or
  `REJECTED` returns `409` with `INVALID_STATE_TRANSITION`.
- Rejecting a `DRAFT` request returns `404` with `NOT_FOUND`, because `DRAFT` requests are
  not visible to Reviewers.
- A rejection comment is mandatory and is validated according to
  [Validation rules](#rejection-comment); an invalid or missing comment returns `400` with
  `VALIDATION_ERROR` and the request is not changed.
- Rejection changes the status to `REJECTED` and stores the comment as `reviewComment`.
- Rejection updates `updatedAt`.
- Success returns `200` with the updated Request.
- `REJECTED` is a terminal state.
- Only a Reviewer can reject; an Employee receives `403` with `FORBIDDEN`.
- The rejection comment is visible on the request details.
- The final status is visible through both UI and API.

---

## REQ-007 — Authorization

Business actions must respect the authenticated user's role and ownership.

### Acceptance criteria

- Employee-only actions (create, edit, submit, list own requests) performed by a Reviewer
  return `403` with `FORBIDDEN`.
- Reviewer-only actions (review queue, approve, reject) performed by an Employee return
  `403` with `FORBIDDEN`.
- An Employee can read and act on only their own requests. Another Employee's request is
  treated as non-existent: `404` with `NOT_FOUND`.
- A Reviewer can read only `SUBMITTED`, `APPROVED` and `REJECTED` requests. A `DRAFT`
  request is treated as non-existent for a Reviewer: `404` with `NOT_FOUND`.
- When several errors apply, the [error precedence](#error-precedence) determines the
  response.
- Authorization must be enforced by the application, not only by hiding UI controls.

---

## REQ-008 — Request retrieval through API

A request must be retrievable through the API.

`GET /api/requests/:id`

### Acceptance criteria

- Success returns `200` with the Request, including `id`, `title`, `description`, `amount`,
  `requester`, `status`, `reviewComment`, `createdAt` and `updatedAt`.
- `reviewComment` is always present: `null` before rejection, the rejection comment after.
- Visibility follows REQ-007; a request that does not exist or is not visible to the
  authenticated user returns `404` with `NOT_FOUND`.
- The API state must reflect actions performed through the UI.

---

## REQ-009 — List own requests

An Employee must be able to view their own requests and their current status.

`GET /api/requests`

### Acceptance criteria

- The response contains all requests whose requester is the authenticated Employee, in any
  status.
- The response contains no requests belonging to other Employees.
- Success returns `200` with `{ "items": [ <Request>, ... ] }`, ordered by `createdAt`
  descending (newest first).
- Only an Employee can list requests; a Reviewer receives `403` with `FORBIDDEN`.

---

## REQ-010 — Demo authentication

Users authenticate with simple demo authentication. No password is required in v1.

`POST /api/auth/login`, `POST /api/auth/logout`

### Acceptance criteria

- A user logs in as one of the predefined [demo users](#demo-users) by sending their user ID:
  `{ "userId": "emp-alex" }`.
- Successful login returns `200` with the authenticated user
  (`{ "id": "emp-alex", "name": "Alex Morgan", "role": "EMPLOYEE" }`) and sets the session
  cookie.
- Successful logout returns `204` with an empty body and invalidates the session.
- After logout, the invalidated session is no longer authenticated.
- Every `/api/requests` and `/api/review-queue` endpoint requires an authenticated session;
  a request without a valid session returns `401` with `UNAUTHENTICATED`.

---

# API

## Endpoints

```
POST   /api/auth/login            public     REQ-010   200
POST   /api/auth/logout           any        REQ-010   204
POST   /api/requests              EMPLOYEE   REQ-001   201
GET    /api/requests              EMPLOYEE   REQ-009   200
GET    /api/requests/:id          both       REQ-008   200
PATCH  /api/requests/:id          EMPLOYEE   REQ-002   200
PATCH  /api/requests/:id/submit   EMPLOYEE   REQ-003   200
PATCH  /api/requests/:id/approve  REVIEWER   REQ-005   200
PATCH  /api/requests/:id/reject   REVIEWER   REQ-006   200
GET    /api/review-queue          REVIEWER   REQ-004   200
```

List responses use the shape `{ "items": [ <Request>, ... ] }`, ordered by `createdAt`
descending (newest first).

## Error response shape

All error responses use this body:

```json
{
  "error": {
    "code": "<MACHINE_READABLE_CODE>",
    "message": "<human-readable message>"
  }
}
```

`code` is stable and may be asserted by tests. `message` is informational and must not be
asserted exactly.

## HTTP status semantics and error codes

| Status | Code                       | Meaning                                                         |
| ------ | -------------------------- | --------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`         | Payload fails a validation rule, or contains a disallowed field |
| `401`  | `UNAUTHENTICATED`          | No valid authenticated session                                  |
| `403`  | `FORBIDDEN`                | Authenticated, but the user's role may not use this endpoint    |
| `404`  | `NOT_FOUND`                | Resource does not exist or is not visible to the user           |
| `409`  | `INVALID_STATE_TRANSITION` | Action is not allowed in the request's current status           |

## Error precedence

When multiple errors could apply, checks are evaluated in this order and the first failing
check determines the response:

1. `401` `UNAUTHENTICATED`
2. `403` `FORBIDDEN`
3. `404` `NOT_FOUND` (does not exist or is not visible)
4. `409` `INVALID_STATE_TRANSITION`
5. `400` `VALIDATION_ERROR`

State and authorization checks therefore happen before payload validation. For example,
editing an own `SUBMITTED` request with an invalid title returns `409`, and rejecting an
`APPROVED` request with an empty comment returns `409`.

---

# Out of Scope (v1)

- Production authentication.
- OAuth / SSO / JWT.
- Password authentication.
- Multi-role users (a user holding both `EMPLOYEE` and `REVIEWER`).
- Concurrent review or modification handling (for example, two Reviewers acting on the same
  request at the same time).
