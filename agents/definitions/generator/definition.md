# Generator Agent — definition

definitionVersion: 1.1

| Item              | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Agent             | `generator`                                                    |
| Requires standard | Agent Standard 2.x ([standard.md](../../standard/standard.md)) |
| Artifact type     | `test-proposal`                                                |
| Output schema     | [`generator-output.schema.json`](generator-output.schema.json) |
| System prompt     | [`prompt.md`](prompt.md)                                       |
| Revision          | 1.1: requires Agent Standard 2.x; nothing else changed (minor) |
| Orchestrator      | `agents/orchestrator/generator/` (`npm run agents:generate`)   |

The Generator proposes **exactly one new Playwright TypeScript test file** for one explicitly
selected, approved test case. It never proposes support changes, edits to existing files, AUT
changes or new test-case IDs. All Agent Standard rules apply; this definition only adds what is
specific to the Generator.

## Inputs

- `--tc TC-NNN-NN` — an approved test case (Agent Standard 5.1).
- `--app <name>` — the application under test; default `requestflow`.
- `--instruction "<text>"` — optional human guidance, at most 1,000 characters. It is passed to
  the model as non-authoritative and never overrides the standard or the approved sources.
- `--allow-referenced-tc` — explicit override of the static-reference pre-check.
- `--model <id>` / `AGENTS_GENERATOR_MODEL` — model override.

## Preconditions (deterministic, before any model call)

1. The approved documents parse under the specification format contract (5.1); otherwise stop.
2. The test case exists; its owning requirement is taken from the test plan.
3. The test case's plan row has the columns `Level` (`API`, `UI` or `E2E`) and `Automation`;
   `Automation` must be `Yes`. These columns are read by header from the test case's table; this
   is a Generator precondition, not part of the 5.1 marker contract or of G-TRACE.
4. **Static-reference pre-check.** If any existing `tests/**` TypeScript file contains the test
   case ID in a string literal, the Generator stops and asks for `--allow-referenced-tc`. A
   static reference is not proof of coverage: it does not show that a runtime tag exists or that
   a passing test exercises the case. The Generator never claims coverage.

## Context selection (deterministic; hard limit 64 KB; no truncation)

Pieces, in this order. Any required piece that cannot be found stops the run.

| Role             | Source and rule                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `architecture`   | `agents/standard/standard.md`: `## 5.` up to `### 5.1`; `### 6.2`; `## 10.`; `## 11.`; `## 13.`                        |
| `requirements`   | `specs/<app>/requirements.md`: everything before `# Requirements`; the owning `## REQ-NNN —` section; the `# API` part |
| `test-plan`      | `specs/<app>/test-plan.md`: `## 1.` (test strategy); the owning `### REQ-NNN —` section                                |
| `canonical-test` | At most two canonical tests whose canonical-index `Level` equals the test case's `Level` (priority below)              |
| `support`        | Files under `apps/<app>/{api,data,pages}/` imported (relatively, transitively) by the selected canonical tests         |

**Canonical priority** (when more candidates than two share the level): first, canonical tests
whose `Covers` column lists a test case of the same requirement; then ascending `CAN-NNN`. A
canonical test is mapped to the single `tests/**` file containing its `@CAN-NNN` tag.

Never included: `.env*`, AUT source (`apps/*/app/**`), `artifacts/`, `node_modules/`.

The manifest records each piece's path, role, section, byte count and the file's Git blob SHA.

## Output and ownership

The model returns JSON matching `generator-output.schema.json`. The orchestrator assembles the
Agent Standard envelope:

| Owner        | Fields                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator | `artifactType`, `schemaVersion`, `standardVersion`, `agent`, `taskId`, `sourceReferences`, `traceability.requirements`/`testCases`, `changeKind`, `operation`, change `traceability`, `payload`, assumption and finding IDs |
| Model        | `status`, `summary`, test file `path`, `content`, `rationale`, `traceability.canonicalPatterns`, `assumptions`, `findings`, `contextRequests`                                                                               |

`payload` keys: `modelCall`, `requestedModel`, `servedModel`, `effort`, `maxTokens`,
`definitionVersion`, `requestedTestCase`, `allowReferencedTestCase`.

`modelCall` is `anthropic-api` when a provider was called. With `--fake-model-output` it is
`offline-recorded-output`: no LLM was called, `requestedModel`, `effort` and `maxTokens` are `null`,
`servedModel` is `fake-model-output`, and `request.json` records `offline: true` with the recorded
file's path and SHA-256. Offline output must never be presented as model-generated.

Model output is never repaired: invalid output is rejected, and envelope-level problems that are
not schema problems (wrong path, extra IDs, `@CAN`) are left for the validator to report.

## Agent rules

- **GEN-001 [J]** Propose exactly one new test file under `tests/<app>/**/*.spec.ts`, for the
  selected test case only, tagged `@REQ-…` and `@TC-…` exactly as selected.
- **GEN-002 [J]** When the test case needs support code that does not exist (for example a
  missing API client method), return `BLOCKED` with `contextRequests` instead of a support change.
- **GEN-003 [J]** When the approved sources leave the expected behaviour ambiguous or undefined,
  return `NEEDS_HUMAN_DECISION` with a blocking finding.

## Statuses and exit codes (`npm run agents:generate`)

| Exit | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | READY staged; validator INCOMPLETE (execution guards await human H7 authorization)              |
| 1    | READY staged; the validator reported a failure                                                  |
| 2    | Usage error, precondition stop or context problem; no model call                                |
| 4    | Model output rejected (refusal, `max_tokens`, invalid JSON or schema); no `artifact.json`       |
| 5    | BLOCKED or NEEDS_HUMAN_DECISION staged; G-SCHEMA and G-TRACE checked in process; nothing to run |
