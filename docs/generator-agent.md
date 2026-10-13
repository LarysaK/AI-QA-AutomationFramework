# Generator Agent v1

The Generator proposes **one new Playwright TypeScript test** for one explicitly selected,
approved test case. It is the first AI step of the agent layer, and it follows
[Agent Standard v1.2](../agents/standard/standard.md) and
[ADR-0001](adr/0001-ai-outside-test-runtime.md): **AI proposes, deterministic code validates, a
human approves.**

The Generator never edits the repository. It stages a proposal under
`artifacts/proposals/<taskId>/`, runs the validator without execution authorization, and stops.
Running the proposed test (H7) and applying it to `tests/` (H2) are separate human decisions.

Definition: [`agents/definitions/generator/definition.md`](../agents/definitions/generator/definition.md).
Code: [`agents/orchestrator/generator/`](../agents/orchestrator/generator/).

## Usage

```bash
npm run agents:generate -- --tc TC-003-07                      # live: calls the model
npm run agents:generate -- --tc TC-003-07 --fake-model-output out.json   # offline: no LLM call
```

| Option                       | Meaning                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `--tc TC-NNN-NN`             | Approved test case (required)                                                      |
| `--app <name>`               | Application under test; default `requestflow`                                      |
| `--instruction "…"`          | Optional, non-authoritative guidance (at most 1,000 characters)                    |
| `--allow-referenced-tc`      | Proceed although an existing test already mentions the test-case ID                |
| `--model <id>`               | Model override (also `AGENTS_GENERATOR_MODEL`); default `claude-sonnet-5-5`        |
| `--fake-model-output <file>` | Offline mode: use a recorded model output; no provider call, no credentials needed |

Exit codes: `0` READY staged and validator INCOMPLETE · `1` validation failed · `2` usage or
precondition stop · `4` model output rejected · `5` BLOCKED / NEEDS_HUMAN_DECISION staged.

## How it works

1. **Select** — the test case must exist in the approved test plan, be marked
   `Automation: Yes` and have a level (`API`, `UI`, `E2E`). If an existing test already mentions
   the ID in a string literal, the run stops: that is a static reference, **not** verified
   coverage, and the Generator never claims coverage.
2. **Context** — a deterministic pack, at most 64 KB, never truncated: selected Agent Standard
   sections, the shared requirement definitions, the owning requirement and the API contract, the
   test plan's strategy and the owning requirement's test cases, at most two canonical tests at
   the same level (same requirement first, then CAN ID), and the support code they import. A
   manifest records each piece's path, section, bytes and Git blob SHA. For TC-003-07 the pack is
   14 pieces, 35,167 bytes.
3. **Model call** — one call through the `ModelClient` interface. The Anthropic implementation
   uses the official TypeScript SDK with JSON-schema structured output, `max_tokens` 12,000,
   `effort: medium` where supported, `maxRetries: 0`, no fallback model and no regeneration.
4. **Check** — refusals, `max_tokens`, invalid JSON and schema violations are rejected (exit 4).
   Model output is never repaired.
5. **Envelope** — the orchestrator owns identity, versions, `taskId`, traceability,
   `changeKind`/`operation`, source references and provenance; the model owns the test path,
   content, rationale, summary, assumptions and findings. The envelope is checked by G-SCHEMA
   before staging.
6. **Stage** — `artifact.json`, `request.json` (a manifest, not the context text),
   `response.json`, `preview/<path>.proposed`, `validation-1.txt` and `status.json`, all inside
   the task directory, after a secret scan.
7. **Validate** — READY proposals go to `agents:validate` in a child process with an allowlisted
   environment (no provider credentials) and **without** `--authorize-execution`. BLOCKED and
   NEEDS_HUMAN_DECISION proposals are checked in process (G-SCHEMA, G-TRACE) and never offered H7.

## Validation and the H7 boundary

| Guard       | Checks                                                                 | Runs proposed code    |
| ----------- | ---------------------------------------------------------------------- | --------------------- |
| G-SCHEMA    | Envelope schema                                                        | No                    |
| G-PATHS     | Path classes; only `tests/**/*.spec.ts` for a new test                 | No                    |
| G-BASE      | `create` targets a new file                                            | No                    |
| G-TRACE     | REQ/TC IDs exist and match the test's tags; no `@CAN`                  | No                    |
| G-STATIC    | `typecheck`, `lint`, `format:check` on the proposed state              | No (approved tooling) |
| G-DISCOVERY | Playwright discovers the test with the declared runtime tags           | **Yes — H7 required** |
| G-RUN       | Targeted run of the proposed test in an isolated copy with its own AUT | **Yes — H7 required** |

Without H7 the validator ends `INCOMPLETE` (exit 3). A human authorizes execution of one exact
artifact by its SHA-256:

```bash
npm run agents:validate -- artifacts/proposals/<taskId>/artifact.json --authorize-execution <sha256>
```

H7 is a human checkpoint, not a sandbox: authorized proposed code runs with the user's
permissions. Authorizing execution does not approve applying the change; applying it to `tests/`
remains a manual, reviewed commit.

## Offline demo: TC-003-07

TC-003-07 (REQ-003): submitting an already SUBMITTED request returns
`409 INVALID_STATE_TRANSITION` and leaves the request unchanged, including `updatedAt`.

The demo test is a **hand-written fixture**
([`fixtures/tc-003-07.spec.ts.txt`](../agents/orchestrator/generator/fixtures/tc-003-07.spec.ts.txt)),
not LLM output. It was passed to the Generator with `--fake-model-output`, which records
`modelCall: "offline-recorded-output"`, `requestedModel: null`, `effort: null` and
`servedModel: "fake-model-output"` in the artifact, and `offline: true` with the recorded file's
SHA-256 in `request.json`.

Result (artifact SHA-256 `422b4a8c603cbadff4aad8ca54771fdb8e33c615c9fbc0496f13062cde609839`):

- without H7: G-SCHEMA through G-STATIC passed; G-DISCOVERY and G-RUN not-authorized; INCOMPLETE;
- with human H7 authorization: **all seven guards passed**; one test discovered and one executed
  (targeted run), validator exit 0 (VALIDATED).

The demo proves the pipeline and its boundaries; it says nothing about the quality of real model
output. The demo test was not applied to `tests/`. The evidence record is kept locally under
`artifacts/proposals/gen-tc-003-07-20261013T124014Z/` (gitignored).

## Limitations

- No live model call has been made yet; real-model output quality is unverified.
- v1 proposes only one new test file: no support changes, no edits, no new test-case IDs.
- The validator CLI prints its result but writes no persistent pipeline record; `status.json` is
  the Generator-stage record. Authorizations are not audited.
- The validator itself treats BLOCKED / NEEDS_HUMAN_DECISION artifacts as INCOMPLETE if run
  directly; the Generator avoids this by not invoking it for them.
- Context selection depends on Agent Standard 1.2 section numbers and on the headings
  `# Requirements`, `# API` and the test plan's `## 1.`; a change stops the run instead of
  guessing.
- The ESLint import boundary covers static imports only.
- The secret scan is defense in depth, not a guarantee; staged files (including raw model
  output) are potentially sensitive local files.
- An `ant` credential profile under `HOME` is readable by proposed code during an authorized
  run.
- Windows behaviour is implemented but untested.
