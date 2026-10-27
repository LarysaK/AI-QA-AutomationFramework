# M. Known Limitations, Risks and Future Roadmap

## Inconsistencies found by this audit

Each item is verified against the audit commit `7624640`. Findings 4 and 5, and the README part of finding 6, are resolved by the root README update in this documentation change; nothing else was changed.

| #   | Finding                                                                                                                                                                                                                                                                                       | Where                                                                                                                                                            | Suggested resolution (recommendation)                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | **TC-002-02 deviates from its test.** The scenario is a partial `PATCH` with only `amount`; the linked test patches only `title`. It also asserts `updatedAt` as different, not strictly later (plan §1.3).                                                                                   | [plan](../specs/requestflow/test-plan.md#req-002--edit-a-draft-request), [`edit-draft-request.spec.ts`](../tests/requestflow/api/edit-draft-request.spec.ts#L32) | Human decision: align the test or revise the scenario in a new plan revision  |
| 2   | **Test plan exit criterion not met.** "All other P0 scenarios either automated or explicitly scheduled": 34 of 38 P0 test cases are neither, and no schedule exists.                                                                                                                          | plan §5                                                                                                                                                          | Schedule the P0 API cases (REQ-007, REQ-009, REQ-010 first)                   |
| 3   | **Three requirements have no automated test case:** REQ-007 (Authorization), REQ-009 (List own requests), REQ-010 (Demo authentication); all their per-endpoint `401`/`403`/`404` cases are unautomated.                                                                                      | [B](02-requirements-and-traceability.md)                                                                                                                         | Prioritize; most are cheap, deterministic API tests                           |
| 4   | **The root README contradicts itself:** it says the Generator agent "does not exist yet" while listing Generator v1 as implemented.                                                                                                                                                           | [`README.md`](../README.md) "Test design and canonical tests"                                                                                                    | **Resolved** in this change                                                   |
| 5   | **The root README is behind the repository:** "Phase 0 (in progress)", no mention of CI history, reconciliation or the dashboard; `framework/`, `prompts/` and `integrations/` are described as working layers but contain only `.gitkeep`.                                                   | [`README.md`](../README.md)                                                                                                                                      | **Resolved** in this change                                                   |
| 6   | **Approved architecture not yet in the contracts:** the owner approved Planner, Generator and Healer plus the deterministic Validator, without an Analyzer; the Standard, envelope schema, validator types and Dashboard still list the Analyzer (the root README is updated in this change). | see [I](09-ai-agent-architecture-and-guardrails.md#approved-architecture-change-pending-implementation)                                                          | A controlled Standard revision, then README and Dashboard                     |
| 7   | **Node.js ranges disagree:** root `engines` allows Node 20 and 22.13; the dashboard and CI need 22.22.2 or later.                                                                                                                                                                             | [`package.json`](../package.json), [`ci.yml`](../.github/workflows/ci.yml)                                                                                       | Align the root `engines` or document the stricter need                        |
| 8   | **Test cases have no titles.** The plan's scenario sentence is the only description; long scenarios make reports harder to read.                                                                                                                                                              | plan §2                                                                                                                                                          | Optional: short titles in a future structured test-case format (Standard §16) |
| 9   | **Minor assertion gap:** TC-001-09 says amounts are "stored with the same numeric value"; the test checks the create response, not a read-back.                                                                                                                                               | [`create-request-validation.spec.ts`](../tests/requestflow/api/create-request-validation.spec.ts#L113)                                                           | Add a `GET` read-back, as the trimming rows do                                |

No duplicate test-case IDs, orphan tests, unknown tags or broken TC/REQ tag pairs were found.

## Limitations

- **Coverage.** 20 of 96 test cases are automated and consistent (21 linked by tags); 73 are not
  yet automated; 2 are manual by design. P0 coverage is 4 of 38.
- **Shared state.** All tests share one in-memory server; empty-list scenarios cannot be automated
  deterministically.
- **One browser.** Only the `chromium` project is configured.
- **Manual results.** There is no store for manual execution results; none are recorded.
- **Defects.** No register or tracker; see [L](12-defect-management-and-reporting.md).
- **AI.** The Generator has never run against a live model; real output quality is unverified.
  H7 is a human checkpoint, not a sandbox. Authorizations are not audited.
- **CI history.** Seven early CI runs predate the publisher and will never have records.
  Publication needs a human approval per run.
- **Dashboard.** Published on GitHub Pages (owner-confirmed; first automatic deployment observed). It refreshes only after a published CI history record or a manual run, so it can lag behind `main`; GitHub Pages cannot prevent framing.

## Risks

Likelihood and impact are this audit's assessment, not measured values.

| Risk                                                       | Likelihood      | Impact | Mitigation in place                                                                                                          |
| ---------------------------------------------------------- | --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Undetected authorization defects (REQ-007 unautomated)     | Medium          | High   | Server-side checks exist in the AUT; tests are planned in TC-007-_, TC-00x-_                                                 |
| Reading tag linkage as full coverage                       | Medium          | Medium | Dashboard and this catalog separate _linked_ from _executed_ and flag TC-002-02                                              |
| Generated tests weakening assertions once AI is used       | Low today       | High   | Guards, Protected paths, no `@CAN` from agents, human H2; an assertion-weakening guard (G-ASSERT) is deferred (Standard §16) |
| Proposed code running with the user's permissions under H7 | Low (H7 closed) | High   | Per-artifact SHA-256 authorization; never in CI                                                                              |
| Stale documentation after changes                          | Medium          | Medium | Catalog and matrix name their commit; regenerate after changes                                                               |

## Roadmap (planned; nothing below is implemented)

1. **Automation of the approved inventory**: P0 API cases first (REQ-007, REQ-009, REQ-010,
   then the remaining REQ-001 – REQ-006 authorization and contract cases), then P1 and UI cases.
2. **Resolve findings 1 and 7** above.
3. **Agent architecture revision**: Planner, Generator, Healer and the deterministic Validator,
   without a separate Analyzer (approved), through a new Agent Standard version with the matching
   envelope schema, validator types and Dashboard changes.
4. **First live Generator run**, reviewed by a human, with its provenance recorded; H7 opened
   only per artifact, by a human.
5. **Planner agent**, then **Healer agent** with an assertion-weakening guard.
6. **Proposal approval and apply workflow** (H2) with an audited record of approvals.
7. **GitHub Pages**: done (merged in pull request #11; live, owner-confirmed). Remaining: observe further automatic refreshes and confirm the `github-pages` environment branch rule.
8. **Isolated test state** to automate TC-004-07 and TC-009-05.
9. **Defect tracker integration** behind the existing dashboard contract.
10. **Shared framework layer** (`framework/`) and further applications under test.
