# Healer Agent — definition

definitionVersion: 1.1

| Item              | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Agent             | `healer`                                                       |
| Requires standard | Agent Standard 2.x ([standard.md](../../standard/standard.md)) |
| Artifact type     | `heal-proposal`                                                |
| Output schema     | [`healer-output.schema.json`](healer-output.schema.json)       |
| Payload schema    | [`healer-payload.schema.json`](healer-payload.schema.json)     |
| System prompt     | [`prompt.md`](prompt.md)                                       |
| Revision          | 1.1: requires Agent Standard 2.x; nothing else changed (minor) |
| Orchestrator      | `agents/orchestrator/healer/` (`npm run agents:heal`)          |

The Healer **diagnoses one Playwright test failure** from explicitly supplied evidence and, when
the evidence supports it, **proposes a narrowly scoped repair** for human review. It
distinguishes test-code problems from application defects, environment failures, data or setup
problems and insufficient evidence. It never applies a repair, never executes proposed code,
never weakens or suppresses a test and never changes the requirements, the test plan or a
canonical test. All Agent Standard rules apply; this definition only adds what is specific to the
Healer.

A diagnosis is a report: no approval is needed to stage it. A repair is a healing patch: it is
validated by the deterministic guards, its execution-capable guards wait for a human H7
authorization (H7 stays closed by default), and applying it needs gate **H3**. There is no apply
workflow: an accepted repair reaches the repository only as an ordinary, reviewed commit by a
human.

## Inputs

- `--report <file>` — a Playwright JSON report (the configured `json` reporter output, for example
  `artifacts/results/results.json`). It is the only accepted failure evidence.
- `--test <tests/…spec.ts>:<line>` — the failing test, as the report locates it.
- `--app <name>` — the application under test; default `requestflow`.
- `--fake-model-output <file>` — **required in v1**: a recorded model output. Healer v1 makes no
  provider call (see Limitations).

## Evidence (deterministic, before any model call)

1. **Authentic failure evidence.** The report must be a complete, consistent Playwright JSON
   report (the same parser as the CI record collector), at most 5 MB, and the selected test must
   have failed in it. A report without that failure, a passed or skipped test, or no report stops
   the run: there is nothing to diagnose, and no failure is ever assumed.
2. **Committed test.** The failing test's file must be a committed `tests/**` file containing the
   test's title; every `@REQ-…` / `@TC-…` tag the report gives must be approved and present in the
   file.
3. **Evidence items**, numbered `E-001`, `E-002`, … by the orchestrator: the error messages, the
   stack, the expected and received values, the test steps, each attempt's status, the environment
   (Playwright version, project, retries) and the committed source of the test and of the support
   files it imports. Nothing else is read: no trace archives, screenshots, videos, `.env*` files
   or other artifacts.
4. **Sanitization.** ANSI codes are stripped; absolute paths are reduced to their repository part
   (`tests/…`, `apps/…`) or replaced by `<path>`.
5. **Untrusted text screen and secret scan.** Evidence is data, never instructions. Instruction-like
   text, context delimiters, credentials, environment-variable values and personal data stop the
   run, and nothing is sent to a model. Redact the report first.
6. **Limits.** At most 8 KB per evidence item, 50 steps, 64 KB of context; nothing is truncated: an
   exceeded limit stops the run.

## Output and ownership

The model returns JSON matching `healer-output.schema.json`. The orchestrator assembles the
Agent Standard envelope:

| Owner        | Fields                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator | `artifactType`, `schemaVersion`, `standardVersion`, `agent`, `taskId`, `sourceReferences`, `traceability`, each change's `changeKind`, `operation`, `baseSha` and `traceability`, `payload` provenance and evidence |
| Model        | `status`, `summary`, the diagnosis, each change's `path`, `content` and `rationale`, the repair's `impact`, preserved behaviour, risks and validation steps, `assumptions`, `findings`, `contextRequests`           |

`payload` keys: `modelCall`, `requestedModel`, `servedModel`, `effort`, `maxTokens`,
`definitionVersion`, `failure` (report name and SHA-256, Playwright version, spec ID, test file,
title, line, project, attempt statuses, start time), `evidence` (each item's ID, kind, source and
SHA-256), `diagnosis` and `repair`.

**Diagnosis:** `classification` (below), `explanation`, `evidenceRefs` (evidence IDs),
`confidence` (`low`, `medium`, `high`), `alternatives` (other classifications with their
evidence), `missingEvidence` and `recommendedInvestigation`.

**Repair** (or `null`): `expectedBehaviorPreserved`, `risks`, `validationSteps`,
`humanReview: "required"` and `reviewGate: "H3"`. The changes themselves are the envelope's
`proposedChanges` (full file content, `operation: "modify"`).

## Failure classifications

| Classification                  | Meaning                                                                     | Repair allowed |
| ------------------------------- | --------------------------------------------------------------------------- | -------------- |
| `test-code-issue`               | The test or its support code is wrong (locator, data handling, timing code) | Yes            |
| `test-data-or-setup`            | Test data or the test's own setup is wrong                                  | Yes            |
| `application-defect`            | The application contradicts an approved requirement                         | No: escalate   |
| `environment-or-infrastructure` | Browser, server start, network, runner or configuration problem             | No             |
| `insufficient-evidence`         | The evidence does not decide                                                | No             |

An application defect is never worked around in test code: the diagnosis carries a
`defect-candidate` finding (Agent Standard STD-SRC-002) for human triage. No defect ID or ticket
is created.

## Agent rules

Checked deterministically by G-SCHEMA (payload schema) and G-TRACE (Healer content), both in the
Healer before staging and in `agents:validate`:

- **HEA-001 [G]** The payload is a complete Healer payload whose failure matches the cited sources
  (fail closed otherwise).
- **HEA-002 [G]** Evidence references are the artifact's own evidence IDs, cited at most once per
  list; the diagnosis cites at least one; an alternative never repeats the primary classification.
- **HEA-003 [G]** A repair is proposed only for `test-code-issue` or `test-data-or-setup`, only
  with status `READY`, and only together with repair metadata; `application-defect` carries a
  `defect-candidate` finding and no repair; `insufficient-evidence` lists missing evidence.
- **HEA-004 [G]** Repair scope: at most three changes, each a `modify` of the failing test file or
  of a support file it imports; never a create, never another file. (G-PATHS additionally
  protects canonical tests, requirements, configuration, workflows and the agent layer.)
- **HEA-005 [G]** No weakened checks: every assertion and authorization or error-code check of the
  current file is kept unchanged in the proposed content, and no tautological assertion is added.
- **HEA-006 [G]** No suppression: no added `skip`, `only`, `fixme`, `fail` or `slow`
  annotations, `expect.soft`, empty `catch` blocks or lint and type-check suppressions.
- **HEA-007 [G]** No concealing waits: no added fixed waits (`waitForTimeout`), and no new or
  increased timeouts or retries.
- **HEA-008 [G]** No claims of approval, authorization, execution, verification or resolution
  (a repair that passed, a defect that is fixed) and no defect or ticket IDs.
- **HEA-009 [G]** Provenance is consistent: an offline output records no requested model, effort or
  token budget, and the evidence IDs are sequential and unique.
- **HEA-010 [J]** When the evidence does not decide, classify `insufficient-evidence` and say what
  is missing instead of guessing.

HEA-005 – HEA-007 are the Healer's part of the deferred G-ASSERT guard (Agent Standard §16); the
Standard's guard table is unchanged. HEA-008 is pattern-based defense in depth.

## Statuses and exit codes (`npm run agents:heal`)

| Exit | Meaning                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 0    | Staged: a diagnosis, or a repair validated up to the H7 boundary (`EXECUTION_AUTHORIZATION_REQUIRED`) |
| 1    | Repair staged; the validator reported a failure (`VALIDATION_FAILED`)                                 |
| 2    | Usage error or precondition stop (no authentic failure, unsafe evidence); no model call               |
| 4    | Model output rejected (stop reason, invalid JSON, schema or a HEA rule); no `artifact.json`           |
| 5    | BLOCKED or NEEDS_HUMAN_DECISION staged                                                                |

## Limitations (v1)

- Offline only: `--fake-model-output` is required, and no live model call has been made.
- One failure per run; trace archives, screenshots and videos are not read.
- All committed tests are canonical (Protected), so repairs can only target support files today.
- No apply workflow: H3 and the commit are manual; H7 is never supplied by the Healer.
