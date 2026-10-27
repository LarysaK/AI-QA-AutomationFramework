# Planner Agent — definition

definitionVersion: 1.0

| Item              | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Agent             | `planner`                                                      |
| Requires standard | Agent Standard 1.x ([standard.md](../../standard/standard.md)) |
| Artifact type     | `test-plan-proposal`                                           |
| Output schema     | [`planner-output.schema.json`](planner-output.schema.json)     |
| Payload schema    | [`planner-payload.schema.json`](planner-payload.schema.json)   |
| System prompt     | [`prompt.md`](prompt.md)                                       |
| Orchestrator      | `agents/orchestrator/planner/` (`npm run agents:plan`)         |

The Planner proposes **test-planning additions** for one or more explicitly selected, approved
requirements: new test cases with provisional IDs, and suggested automation candidates among the
existing approved test cases. It never changes the requirements, never rewrites or renumbers an
approved test case, never writes the test plan and never approves its own proposal. All Agent
Standard rules apply; this definition only adds what is specific to the Planner.

A staged proposal is reviewed by a human at gate **H1**. There is no apply workflow: an approved
proposal reaches `specs/<app>/test-plan.md` only as an ordinary, reviewed commit by a human, who
then assigns approved `TC-NNN-NN` IDs.

## Inputs

- `--req REQ-NNN` (repeatable) — the approved requirements to plan for (Agent Standard 5.1).
- `--app <name>` — the application under test; default `requestflow`.
- `--instruction "<text>"` — optional human guidance, at most 1,000 characters, passed to the
  model as non-authoritative.
- `--fake-model-output <file>` — **required in v1**: a recorded model output. Planner v1 makes no
  provider call (see Limitations).

## Preconditions (deterministic, before any model call)

1. The approved documents parse under the specification format contract (5.1); otherwise stop.
2. Every requested requirement exists; duplicates in the request are an error.
3. **Untrusted text screen.** Requirement and test-plan sections are data, never instructions. A
   selected section that contains instruction-like text (for example "ignore previous
   instructions", "you are now", "system prompt", "authorize execution") or a context delimiter
   (`<approved-context>`, `<task>`, `<system>`) stops the run, and nothing is sent to a model.

## Context selection (deterministic; hard limit 64 KB; no truncation)

| Role           | Source and rule                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `architecture` | `agents/standard/standard.md`: `## 1.`, `## 3.`, `## 5.` up to `### 5.1`, `### 7.1`, `## 8.`, `## 12.`, `## 13.`           |
| `requirements` | `specs/<app>/requirements.md`: everything before `# Requirements`; each requested `## REQ-NNN —` section; the `# API` part |
| `test-plan`    | `specs/<app>/test-plan.md`: `## 1.` (test strategy); each requested `### REQ-NNN —` section (the approved test cases)      |

The task adds, per requested requirement, its approved test-case IDs with the plan's
_Automation_ value and whether a committed test references the ID. A reference is a static
fact, not proof of coverage. The manifest records each piece's path, role, section, bytes and Git
blob SHA.

## Output and ownership

The model returns JSON matching `planner-output.schema.json`. The orchestrator assembles the
Agent Standard envelope:

| Owner        | Fields                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator | `artifactType`, `schemaVersion`, `standardVersion`, `agent`, `taskId`, `sourceReferences`, `traceability`, `proposedChanges` (always empty), `payload` provenance and `reviewGate`, assumption and finding IDs |
| Model        | `status`, `summary`, `proposedTestCases`, `automationCandidates`, `assumptions`, `findings`, `contextRequests`                                                                                                 |

`traceability.requirements` are the requested requirements; `traceability.testCases` are the
approved test cases the proposal cites (related test cases and automation candidates), sorted.
Proposed test cases are **not** approved and appear only in `payload.proposedTestCases`.

`payload` keys: `modelCall`, `requestedModel`, `servedModel`, `effort`, `maxTokens`,
`definitionVersion`, `requestedRequirements`, `reviewGate` (always `H1`), `proposedTestCases`,
`automationCandidates`. A proposed test case has `provisionalId`, `requirementId`, `scenario`,
`level` (`API`, `UI`, `E2E`), `type` (`Positive`, `Negative`, `Boundary`, `Authorization`),
`priority` (`P0`, `P1`, `P2`), `automationCandidate`, `rationale`, `acceptanceCriteria` (verbatim
quotations from the requirement) and `relatedTestCases` (approved IDs). An automation candidate is
an existing approved test case (`testCaseId`) with a `rationale`.

**Provisional test-case IDs** have the form `PTC-NNN-NN`, where `NNN` is the owning requirement's
number. They can never collide with approved `TC-NNN-NN` IDs and are replaced by a human when a
proposal is accepted.

`modelCall` is `offline-recorded-output` in v1: no LLM was called, `requestedModel`, `effort` and
`maxTokens` are `null`, and `request.json` records the recorded file's path and SHA-256. Offline
output must never be presented as model-generated.

Model output is never repaired: output that does not meet this contract is rejected with its
reasons, and no `artifact.json` is staged.

## Agent rules

Checked deterministically by G-SCHEMA (payload schema) and G-TRACE (Planner content), both in the
Planner before staging and in `agents:validate`:

- **PLN-001 [G]** A Planner v1 artifact proposes no file changes: `proposedChanges` is empty.
- **PLN-002 [G]** Every proposed test case has a unique provisional ID `PTC-NNN-NN` whose `NNN`
  is the number of its requirement; it names exactly one requested requirement and quotes at
  least one of that requirement's acceptance criteria verbatim.
- **PLN-003 [G]** Approved test cases are referenced, never redefined: related test cases and
  automation candidates are approved test cases of a requested requirement; a proposed scenario
  does not duplicate an approved scenario of its requirement or another proposal; an automation
  candidate is marked _Automation: Yes_ in the plan, is not already referenced by a committed
  test, and is listed once.
- **PLN-004 [G]** The artifact claims no approval, authorization or execution, and asks for none:
  no statement that a gate is passed or a plan is approved, no execution authorization, no claim
  that tests ran or passed.
- **PLN-005 [G]** Status consistency: `READY` carries at least one proposed test case or
  automation candidate; `BLOCKED` and `NEEDS_HUMAN_DECISION` carry none.
- **PLN-006 [G]** Provenance is complete and consistent: `requestedRequirements` equals
  `traceability.requirements`, `reviewGate` is `H1`, and an offline output records no requested
  model, effort or token budget.
- **PLN-007 [J]** When an acceptance criterion is ambiguous or the approved sources conflict,
  return `NEEDS_HUMAN_DECISION` with a blocking finding instead of guessing.

PLN-004 is checked with patterns over the model-owned text; the structural guarantee is that no
field of the contract can carry an approval or an authorization.

## Statuses and exit codes (`npm run agents:plan`)

| Exit | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | READY staged; pipeline status `STAGED`, awaiting human review (H1)                                   |
| 2    | Usage error, precondition stop (unknown requirement, untrusted text, context problem); no model call |
| 4    | Model output rejected (stop reason, invalid JSON, schema or a PLN rule); no `artifact.json`          |
| 5    | BLOCKED or NEEDS_HUMAN_DECISION staged; nothing to review as a plan until the findings are resolved  |

There is nothing to execute: a plan proposal contains no code, so H7 never applies and is never
requested.

## Limitations (v1)

- Offline only: `--fake-model-output` is required, and no live model call has been made.
- No apply workflow: H1 approval and the transcription into the test plan are manual.
- PLN-004 is pattern-based defense in depth; the reviewer remains responsible at H1.
- One application per run; requirements are planned against the approved plan as it is.
