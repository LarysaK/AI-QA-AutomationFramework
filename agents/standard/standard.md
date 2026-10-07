# Agent Standard v1.1

| Item            | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| Standard        | `1.1` (see [revision history](#17-revision-history))                  |
| Envelope schema | [`envelope.schema.json`](envelope.schema.json), `schemaVersion` `1.0` |
| Applies to      | Planner, Generator, Analyzer, Healer, and the orchestrator            |
| Builds on       | [ADR-0001](../../docs/adr/0001-ai-outside-test-runtime.md)            |
| Status          | Frozen                                                                |

This standard is the single shared contract for every agent and for the orchestrator that runs
them. Agent definitions (`agents/definitions/`) add only what is specific to one agent; they
reference rules here by ID and never restate or weaken them.

Each rule has a stable ID and an enforcement marker:

- **[G]** enforced by a deterministic guard in the orchestrator;
- **[J]** relies on the agent's judgment and is checked by the human reviewer.

Guards named here (`G-…`) are the contract for what the orchestrator checks. Their
implementation is not part of this document.

---

## 1. Principles

1. **AI proposes, deterministic code validates, a human approves** (ADR-0001).
2. **Behaviour comes from requirements**, never from what the application currently does.
3. **No guessing.** Ambiguity, missing context and conflicts become explicit statuses and
   findings.
4. **Traceability is preserved and never invented.**
5. **Project patterns over general best practice.**
6. **Smallest sufficient change.**
7. **Everything is recorded:** sources used, assumptions made and the reason for every change.

## 2. Terms

| Term            | Meaning                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Agent           | An LLM-backed role (Planner, Generator, Analyzer, Healer) that reads and proposes                |
| Orchestrator    | Deterministic code that prepares tasks, stages artifacts, runs guards and applies changes        |
| Artifact        | One agent output for one task, conforming to the envelope schema                                 |
| Guard           | A deterministic check run by the orchestrator                                                    |
| Approved source | A human-approved document or file: requirements, test plan, canonical tests, ADRs, this standard |

---

## 3. Sources of truth

There are two separate hierarchies, because "what to expect" and "how to write it" are
different questions.

| Rank | **Behaviour** — what to test and what to expect             | **Engineering** — how to write it                                           |
| ---- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | Approved requirements                                       | ADRs and this standard                                                      |
| 2    | Approved test plan                                          | Canonical test patterns                                                     |
| 3    | Canonical tests, as evidence of how a rule was interpreted  | Existing support: page objects, API client, test data, config, global setup |
| 4    | Existing non-canonical tests                                | Existing non-canonical tests                                                |
| 5    | Application implementation — evidence only, never authority | Repository tooling conventions (TypeScript, ESLint, Prettier)               |

**STD-SRC-001 [J]** Resolve each question with the matching hierarchy. A higher source wins
only where it states the point explicitly; silence in a higher source is not a conflict. A real
conflict that affects the proposal is recorded as a `conflict` finding citing both sources, and
the artifact status is `NEEDS_HUMAN_DECISION`. An agent never silently chooses a side.

**STD-SRC-002 [J]** When the application contradicts a requirement, record a
`defect-candidate` finding. Never change an expected result to match the application.
Behaviour the test plan marks as not frozen may be asserted only where the plan lists it, and
never in a canonical test.

---

## 4. Context discovery

Context is scoped by the task, not by the whole repository:

1. **Scope** — the task names REQ, TC or CAN IDs, or a failing test.
2. **Mandatory** — the requirement sections in scope; the matching test-plan rows and the
   plan's strategy and assertion rules; the canonical tests closest to the task's level and
   shape; the support code those canonical tests use.
3. **By search** — existing tests with the same tags (`playwright test --list --grep`); page
   objects and API client methods for the screens and endpoints involved; configuration when
   relevant.
4. **Application evidence** — AUT source or rendered pages only when needed to confirm a
   contract (for example an accessible name or a response shape), recorded with role
   `app-evidence` (see STD-SRC-002).
5. **Run evidence** — Analyzer and Healer only: the failing test, its tags, its result entries
   and the paths of traces, screenshots and logs.

**STD-CTX-001 [J]** Read the mandatory context for the task type before proposing. Agent
definitions set the exact minimum per task type.

**STD-CTX-002 [G]** List every source used in `sourceReferences` with its path, role and the
IDs it contributed. _Guard: G-SCHEMA._

**STD-CTX-003 [J]** If required context is missing, return `BLOCKED` with
`contextRequests` instead of proceeding on assumptions.

---

## 5. Traceability

The chain is **REQ → TC → test → execution result**:

- REQ IDs (`REQ-NNN`) come from the approved requirements;
- TC IDs (`TC-NNN-NN`) and CAN IDs (`CAN-NNN`) come from the approved test plan;
- tests carry IDs as Playwright tags (`@REQ-…`, `@TC-…`, `@CAN-…`);
- execution results carry the tags (Playwright JSON report).

**STD-TRC-001 [G]** Every ID cited in an artifact exists in an approved source, as defined by
the specification format contract (5.1). No agent
invents an ID where an approved one exists. Only the Planner may propose new TC IDs; they are
provisional, are carried in the Planner payload, and become approved only through gate H1.
Missing traceability is a `gap` finding, and an untraced test is not proposed. _Guard:
G-TRACE._

**STD-TRC-002 [G]** A new test carries `@REQ-…` and `@TC-…` tags matching the traceability
declared for its change. _Guards: G-TRACE, G-DISCOVERY._

**STD-TRC-003 [G]** Agents never add a `@CAN-…` tag; only a human makes a test canonical
(gate H5). A modified test keeps its tag set unchanged. AI origin is recorded in the artifact
and the commit, not in test code (ADR-0001). _Guard: G-TRACE._

Analyzer reports cite the test file, test title, tags, TC, REQ, the run and the evidence paths.

### 5.1 Specification format contract

The approved behavioural documents contain structural markers that form a machine-readable
interface. Deterministic traceability validation (G-TRACE) reads approved IDs only from these
markers, never from prose. The contract documents the existing format; it does not change it.

| Document                                                   | Marker                                    | Defines                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `specs/<aut>/requirements.md`                              | Level-2 heading `## REQ-NNN — <title>`    | An approved requirement                                                                             |
| `specs/<aut>/test-plan.md` (next to its `requirements.md`) | Level-3 heading `### REQ-NNN — <title>`   | The test-case section owned by that requirement; it ends at the next heading of level 1–3           |
| `test-plan.md`, inside a `### REQ-NNN` section             | Table row whose first cell is `TC-NNN-NN` | An approved test case owned by that requirement; `NNN` in the TC ID equals the section's REQ number |
| `test-plan.md`, any table                                  | Table row whose first cell is `CAN-NNN`   | An approved canonical test                                                                          |

- Inside a `### REQ-NNN` section, every table row except the header row (first cell `ID`) and
  the separator row is a test-case row.
- Every test case's owning requirement is defined in the `requirements.md` next to the test
  plan.
- A table row whose first cell is a TC ID outside any `### REQ-NNN` section violates the
  contract.
- REQ, TC and CAN IDs are unique across all of `specs/` in Standard v1; IDs are not namespaced
  per application under test.
- Otherwise, IDs mentioned anywhere (prose, other table cells, other headings) define nothing.
- A document that violates the contract cannot be read safely: G-TRACE then fails closed and
  validates no traceability (STD-TRC-001).

Human-readable prose may evolve freely. The markers may change only together with a
human-approved change to this standard and to the validation that reads them (gate H6).

**STD-TRC-004 [J]** A proposal that changes `requirements.md` or `test-plan.md` content
preserves the specification format contract (5.1): every marker keeps its exact form, and new
requirements or test cases use the same markers. It never changes the markers themselves.

---

## 6. Authority

### 6.1 Process flow

**READ → PROPOSE → STAGE → VALIDATE → APPROVE → APPLY**

| Stage    | Owner                     | What happens                                                                    |
| -------- | ------------------------- | ------------------------------------------------------------------------------- |
| READ     | Agent, orchestrator       | Repository files and run outputs are read; never secrets (STD-SEC-001)          |
| PROPOSE  | Agent                     | The agent returns one artifact. It has no write access to the repository        |
| STAGE    | Orchestrator              | The artifact is written to `artifacts/proposals/<taskId>/`                      |
| VALIDATE | Orchestrator              | Guards run deterministically; results are recorded separately from the artifact |
| APPROVE  | Human                     | The human reviews the artifact, the generated diff and the validation record    |
| APPLY    | Orchestrator, on approval | Approved changes are applied to a branch; the human commits and merges as usual |

**STD-AUTH-001 [G]** Agents never write to the repository. The only location AI output is
written to is `artifacts/proposals/<taskId>/`, and only the orchestrator writes it. Only the
orchestrator records validation results; an agent can never declare its own work validated.
_Enforced by the orchestrator's design._

**STD-AUTH-002 [G]** Every proposed change targets a path class permitted for its agent and
its `changeKind` (6.2). Anything not listed is denied. _Guard: G-PATHS._

**STD-AUTH-003 [G]** Every `modify` change carries the `baseSha` of the file it was written
against, and it must match the current file. A `create` change targets a file that does not
exist. _Guard: G-BASE._

**STD-AUTH-004 [G]** Validation never mutates approved repository state. How validation is
isolated is an orchestrator implementation decision. _Enforced by the orchestrator's design._

### 6.2 Path classes

Default: **deny**. A change is allowed only if its path is in a class below and the agent and
`changeKind` are permitted for that class.

| Class     | Paths                                                                                                                                                                                                                                | `changeKind`     | Permitted agents                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------- |
| Protected | `specs/**/requirements.md`; any file containing a `@CAN-` test; `apps/*/app/**` (AUT source); `playwright.config.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`; `.env*`; `agents/**`; `docs/adr/**` | —                | None. Humans only, by normal PRs.   |
| Plan      | `specs/**/test-plan.md`                                                                                                                                                                                                              | `plan-change`    | Planner                             |
| Test      | `tests/**`, except Protected files                                                                                                                                                                                                   | `test-change`    | Generator (create), Healer (modify) |
| Support   | `apps/*/pages/**`, `apps/*/api/**`, `apps/*/data/**`                                                                                                                                                                                 | `support-change` | Generator, Healer                   |

A Generator never changes the application under test to make a generated test pass; the
Protected class makes this mechanical.

---

## 7. Statuses

Agent artifact statuses and orchestrator pipeline statuses are **two separate concepts**. They
do not form one sequence, and neither replaces the other.

### 7.1 Agent artifact statuses

Set by the agent in the artifact's `status` field. They describe the agent's own result and do
not change after staging.

| Status                 | Meaning                                                       | Required content                            |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `READY`                | The proposal is complete within its scope                     | —                                           |
| `BLOCKED`              | Required context or a prerequisite is missing                 | `contextRequests` (≥ 1)                     |
| `NEEDS_HUMAN_DECISION` | An ambiguity, conflict or gap prevents a responsible proposal | `findings` (≥ 1) stating it and the options |

### 7.2 Orchestrator pipeline statuses

Set only by the orchestrator, in its own record for the task. Never part of the agent's
output.

| Status              | Set at stage | Meaning                                                                                                 |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `STAGED`            | STAGE        | The artifact is stored under `artifacts/proposals/<taskId>/`                                            |
| `VALIDATION_FAILED` | VALIDATE     | A guard failed; the record names the guard, the rule IDs and the reason (for example a stale `baseSha`) |
| `VALIDATED`         | VALIDATE     | All required guards passed                                                                              |
| `APPROVED`          | APPROVE      | A human approved the validated artifact                                                                 |
| `REJECTED`          | APPROVE      | A human rejected the artifact                                                                           |
| `APPLIED`           | APPLY        | The approved changes were applied                                                                       |

Only an artifact with agent status `READY` is eligible to be applied. Artifacts with
`BLOCKED` or `NEEDS_HUMAN_DECISION` are staged for review; once the human has supplied the
missing context or decision, the task is run again.

---

## 8. Human approval gates

| Gate | Requires human approval                                            |
| ---- | ------------------------------------------------------------------ |
| H1   | Test-plan changes, including provisional TC IDs (Planner)          |
| H2   | Generated test and support changes, after validation (Generator)   |
| H3   | Healing patches, after validation (Healer)                         |
| H4   | Requirements changes — humans only; agents may only raise findings |
| H5   | Creating, changing or promoting a canonical test — humans only     |
| H6   | Changes to this standard, agent definitions or ADRs — humans only  |

No approval is needed for context discovery, Analyzer reports, validation runs, or discarding
an artifact.

---

## 9. Artifact envelope

Every agent output is a JSON document conforming to
[`envelope.schema.json`](envelope.schema.json). The envelope holds everything the orchestrator
and guards act on regardless of agent; agent-specific content goes in `payload`, validated by
that agent's own schema.

| Field              | Content                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `artifactType`     | `test-plan-proposal`, `test-proposal`, `failure-analysis` or `heal-proposal`         |
| `schemaVersion`    | Envelope schema version                                                              |
| `standardVersion`  | Version of this standard the agent followed                                          |
| `agent`            | `{ name, definitionVersion }`                                                        |
| `taskId`           | Assigned by the orchestrator                                                         |
| `status`           | Agent artifact status (7.1)                                                          |
| `summary`          | One or two sentences for the reviewer                                                |
| `sourceReferences` | `{ path, role, ids }` for every source used                                          |
| `traceability`     | `{ requirements, testCases, canonicalPatterns }` the work is based on                |
| `assumptions`      | `{ id, statement, impact }`                                                          |
| `findings`         | `{ id, kind, severity, message, sourceRefs, ruleIds }`                               |
| `contextRequests`  | What is missing; required when `BLOCKED`                                             |
| `proposedChanges`  | `{ path, changeKind, operation, baseSha, content, rationale, traceability, impact }` |
| `payload`          | Agent-specific content                                                               |

Finding kinds: `conflict`, `ambiguity`, `gap`, `missing-context`, `defect-candidate`,
`deviation`, `novel-pattern`, `risk`.

**STD-ART-001 [G]** The output is a single envelope that validates against the schema, with a
payload that validates against its agent's payload schema once one exists. _Guard: G-SCHEMA._

**STD-ART-002 [G/J]** A `support-change` declares its `impact`: why the shared support must
change and which existing tests or support it may affect. The presence of `impact` is
schema-enforced; its accuracy is judged by the reviewer. Any `support-change` causes the full
suite to run during validation. _Guards: G-SCHEMA, G-RUN._

Two deliberate constraints:

- **Changes carry full file content, not diffs.** The orchestrator generates the diff for the
  reviewer.
- **There is no numeric confidence score.** Uncertainty is expressed through `assumptions`,
  `findings` and `status`.

The `failure-analysis` artifact never contains `proposedChanges`.

---

## 10. Canonical tests

Canonical tests are human-designed, human-approved **reference patterns**. They are not a
closed set of allowed test designs, and they are not templates to copy. The index of canonical
tests for an application under test is in its test plan (for RequestFlow:
`specs/requestflow/test-plan.md`, section 3).

| Canonical | Pattern invariants                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| CAN-001   | Page objects hold mechanics; assertions stay in the spec; role and label locators; ID read from the URL; tags as metadata           |
| CAN-002   | Built-in `request` fixture with API login; data tables with a TC per row; exact status and `error.code`; no message assertions      |
| CAN-003   | Arrange through the API; read back with GET; `toEqual(before)` proves a failed operation changed nothing                            |
| CAN-004   | One browser context per role, closed in `try/finally`; unique business keys; identity checked by URL; the API as the final check    |
| CAN-005   | A negative step before the positive one; validation checked through accessible state; terminal state shown by controls disappearing |

**STD-CAN-001 [J/G]** Choose patterns by test level and shape, cite them in
`traceability.canonicalPatterns`, and reuse their invariants, not their data. Canonical tests
are never modified, re-tagged or duplicated; modification is guard-enforced through the
Protected path class. _Guard: G-PATHS._

**STD-CAN-002 [J]** When no canonical test matches directly, state that no direct pattern
exists, name the closest reusable patterns if any, and declare the structure used as a
`deviation` or `novel-pattern` finding explaining why it is appropriate. This alone does not
require `NEEDS_HUMAN_DECISION`; use that status only when the missing pattern exposes a real
requirement, architecture or test-design ambiguity that prevents a responsible proposal.

---

## 11. Test authoring

**STD-TST-001 [G]** Proposed code passes the repository's static checks: `typecheck`, `lint`
and `format:check`. New and affected tests are discovered and pass a targeted run. _Guards:
G-STATIC, G-DISCOVERY, G-RUN._

**STD-TST-002 [G/J]** Proposed tests follow the project's authoring conventions:

- no fixed waits (`waitForTimeout`, sleeps); use web-first assertions and auto-waiting;
- business assertions stay in specs; page objects and clients hold mechanics only;
- semantic locators (role, label, text); no test-only attributes added to the AUT;
- no state reset inside tests; tests create the data they need, with unique business keys
  where parallel tests could collide;
- tests never import AUT source (`apps/*/app/**`) or `agents/**`;
- errors are asserted by status and `error.code`, never by message wording.

Conventions become [G] where a lint rule enforces them; the rest are [J]. _Guard: G-STATIC._

---

## 12. Uncertainty

**STD-UNC-001 [J]** Never guess and continue.

| Situation                                                            | Agent response                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ambiguous requirement, or conflicting sources affecting the proposal | `NEEDS_HUMAN_DECISION` with `ambiguity` or `conflict` findings                         |
| Missing context                                                      | `BLOCKED` with `contextRequests`                                                       |
| No direct canonical pattern                                          | `READY` with a `deviation` or `novel-pattern` finding (STD-CAN-002)                    |
| Insufficient confidence                                              | Explicit `assumptions` and `findings`; `NEEDS_HUMAN_DECISION` if it blocks correctness |

Parts of a task unaffected by a blocking finding may still be included in the artifact for
review. When validation fails, the orchestrator may return guard output to the agent for a
bounded number of attempts; every attempt is recorded and guards are never relaxed.

---

## 13. Security

**STD-SEC-001 [J]** Prompts, artifacts and generated code never contain secrets, tokens or
values from `.env` files. `.env*` files other than `.env.example` are never part of an agent's
context. Generated tests use only the application's synthetic demo users. LLM provider keys
come from environment configuration read by the orchestrator, never from repository files or
artifacts. Run evidence is quoted only as far as needed; traces are referenced by path.

---

## 14. Rule index

| Rule         | Summary                                                          | Marker | Enforcement                  |
| ------------ | ---------------------------------------------------------------- | ------ | ---------------------------- |
| STD-SRC-001  | Two hierarchies; explicit statements win; conflicts escalated    | J      | Reviewer                     |
| STD-SRC-002  | App/requirement conflict → defect candidate, never matched       | J      | Reviewer                     |
| STD-CTX-001  | Mandatory context per task type                                  | J      | Reviewer                     |
| STD-CTX-002  | Sources listed in `sourceReferences`                             | G      | G-SCHEMA                     |
| STD-CTX-003  | Missing context → `BLOCKED`                                      | J      | Reviewer                     |
| STD-TRC-001  | Cited IDs exist; no invention; provisional IDs only from Planner | G      | G-TRACE                      |
| STD-TRC-002  | New tests tagged with their declared REQ and TC                  | G      | G-TRACE, G-DISCOVERY         |
| STD-TRC-003  | No `@CAN` from agents; modified tests keep their tags            | G      | G-TRACE                      |
| STD-TRC-004  | Specification proposals preserve the format contract (5.1)       | J      | Reviewer                     |
| STD-AUTH-001 | Agents never write to the repository; only staging               | G      | Orchestrator design          |
| STD-AUTH-002 | Path classes and `changeKind`; default deny                      | G      | G-PATHS                      |
| STD-AUTH-003 | `baseSha` matches for every modified file                        | G      | G-BASE                       |
| STD-AUTH-004 | Validation never mutates approved repository state               | G      | Orchestrator design          |
| STD-ART-001  | Schema-valid envelope and payload                                | G      | G-SCHEMA                     |
| STD-ART-002  | Support changes declare impact; full suite runs                  | G/J    | G-SCHEMA, G-RUN, reviewer    |
| STD-UNC-001  | No guessing; use statuses and findings                           | J      | Reviewer                     |
| STD-CAN-001  | Reuse pattern invariants, not data; canonical tests untouched    | J/G    | Reviewer, G-PATHS            |
| STD-CAN-002  | No direct pattern → declare and justify                          | J      | Reviewer                     |
| STD-TST-001  | Static checks, discovery and targeted run pass                   | G      | G-STATIC, G-DISCOVERY, G-RUN |
| STD-TST-002  | Authoring conventions                                            | G/J    | G-STATIC (lint), reviewer    |
| STD-SEC-001  | No secrets in prompts, artifacts or tests                        | J      | Reviewer                     |

Agent-specific rules use the prefixes `PLN-`, `GEN-`, `ANA-` and `HEA-` with the same
numbering. Guard results and findings cite rule IDs. Rule IDs are never reused; a retired rule
stays in this index marked as retired.

### Guards (contract)

| Guard       | Checks                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------- |
| G-SCHEMA    | Envelope, and payload once a payload schema exists                                             |
| G-PATHS     | Path class and `changeKind` permitted for the agent; Protected untouched; default deny         |
| G-BASE      | `modify` has a matching `baseSha`; `create` targets a non-existent file                        |
| G-TRACE     | Cited IDs exist; new tests' tags match declared TCs; no `@CAN`; modified tests keep their tags |
| G-STATIC    | `typecheck`, `lint` and `format:check` on the proposed state                                   |
| G-DISCOVERY | `playwright test --list` contains the new tests with their declared tags                       |
| G-RUN       | Targeted run by `--grep @TC-…`; the full suite when any `support-change` is present            |

Guards run in this order and stop at the first failure.

---

## 15. Versioning

| Item                                   | Breaking (major)                                                                                                               | Non-breaking (minor)                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Standard (`MAJOR.MINOR`, this file)    | A rule removed or its meaning changed; a new [G] rule that rejects previously valid artifacts; a hierarchy or authority change | Wording; a new [J] rule; a [J] rule upgraded to [G] that rejects nothing currently valid |
| Envelope schema (`schemaVersion`)      | A required field added, removed or renamed; an enum value removed                                                              | An optional field; a new enum value                                                      |
| Agent definition (`definitionVersion`) | Required payload fields, allowed path classes or minimum context changed                                                       | Wording, examples                                                                        |

Each agent definition declares the standard major version it requires. The orchestrator
rejects artifacts with an unsupported major `schemaVersion` and definitions that require an
unsupported standard major version.

---

## 16. Not in v1

Deferred to later versions or to the orchestrator and agent definitions:

- LLM provider, SDK, prompt composition, context delivery, token and cost limits,
  structured-output mode;
- how validation is isolated, the retry limit, how approvals are captured, the schema
  validation library;
- guards G-CONTEXT (mandatory context present), G-SECRETS (STD-SEC-001 stays [J] until then),
  G-ASSERT (assertion weakening, with the Healer), repeated runs for flakiness;
- fingerprinting every context source;
- agent payload schemas, minimum context per task type, agent rules, failure and fix
  categories, the provisional TC ID format;
- a structured test-case format replacing Markdown parsing of the test plan.

---

## 17. Revision history

| Version | Change                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1     | Added the specification format contract (5.1) and STD-TRC-004 [J]. Minor: documents the existing format and adds a judgment rule; no artifact valid under 1.0 becomes invalid. |
| 1.0     | Initial frozen standard.                                                                                                                                                       |
