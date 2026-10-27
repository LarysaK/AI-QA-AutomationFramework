# Planner Agent v1

The Planner proposes **test-planning additions** for one or more explicitly selected, approved
requirements: new test cases with **provisional** IDs, and suggested automation candidates among
the existing approved test cases. It follows [Agent Standard v2.0](../agents/standard/standard.md)
and [ADR-0001](adr/0001-ai-outside-test-runtime.md): **AI proposes, deterministic code validates,
a human approves.**

> **Status.** Planner v1 is implemented and tested **with a fake model only**. It is
> **offline-only**: it reads a recorded model output and makes no model call. **No live Planner
> run has been made**, and nothing it proposes has been approved or added to the test plan.

The Planner never changes the requirements, never rewrites, renumbers or removes an approved test
case, never writes the test plan and never approves its own proposal. It stages a proposal under
`artifacts/proposals/<taskId>/` (gitignored) for a human to review at gate **H1**, and stops.

Definition: [`agents/definitions/planner/definition.md`](../agents/definitions/planner/definition.md).
Code: [`agents/orchestrator/planner/`](../agents/orchestrator/planner/).

## Usage

```bash
npm run agents:plan -- --req REQ-009 \
  --fake-model-output agents/orchestrator/planner/fixtures/req-009-plan.json
npm run agents:plan -- --req REQ-007 --req REQ-009 --fake-model-output <recorded-output.json>
```

| Option                       | Meaning                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `--req REQ-NNN`              | An approved requirement to plan for; repeatable (at most 10)       |
| `--app <name>`               | Application under test; default `requestflow`                      |
| `--instruction "…"`          | Optional, non-authoritative guidance (at most 1,000 characters)    |
| `--fake-model-output <file>` | **Required in v1**: a recorded model output; no provider is called |

The fixture [`req-009-plan.json`](../agents/orchestrator/planner/fixtures/req-009-plan.json) is a
**hand-written** recorded output for the demonstration and the tests, not model output.

Exit codes: `0` READY staged, awaiting H1 · `2` usage or precondition stop (no model call) · `4`
model output rejected (no artifact) · `5` BLOCKED / NEEDS_HUMAN_DECISION staged.

## How it works

1. **Select** (deterministic): every requested requirement must exist in the approved
   requirements; malformed, duplicate or unknown IDs stop the run.
2. **Screen untrusted text**: requirement and test-plan sections are data, never instructions.
   Instruction-like text ("ignore previous instructions", "you are now", "authorize execution",
   "mark … as approved") or a context delimiter (`<approved-context>`, `<task>`) stops the run
   before anything is sent to a model.
3. **Context**: a deterministic pack of at most 64 KB, never truncated: selected Agent Standard
   sections, the shared requirement definitions, each requested requirement, the API contract,
   the test strategy and each requested requirement's approved test cases. The task lists every
   approved test case with its _Automation_ value and whether a committed test references it (a
   static fact, not proof of coverage). A manifest records each piece's path, section, bytes and
   Git blob SHA.
4. **Model call**: one call through the Generator's `ModelClient` interface. In v1 the client
   returns the recorded output; provenance records `modelCall: "offline-recorded-output"`.
5. **Check**: stop reason, JSON and the [output schema](../agents/definitions/planner/planner-output.schema.json),
   with the same parser as the Generator. Output is never repaired.
6. **Envelope**: a `test-plan-proposal` artifact. The orchestrator owns identity, traceability,
   `sourceReferences`, `proposedChanges` (always empty) and provenance; the model owns the
   status, summary, proposals, candidates, assumptions, findings and context requests.
7. **Guards, in process**: G-SCHEMA (the envelope and the
   [Planner payload schema](../agents/definitions/planner/planner-payload.schema.json)), G-PATHS,
   G-BASE and G-TRACE with the Planner rules PLN-001 – PLN-006. Any failure rejects the proposal:
   its reasons are recorded in `rejection.json`, and no `artifact.json` is staged.
8. **Stage**: `artifact.json`, `request.json`, `response.json`, `validation-1.txt` and
   `status.json` (`pipelineStatus: STAGED`, `reviewGate: H1`, `humanReview: pending`), after a
   secret scan.

## Output contract

| Part                           | Content                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traceability.requirements`    | The requested requirements                                                                                                                                                                                          |
| `traceability.testCases`       | Only **approved** test cases the proposal cites (related test cases, automation candidates)                                                                                                                         |
| `payload.proposedTestCases`    | **New, not approved** test cases: `provisionalId` (`PTC-NNN-NN`), `requirementId`, `scenario`, `level`, `type`, `priority`, `automationCandidate`, `rationale`, `acceptanceCriteria` (verbatim), `relatedTestCases` |
| `payload.automationCandidates` | **Existing approved** test cases suggested for automation, with a rationale                                                                                                                                         |
| `payload` provenance           | `modelCall`, `requestedModel`, `servedModel`, `effort`, `maxTokens`, `definitionVersion`, `requestedRequirements`, `reviewGate: "H1"`                                                                               |
| `proposedChanges`              | Always empty: the Planner proposes no file changes                                                                                                                                                                  |

Existing approved test cases, proposed new test cases and automation candidates are kept apart:
an approved test case is only ever referenced by ID.

## Validation and safety boundaries

| Rule    | The Planner rejects                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema  | Malformed or incomplete output, extra fields (for example `"approved": true`), unknown statuses (for example `APPROVED`), invalid ID formats                                                                                                |
| PLN-001 | Any proposed file change                                                                                                                                                                                                                    |
| PLN-002 | Unknown or not-requested requirements, duplicate or mis-numbered provisional IDs, acceptance criteria that the requirement does not state verbatim                                                                                          |
| PLN-003 | Unknown or out-of-scope test-case references; scenarios that restate an approved test case or another proposal; candidates marked _Automation: No_, already referenced by a committed test, or listed twice                                 |
| PLN-004 | Claims or requests of approval, authorization or execution: a passed gate, an approved plan, `--authorize-execution`, "authorize execution", claimed test runs or results, commands to run tests, orchestrator statuses such as `VALIDATED` |
| PLN-005 | A READY proposal with nothing in it, or a BLOCKED / NEEDS_HUMAN_DECISION proposal that still proposes                                                                                                                                       |
| PLN-006 | Inconsistent provenance: requested requirements, cited sources, offline markers, traceability                                                                                                                                               |

The same rules run in `npm run agents:validate` for any Planner artifact. A schema-valid,
rule-conforming proposal is **not** an approved plan: it is only eligible for human review.

## H7 and execution

A plan proposal contains no code, so there is nothing to execute. The Planner never requests or
supplies execution authorization. `agents:validate` on a Planner artifact runs the guards that
apply, reports G-DISCOVERY and G-RUN as not authorized (H7 closed), and, because the artifact
proposes no files, says that execution must not be authorized instead of offering a command.

## Review at H1

A human reviews the staged `artifact.json`. There is no apply workflow: an accepted proposal is
transcribed into `specs/<app>/test-plan.md` by a human, in an ordinary reviewed commit, with
approved `TC-NNN-NN` IDs replacing the provisional ones.

## Tests

```bash
npm run agents:test                                            # the whole agent suite
npx tsx --test agents/orchestrator/planner/planner.test.ts      # the Planner tests only
```

All Planner tests use injected fake model responses; no provider is contacted, the approved
repository is only read (its fingerprint is compared before and after), and content-altering
cases (prompt injection) run on temporary copies.

## Limitations

- Offline only; no live Planner run has been made, so real-model planning quality is unverified.
- No apply workflow: H1 approval and transcription into the test plan are manual.
- PLN-004 is pattern-based defense in depth; the structural guarantee is that no field of the
  contract can carry an approval or an authorization. The human reviewer remains responsible.
- The untrusted-text screen is pattern-based; it rejects suspicious approved content rather than
  trying to interpret it.
- Related test cases must belong to a requested requirement (for example, REQ-007's matrix cases
  owned by other requirements need those requirements requested too).
