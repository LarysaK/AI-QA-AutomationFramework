# Healer Agent v1

The Healer **diagnoses one failed Playwright test** from explicitly supplied failure evidence and,
when the evidence supports it, **proposes a narrowly scoped repair** for human review. It follows
[Agent Standard v2.0](../agents/standard/standard.md) and
[ADR-0001](adr/0001-ai-outside-test-runtime.md): **AI proposes, deterministic code validates, a
human approves.**

> **Status.** Healer v1 is implemented and tested **with a fake model and synthetic failure
> reports only**. It is **offline-only**: it reads a recorded model output and makes no model call.
> **No live Healer run has been made**, no test has been repaired, and no defect has been resolved
> or recorded by it.

The Healer never applies a repair, never runs proposed code, never weakens, removes or suppresses
an assertion or a test, never increases timeouts or retries to hide a failure, and never changes the
requirements, the test plan, a canonical test, configuration or workflows. It stages its proposal
under `artifacts/proposals/<taskId>/` (gitignored) and stops.

Definition: [`agents/definitions/healer/definition.md`](../agents/definitions/healer/definition.md).
Code: [`agents/orchestrator/healer/`](../agents/orchestrator/healer/).

## Usage

```bash
npm run agents:heal -- \
  --report agents/orchestrator/healer/fixtures/synthetic-approve-strict-mode.report.json \
  --test tests/requestflow/e2e/approve-request.spec.ts:17 \
  --fake-model-output agents/orchestrator/healer/fixtures/approve-strict-mode.output.json
```

| Option                       | Meaning                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `--report <file>`            | A Playwright JSON report (the `json` reporter output): the only accepted failure evidence |
| `--test <file>:<line>`       | The failing test, as the report locates it (`tests/…spec.ts:<line>`)                      |
| `--app <name>`               | Application under test; default `requestflow`                                             |
| `--fake-model-output <file>` | **Required in v1**: a recorded model output; no provider is called                        |

Both fixtures are for the demonstration and the tests only: the report is **synthetic** (a real
report of this repository with one result changed to a failure), and the output is
**hand-written**, not model output.

Exit codes: `0` staged (a diagnosis, or a repair validated up to the H7 boundary) · `1` repair
failed validation · `2` usage or precondition stop (no model call) · `4` model output rejected (no
artifact) · `5` BLOCKED / NEEDS_HUMAN_DECISION staged.

## How it works

1. **Authentic evidence.** The report must be a complete, consistent Playwright JSON report, read
   with the same parser as the CI record collector (at most 5 MB), and the selected test must
   have failed in it. No report, a passed, flaky or skipped test, or a test the report does not
   contain stops the run: a failure is never assumed.
2. **Committed test.** The test file must be committed, its report line must declare a test, and
   every `@REQ-…`/`@TC-…` tag the report gives must be approved and present in the file.
3. **Evidence items** `E-001` … : error messages, the stack, expected and received values, steps,
   attempt statuses, environment (Playwright version, project, retries, timeout, workers) and the
   committed source of the test and of the support files it imports. Trace archives,
   screenshots, videos and `.env*` files are never read.
4. **Sanitize and screen.** ANSI codes are stripped; absolute paths become repository paths or
   `<path>`. Instruction-like text, context delimiters, credentials, environment-variable values
   and e-mail addresses stop the run before any model call. Each item is at most 8 KB and the
   context at most 64 KB; nothing is truncated.
5. **Model call**: one call through the shared `ModelClient`; in v1 the recorded output.
6. **Check**: stop reason, JSON and the [output schema](../agents/definitions/healer/healer-output.schema.json),
   with the shared parser.
7. **Envelope**: a `heal-proposal` artifact. The diagnosis and repair metadata are in the
   [payload](../agents/definitions/healer/healer-payload.schema.json); repair changes are ordinary
   `proposedChanges` (`modify`, with the orchestrator's `baseSha`).
8. **Guards, in process**: G-SCHEMA (envelope and payload), G-PATHS, G-BASE and G-TRACE with the
   Healer rules HEA-001 – HEA-009. Any failure rejects the proposal with its reasons
   (`rejection.json`); no `artifact.json` is staged.
9. **Stage.** A diagnosis is staged as a report (`STAGED`). A repair is staged and then checked
   by the validator in a child process **without** `--authorize-execution`: G-STATIC runs on the
   proposed state, G-DISCOVERY and G-RUN stay not authorized, and the pipeline status is
   `EXECUTION_AUTHORIZATION_REQUIRED` (H7 closed).

## Failure classifications

| Classification                  | Repair    | Rule                                                          |
| ------------------------------- | --------- | ------------------------------------------------------------- |
| `test-code-issue`               | Allowed   | The test or its support code is wrong                         |
| `test-data-or-setup`            | Allowed   | Test data or the test's own setup is wrong                    |
| `application-defect`            | **Never** | Needs a `defect-candidate` finding; escalated to human triage |
| `environment-or-infrastructure` | **Never** | Diagnosis only                                                |
| `insufficient-evidence`         | **Never** | Must list the missing evidence                                |

The diagnosis also records `confidence` (`low`, `medium`, `high`), `alternatives` with their own
evidence, missing evidence and recommended investigation. No defect ID or ticket is ever created.

## Repair rules

| Rule    | A repair is rejected if it                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEA-003 | is proposed for a classification other than `test-code-issue` or `test-data-or-setup`, with a non-READY status, or without its repair metadata                              |
| HEA-004 | changes more than three files, creates a file, or touches anything but the failing test and the support files it imports                                                    |
| G-PATHS | targets a Protected path: canonical tests (all committed tests today), requirements, configuration, `.env*`, the agent layer, ADRs; or anything outside the allowed classes |
| HEA-005 | removes or changes any assertion, status or error-code check, authentication helper or `response.ok()` guard of the current file, or adds a tautological assertion          |
| HEA-006 | adds `skip`, `only`, `fixme`, `fail` or `slow`, `expect.soft`, an empty `catch`, or a lint or type-check suppression                                                        |
| HEA-007 | adds a fixed wait (`waitForTimeout`), a timer, or a new or larger timeout or retry value                                                                                    |
| HEA-008 | claims approval, authorization, execution, a verified or passing repair, a resolved defect, or a defect or ticket ID, or asks for execution authorization                   |

HEA-005 – HEA-007 are the Healer's part of the deferred G-ASSERT guard (Agent Standard §16); the
Standard's guard table is unchanged.

## H7 and approval

- **H7 stays closed.** The Healer never requests or supplies execution authorization. A repair's
  execution-capable guards (G-DISCOVERY, G-RUN; the full suite for a support change) run only if a
  human authorizes that exact artifact.
- **H3** approves applying a healing patch. There is no apply workflow: an accepted repair reaches
  the repository only as an ordinary, reviewed commit by a human.
- A diagnosis needs no approval (Agent Standard §8).

## Tests

```bash
npm run agents:test                                          # the whole agent suite
npx tsx --test agents/orchestrator/healer/healer.test.ts      # the Healer tests only
```

70 tests, all with injected fake model output: diagnoses for every classification, a valid repair,
missing provenance, invalid references, malformed output, evidence references, prompt injection and
secrets in logs, unauthorized targets, assertion weakening, suppression, timeouts and retries,
fabricated claims, H7 bypass attempts, the real validator without authorization, determinism,
provenance, no repository mutation, and Planner regression.

## Limitations

- Offline only; no live Healer run has been made, so real-model diagnosis quality is unverified.
- One failure per run, from a Playwright JSON report; traces, screenshots and videos are not read.
- All committed tests are canonical (Protected), so repairs can only target support files today.
- HEA-005 – HEA-008 are deterministic but pattern-based; the human reviewer remains responsible.
- The report's authenticity is checked structurally and by its SHA-256; it is not signed.
- Failure diagnosis is part of the Healer: the Analyzer agent of Agent Standard 1.x is retired,
  and the validator rejects `analyzer` and `failure-analysis` artifacts rather than reading them
  as Healer artifacts ([I](09-ai-agent-architecture-and-guardrails.md#three-agent-architecture-agent-standard-20)).
