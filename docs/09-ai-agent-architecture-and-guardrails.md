# I. AI Agent Architecture and Guardrails

> **Status.** [Agent Standard v2.0](../agents/standard/standard.md) defines **exactly three AI
> agents**, the **Planner**, the **Generator** and the **Healer**, and the deterministic
> **Validator**, which is not an AI agent. All of them are implemented. The agents are tested only with
> a fake model: the Generator has a live mode in code but was demonstrated only offline, with a
> hand-written fixture, and the Planner and the Healer are offline-only. None has produced real
> model output. **No live AI model run has been made**, **H7 is closed** (no execution
> authorization is in effect or stored), and no proposal has been executed or applied
> autonomously.

## Principle

**AI proposes, deterministic code validates, a human approves**
([Agent Standard v2.0 §1](../agents/standard/standard.md#1-principles), [ADR-0001](adr/0001-ai-outside-test-runtime.md)).
Agents never write to the repository: the orchestrator stages each proposal under
`artifacts/proposals/<taskId>/` (gitignored), guards validate it, and a human decides. The
Playwright runtime never imports the agent layer or an LLM SDK (ESLint boundary).

## Components

Three AI agents and one deterministic component ([Standard §2.1, §2.2](../agents/standard/standard.md#21-agents)).
Each agent produces exactly one artifact type; the Validator is never counted as an agent.

| Component           | Kind                                                              | Artifact type        | Status                                                                                 | Evidence                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Standard v2.0 | Shared contract (rules, statuses, gates, guards, envelope schema) | —                    | Implemented, frozen; envelope `schemaVersion` 2.0                                      | [`standard.md`](../agents/standard/standard.md), [`envelope.schema.json`](../agents/standard/envelope.schema.json)                                                         |
| Planner agent v1    | AI agent                                                          | `test-plan-proposal` | Implemented; offline only, tested with a fake model; no live run                       | [`definition.md`](../agents/definitions/planner/definition.md), [`orchestrator/planner/`](../agents/orchestrator/planner/), [Planner Agent v1](planner-agent.md)           |
| Generator agent v1  | AI agent                                                          | `test-proposal`      | Implemented; offline demonstration only                                                | [`definition.md`](../agents/definitions/generator/definition.md), [`orchestrator/generator/`](../agents/orchestrator/generator/), [Generator Agent v1](generator-agent.md) |
| Healer agent v1     | AI agent                                                          | `heal-proposal`      | Implemented; offline only, tested with a fake model and synthetic reports; no live run | [`definition.md`](../agents/definitions/healer/definition.md), [`orchestrator/healer/`](../agents/orchestrator/healer/), [Healer Agent v1](healer-agent.md)                |
| Validator           | Deterministic component (no AI), not an agent                     | —                    | Implemented                                                                            | [`orchestrator/validation/`](../agents/orchestrator/validation/)                                                                                                           |

The agent definitions are at version 1.1 and require Agent Standard 2.x.

## Generator agent v1 (implemented)

Proposes **exactly one new Playwright test file** for one explicitly selected, approved test case
([definition](../agents/definitions/generator/definition.md)):

1. **Select** (deterministic, before any model call): the test case must exist in the approved
   plan with _Automation: Yes_ and a level; an existing static reference to its ID stops the run.
2. **Context**: a deterministic pack of at most 64 KB, never truncated, with a manifest of every
   source (path, section, bytes, Git blob SHA).
3. **Model call**: one call through the `ModelClient` interface. Live mode
   (`npm run agents:generate -- --tc …`) uses the Anthropic SDK with credentials from the
   person's environment. Offline mode (`--fake-model-output <file>`) makes no call.
4. **Check**: refusals, `max_tokens`, invalid JSON and schema violations are rejected; output is
   never repaired.
5. **Envelope and stage**: under `artifacts/proposals/<taskId>/`, after a secret scan.
6. **Validate** without execution authorization; the run ends there.

## Planner agent v1 (implemented, offline)

Proposes **test-planning additions** for explicitly selected, approved requirements: new test
cases with provisional IDs (`PTC-NNN-NN`) and suggested automation candidates among the approved
test cases ([definition](../agents/definitions/planner/definition.md),
[Planner Agent v1](planner-agent.md)). It screens requirement text as untrusted data before any
model call, checks every proposal with G-SCHEMA (including its
[payload schema](../agents/definitions/planner/planner-payload.schema.json)) and G-TRACE (rules
PLN-001 – PLN-006), and stages it for human review at **H1**. It never writes the test plan or the
requirements, never approves, and never requests or supplies H7: a plan proposal contains no code.
v1 is **offline-only** (`--fake-model-output` is required); no live Planner run has been made.

## Healer agent v1 (implemented, offline)

Diagnoses **one failed Playwright test** from its JSON report and, when the evidence supports it,
proposes a **narrowly scoped repair** ([definition](../agents/definitions/healer/definition.md),
[Healer Agent v1](healer-agent.md)). Evidence must be authentic (the test failed in a consistent
report), is sanitized and screened for instructions and secrets before any model call, and is cited
by ID. The diagnosis classifies the failure as a test-code issue, a test-data or setup problem, an
application defect (escalated as a defect candidate, never worked around), an environment problem
or insufficient evidence. A repair is allowed only for the first two, only as a `modify` of the
failing test or a support file it imports, and it is rejected if it weakens a check, suppresses a
test, or adds waits, timeouts or retries (rules HEA-001 – HEA-009 in G-TRACE). A repair is then
validated without execution authorization: it waits for H7 (closed) and for H3. v1 is
**offline-only**; no live Healer run has been made.

## Validator: seven deterministic guards

Order and execution capability from the Standard's
[guard table](../agents/standard/standard.md#guards-contract); implementation in
[`validate.ts`](../agents/orchestrator/validation/validate.ts). The validator stops at the first
failure.

| Guard       | Checks                                                                                 | Runs proposed code    | Tests                     |
| ----------- | -------------------------------------------------------------------------------------- | --------------------- | ------------------------- |
| G-SCHEMA    | Envelope, and payload once a payload schema exists                                     | No                    | `validate.test.ts`        |
| G-PATHS     | Path class and `changeKind` permitted for the agent; Protected untouched; default deny | No                    | `validate.test.ts`        |
| G-BASE      | `modify` has a matching `baseSha`; `create` targets a non-existent file                | No                    | `validate.test.ts`        |
| G-TRACE     | Cited IDs exist; tags match declared TCs; no `@CAN`; modified tests keep their tags    | No                    | `trace-guard.test.ts`     |
| G-STATIC    | `typecheck`, `lint` and `format:check` on the proposed state                           | No                    | `static-guard.test.ts`    |
| G-DISCOVERY | `playwright test --list` contains the new tests with their declared tags               | **Yes — H7 required** | `discovery-guard.test.ts` |
| G-RUN       | Targeted run of the proposed test files                                                | **Yes — H7 required** | `run-guard.test.ts`       |

Without H7 the validator ends `INCOMPLETE` (exit 3). The agent suite (`npm run agents:test`)
tests the guards, the three agents and the three-agent contract **with a fake model**; it makes no
model calls. Its results in published CI runs are on the Dashboard's AI Agents page.

## Human approval gates H1–H7

Verbatim from [Agent Standard §8](../agents/standard/standard.md#8-human-approval-gates), with the
status of each gate in this repository.

| Gate | Requires human approval                                                                                      | In this repository                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1   | Test-plan changes, including provisional TC IDs (Planner)                                                    | Reachable: the Planner stages proposals for human review; no apply workflow exists, so an accepted proposal reaches the test plan only as a reviewed commit by a human                                             |
| H2   | Generated test and support changes, after validation (Generator)                                             | No apply workflow exists; a proposal reaches `tests/` only as an ordinary, reviewed commit by a human                                                                                                              |
| H3   | Healing patches, after validation (Healer)                                                                   | Reachable: the Healer stages healing patches; their execution-capable guards wait for H7 (closed), and no apply workflow exists, so an accepted repair reaches the repository only as a reviewed commit by a human |
| H4   | Requirements changes — humans only; agents may only raise findings                                           | Requirements are a Protected path; G-PATHS denies them to every agent                                                                                                                                              |
| H5   | Creating, changing or promoting a canonical test — humans only                                               | Files with a `@CAN-` test are Protected; G-TRACE rejects an agent-added `@CAN` tag                                                                                                                                 |
| H6   | Changes to this standard, agent definitions or ADRs — humans only                                            | `agents/**` and `docs/adr/**` are Protected paths                                                                                                                                                                  |
| H7   | Execution authorization: before any execution-capable guard runs proposed code for validation (STD-AUTH-005) | **Closed**                                                                                                                                                                                                         |

### H7 in detail

- An H7 authorization is the SHA-256 of the exact artifact bytes, given by a human on the
  command line (`npm run agents:validate -- <artifact.json> --authorize-execution <sha256>`) for
  one validator run. It is never read from the artifact or from environment variables, and any
  change to the artifact invalidates it.
- **No authorization is in effect or stored.** The Standard defers a persistent record of
  authorizations (§16); the validator writes no persistent pipeline record.
- CI never authorizes execution: `ci.yml` contains no `--authorize-execution`, never runs
  `agents:generate`, and fails if `ANTHROPIC_API_KEY` is set or `artifacts/proposals` exists.
- H7 is a human checkpoint, not a sandbox: authorized proposed code runs with the user's
  permissions.

## The documented offline demonstration

[Generator Agent v1](generator-agent.md#offline-demo-tc-003-07) records one historical, local
demonstration for **TC-003-07**:

- The "model output" was a **hand-written fixture**
  ([`fixtures/tc-003-07.spec.ts.txt`](../agents/orchestrator/generator/fixtures/tc-003-07.spec.ts.txt)),
  passed with `--fake-model-output`; the artifact records `modelCall: "offline-recorded-output"`.
- Without H7: G-SCHEMA – G-STATIC passed, G-DISCOVERY and G-RUN were not authorized (INCOMPLETE).
- With a human H7 authorization for that one artifact, in a local validator run: all seven guards
  passed.

This was **not a live AI model run**, **did not open H7** for current use, and **did not add a
test**: the fixture is a `.txt` file outside `tests/`, so Playwright does not discover it and
TC-003-07 remains _not yet automated_. Its evidence record is local and gitignored, so it cannot
be verified from the repository.

## Not recorded (and therefore never claimed)

- Agent execution history, model usage, tokens or costs, and success rates of live AI runs.
- AI-generated proposals (they stay in the gitignored `artifacts/proposals/`).
- Approval or authorization events (who approved what, and when).
- Any test in `tests/` written by an AI model. All 30 committed tests are hand-written reference
  tests.

## Three-agent architecture (Agent Standard 2.0)

Agent Standard 2.0 makes the approved architecture the contract: **Planner, Generator and Healer**
are the only agents, and the **Validator** is deterministic code in the orchestrator, not an agent
([§2.1, §2.2](../agents/standard/standard.md#21-agents)). Failure diagnosis is part of the Healer: a
`heal-proposal` without proposed changes is a diagnosis (a report, no approval needed); with
changes it is a healing patch (H7 for its execution-capable guards, then H3).

**The Analyzer is retired.** Standard 1.x named a fourth agent, the Analyzer, with a
`failure-analysis` artifact type. It was never implemented: no definition, no code and no artifact
was ever committed or published, and the `ci-history` branch contains no Analyzer data. The
migration therefore needs no read-only compatibility, and none is offered.

**Versioning** (Standard §15). Removing an agent and an artifact type removes enum values from the
envelope schema, which is breaking, so this is **Standard 2.0** with envelope `schemaVersion` 2.0.
No rule was removed or changed in meaning, no permission was widened, the payload schemas are
unchanged, and section numbers are kept, because the agents' context packs select Standard
sections by number. The agent definitions are 1.1 (minor): they require Standard 2.x and nothing
else changed.

| Artifact                                                    | Validator result (G-SCHEMA, STD-ART-001)                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `agent.name` `analyzer`                                     | Rejected: "`analyzer` is retired (Agent Standard 2.0)"                      |
| `artifactType` `failure-analysis`, by any agent             | Rejected: retired; never read or converted as a `heal-proposal`             |
| `schemaVersion` or `standardVersion` 1.x, from any agent    | Rejected: retired major version; the proposal is regenerated, not converted |
| An unknown agent (for example `validator`) or a wrong owner | Rejected by the envelope schema                                             |
| Rule IDs with the `ANA-` prefix                             | Rejected: the prefix is retired and never reused                            |

A rejected artifact stops at G-SCHEMA; no later guard, and no Healer rule, is applied to it. The
tests are in [`architecture.test.ts`](../agents/orchestrator/architecture.test.ts): each agent
stages a valid 2.0 artifact offline, the real validator checks it without H7, the retired
contracts are rejected, a missing payload schema fails closed, and the repository is unchanged.
