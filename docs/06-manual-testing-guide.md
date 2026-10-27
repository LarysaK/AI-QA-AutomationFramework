# F. Manual Testing Guide

How to execute an approved test case by hand, and how to record the result. Use it for the two
test cases that are **manual by design** (TC-004-07, TC-009-05), for exploratory checks, and for
any _not yet automated_ case that must be verified before it is automated.

> **Evidence status.** The repository contains **no recorded manual execution results**. Nothing
> in this package claims that any test case was executed manually.

## 1. Start the application

```bash
npm install
npm run aut:start
```

RequestFlow listens on `http://127.0.0.1:3100` (change it with `HOST` and `PORT`). Check
readiness with:

```bash
curl -i http://127.0.0.1:3100/health        # 200 {"status":"ok"}
```

State is held in memory. **Restarting the server is the only way to start from an empty
state.** The reset hook `POST /__test/reset` exists only when the server runs with
`REQUESTFLOW_TEST_HOOKS=1` (set by Playwright for automated runs); it is test infrastructure, not
part of the RequestFlow API, and must not be used as product behaviour.

## 2. Users

No passwords. On the login page, choose a button: **Log in as Alex Morgan**, **Log in as Sam
Rivera** or **Log in as Jordan Lee**. Through the API, send the user ID:

| User        | User ID      | Role     | Start page after login         |
| ----------- | ------------ | -------- | ------------------------------ |
| Alex Morgan | `emp-alex`   | EMPLOYEE | My requests (`/requests`)      |
| Sam Rivera  | `emp-sam`    | EMPLOYEE | My requests (`/requests`)      |
| Jordan Lee  | `rev-jordan` | REVIEWER | Review queue (`/review-queue`) |

Use one browser profile (or a private window) per user to keep two sessions at once.

## 3. UI orientation

| Page            | Path                 | Main controls                                                                                                                   |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Login           | `/login`             | one button per demo user                                                                                                        |
| My requests     | `/requests`          | table of own requests; **New request**                                                                                          |
| New request     | `/requests/new`      | **Title**, **Description**, **Amount**; **Save draft**                                                                          |
| Request details | `/requests/:id`      | fields; **Edit** and **Submit for review** (owner, DRAFT); **Approve**, **Rejection comment**, **Reject** (Reviewer, SUBMITTED) |
| Edit request    | `/requests/:id/edit` | the same fields; **Save changes**                                                                                               |
| Review queue    | `/review-queue`      | table of SUBMITTED requests                                                                                                     |
| Any page        | —                    | **Log out**                                                                                                                     |

The UI layout is not part of the requirements; check business outcomes, not styling.

## 4. API calls with curl

The session is a cookie named `rf_session`. Keep one cookie jar per user:

```bash
BASE=http://127.0.0.1:3100

# Log in (REQ-010)
curl -s -c alex.txt -H 'content-type: application/json' \
  -d '{"userId":"emp-alex"}' $BASE/api/auth/login

# Create a request (REQ-001); amount is a JSON number
curl -s -b alex.txt -H 'content-type: application/json' \
  -d '{"title":"Conference ticket","description":"Annual QA conference","amount":120.5}' \
  $BASE/api/requests

# Read it back (REQ-008), list own requests (REQ-009)
curl -s -b alex.txt $BASE/api/requests/<id>
curl -s -b alex.txt $BASE/api/requests

# Edit (REQ-002), submit (REQ-003)
curl -s -b alex.txt -X PATCH -H 'content-type: application/json' -d '{"amount":99}' $BASE/api/requests/<id>
curl -s -b alex.txt -X PATCH $BASE/api/requests/<id>/submit

# As Jordan: review queue (REQ-004), approve (REQ-005) or reject (REQ-006)
curl -s -c jordan.txt -H 'content-type: application/json' -d '{"userId":"rev-jordan"}' $BASE/api/auth/login
curl -s -b jordan.txt $BASE/api/review-queue
curl -s -b jordan.txt -X PATCH $BASE/api/requests/<id>/approve
curl -s -b jordan.txt -X PATCH -H 'content-type: application/json' -d '{"comment":"Missing receipt"}' $BASE/api/requests/<id>/reject

# Log out
curl -s -i -b alex.txt -X POST $BASE/api/auth/logout      # 204, empty body
```

Use `-i` to see the status code. Assert **status and `error.code`** only; `error.message` is
informational (plan §1.3).

## 5. Executing a test case

1. Open the test case in the [catalog](04-test-case-catalog.md): it lists the scenario (verbatim),
   preconditions, steps and expected result.
2. Prepare the preconditions **through the API** unless the UI flow is under test (plan §1.4).
   Use a unique title per test case, so other activity does not interfere.
3. Perform the steps; for data-driven cases, execute and record **each data row**.
4. For every negative case on an existing request, read the request back with
   `GET /api/requests/:id` and confirm that nothing changed (plan §1.1, principle 6).
5. Compare with the expected result exactly as written: status code, `error.code`, field values,
   ordering rules (`createdAt` descending) and timestamp rules (`updatedAt` strictly later).

### The two manual-by-design cases

| Test case | Setup                                                                | Check                                                  |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| TC-004-07 | Restart the server; create nothing; log in as Jordan                 | `GET /api/review-queue` → `200` with `{ "items": [] }` |
| TC-009-05 | Restart the server; log in as an Employee who has created no request | `GET /api/requests` → `200` with `{ "items": [] }`     |

Run them before any other activity on the freshly started server.

## 6. Recording a result

The repository has no test-management tool or result store for manual runs. Until one exists,
record each execution with at least:

| Field                     | Example                                            |
| ------------------------- | -------------------------------------------------- |
| Test case                 | `TC-004-07`                                        |
| Requirement               | `REQ-004`                                          |
| Commit tested             | output of `git rev-parse HEAD`                     |
| Environment               | `npm run aut:start` on Node 22.x, macOS / Linux    |
| Data row (if data-driven) | `amount 0`                                         |
| Result                    | Passed / Failed / Blocked                          |
| Actual result             | `200 {"items":[]}`                                 |
| Evidence                  | request and response text; screenshot for UI cases |
| Tester and date           | name, ISO date                                     |

**Recommendation:** keep manual records outside the source tree (for example in a test-management
tool), never present them as CI results, and treat a failed check as a **defect candidate** for
triage (see [L](12-defect-management-and-reporting.md)), not as a confirmed defect.
