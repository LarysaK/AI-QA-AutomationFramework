# L. Defect Management and Reporting

## Current state (verified)

- **No defect register exists** in the repository, and no defect tracker is connected. There are
  **no defect records**, open or closed.
- An empty defect list is **not** evidence that RequestFlow has no defects. It means only that no
  verified defect records exist.
- No test is marked `test.fail`, `test.fixme` or skipped for a known defect.
- At the audit commit, every committed Playwright test passed in CI run #23. After M10B, 63 of 96
  test cases are not covered by a fully consistent automated test (61 not yet automated, 2 manual
  by design). Unknown defects may exist in the untested behaviour.
- **One unconfirmed observation awaits human triage** and is not a defect record: an unparsable
  JSON body on an endpoint the caller's role may not use is expected, from the source, to return
  `400` rather than `403`; the requirements do not define whether that case falls under the
  error precedence ([M](13-limitations-risks-and-roadmap.md), finding 10).

## What is not a defect here

| Signal                                | Why it is not a defect record                                                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A failed CI test                      | An execution result for one commit. It may reveal a product defect, a test defect or an environment problem; only human triage decides.                                                                                                                                                  |
| A CI run without a published record   | Says nothing about the product (see [J](10-ci-cd-history-and-reconciliation.md)).                                                                                                                                                                                                        |
| An agent's `defect-candidate` finding | When the application contradicts a requirement, an agent records a `defect-candidate` finding and must never adapt the expected result ([Agent Standard STD-SRC-002](../agents/standard/standard.md#3-sources-of-truth)). It awaits human triage; proposals stay outside the repository. |
| A test case marked _Automation: No_   | A plan decision, not a gap or a defect.                                                                                                                                                                                                                                                  |

## Defect severity and the source of truth

Expected behaviour always comes from [Requirements v1.2](../specs/requestflow/requirements.md),
never from what the application currently does (Agent Standard §3). A discrepancy is a defect of
the application only if the requirement states the point explicitly. Behaviour the requirements
do not define (for example TC-010-08, the UI redirect to `/login`) is documented, not judged.

## Dashboard contract for a future register

The Defects view is ready for a verified source without a fake backend:
[`reporting/dashboard/src/data/defects.ts`](../reporting/dashboard/src/data/defects.ts) defines
the record format and a validator. A record is shown only if it has the source system's own key,
its status and severity **verbatim**, an `https` link or none, timestamps in UTC, and
requirement and test-case IDs that exist in the approved documents. An invalid register is not
shown at all. The current build passes "not connected".

## Recommended process (recommendation, not yet adopted)

1. **Detect.** A failed CI test, a failed manual check ([F](06-manual-testing-guide.md)) or an
   agent's `defect-candidate` finding raises a _candidate_.
2. **Triage** (human): reproduce on the commit concerned; compare with the requirement; classify
   as product defect, test defect, environment problem or requirement gap.
3. **Record** a product defect in a tracker with: tracker key, title, status, severity, the
   requirement and test-case IDs, the commit and CI run (or manual record), steps to reproduce,
   expected (quoted requirement) and actual result. Never record secrets or personal data.
4. **Link** the failing test case by ID. Do not weaken or skip the test to make CI pass; if a
   test must be quarantined, record why and for how long.
5. **Fix and verify** through a pull request; the next published CI record is the evidence.
6. **Report** through the dashboard once a register export is connected and validated.

Severity scheme, if a tracker without its own is used (recommendation): **Critical** (data loss,
authorization bypass, or a P0 workflow blocked), **Major** (a P0/P1 rule violated with a
workaround), **Minor** (a P2 contract detail), **Trivial** (cosmetic, outside the requirements).
