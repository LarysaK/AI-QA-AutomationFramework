# I. AI Agent Architecture and Guardrails

> **Status.** Two AI agents, the **Generator** and the **Planner** (added in M7), and the
> deterministic **validator** are implemented. Both agents run **offline only**: the Generator was
> demonstrated with a hand-written fixture, and the Planner reads recorded outputs and is tested
> with a fake model; neither has produced real model output. **No live AI model run has been made**, **H7 is
> closed** (no execution authorization is in effect or stored), and no AI-generated test has been
> applied to the repository.

## Principle

**AI proposes, deterministic code validates, a human approves**
([Agent Standard v1.2 §1](../agents/standard/standard.md#1-principles), [ADR-0001](adr/0001-ai-outside-test-runtime.md)).
Agents never write to the repository: the orchestrator stages each proposal under
`artifacts/proposals/<taskId>/` (gitignored), guards validate it, and a human decides. The
Playwright runtime never imports the agent layer or an LLM SDK (ESLint boundary).

## Components

| Component           | Kind                                                              | Status                                                                                             | Evidence                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Standard v1.2 | Shared contract (rules, statuses, gates, guards, envelope schema) | Implemented, frozen                                                                                | [`standard.md`](../agents/standard/standard.md), [`envelope.schema.json`](../agents/standard/envelope.schema.json)                                                         |
| Generator agent v1  | AI agent                                                          | Implemented; offline demonstration only                                                            | [`definition.md`](../agents/definitions/generator/definition.md), [`orchestrator/generator/`](../agents/orchestrator/generator/), [Generator Agent v1](generator-agent.md) |
| Validator           | Deterministic orchestrator (no AI)                                | Implemented                                                                                        | [`orchestrator/validation/`](../agents/orchestrator/validation/)                                                                                                           |
| Planner agent v1    | AI agent                                                          | Implemented; offline only, tested with a fake model; no live run                                   | [`definition.md`](../agents/definitions/planner/definition.md), [`orchestrator/planner/`](../agents/orchestrator/planner/), [Planner Agent v1](planner-agent.md)           |
| Healer agent        | AI agent                                                          | **Planned** (approved architecture); specified in the Standard; no definition, no code             | Standard path classes, gate H3                                                                                                                                             |
| Analyzer agent      | AI agent                                                          | **Removed from the approved architecture**; still named in the committed Standard v1.2 (see below) | Standard §4, §5                                                                                                                                                            |

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

Without H7 the validator ends `INCOMPLETE` (exit 3). The agent suite (`npm run agents:test`, 176
tests at the audit commit, all passing in CI run #23) tests the guards and the Generator **with a
fake model**; it makes no model calls.

## Human approval gates H1–H7

Verbatim from [Agent Standard §8](../agents/standard/standard.md#8-human-approval-gates), with the
status of each gate in this repository.

| Gate | Requires human approval                                                                                      | In this repository                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | Test-plan changes, including provisional TC IDs (Planner)                                                    | Reachable: the Planner stages proposals for human review; no apply workflow exists, so an accepted proposal reaches the test plan only as a reviewed commit by a human |
| H2   | Generated test and support changes, after validation (Generator)                                             | No apply workflow exists; a proposal reaches `tests/` only as an ordinary, reviewed commit by a human                                                                  |
| H3   | Healing patches, after validation (Healer)                                                                   | Not reachable: the Healer is not implemented                                                                                                                           |
| H4   | Requirements changes — humans only; agents may only raise findings                                           | Requirements are a Protected path; G-PATHS denies them to every agent                                                                                                  |
| H5   | Creating, changing or promoting a canonical test — humans only                                               | Files with a `@CAN-` test are Protected; G-TRACE rejects an agent-added `@CAN` tag                                                                                     |
| H6   | Changes to this standard, agent definitions or ADRs — humans only                                            | `agents/**` and `docs/adr/**` are Protected paths                                                                                                                      |
| H7   | Execution authorization: before any execution-capable guard runs proposed code for validation (STD-AUTH-005) | **Closed**                                                                                                                                                             |

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

## Approved architecture change (pending implementation)

The project owner has **approved** this target architecture:

| #   | Component           | Kind                                     | Implementation status                            |
| --- | ------------------- | ---------------------------------------- | ------------------------------------------------ |
| 1   | **Planner agent**   | AI agent                                 | Implemented (v1, offline only; fake-model tests) |
| 2   | **Generator agent** | AI agent                                 | Implemented (offline demonstration only)         |
| 3   | **Healer agent**    | AI agent                                 | Planned                                          |
| 4   | **Validator**       | Deterministic component, not an AI agent | Implemented                                      |

The standalone **Analyzer agent has been removed** from the planned architecture.

This is an approved **direction**, not an implementation. The formal revision of the contracts
is **pending**: at the audit commit these committed files still define four AI agents, including
the Analyzer, and this documentation-only change deliberately does not modify them.

| Area               | File                                                                                                                                                                         | What still refers to the Analyzer                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Standard     | [`agents/standard/standard.md`](../agents/standard/standard.md)                                                                                                              | "Applies to Planner, Generator, Analyzer, Healer"; the _Agent_ term; run evidence for "Analyzer and Healer" (§4); Analyzer reports (§5, §8); the `ANA-` rule prefix (§14) |
| Envelope schema    | [`agents/standard/envelope.schema.json`](../agents/standard/envelope.schema.json)                                                                                            | The `agent.name` enum, and the `failure-analysis` artifact type, which the schema binds to the `analyzer` agent                                                           |
| Validator types    | [`agents/orchestrator/validation/types.ts`](../agents/orchestrator/validation/types.ts)                                                                                      | `AgentName` includes `'analyzer'`                                                                                                                                         |
| Dashboard register | [`reporting/dashboard/src/data/agents.ts`](../reporting/dashboard/src/data/agents.ts)                                                                                        | The AI Agents view lists the Analyzer as "Specified only", with evidence quoted from the Standard                                                                         |
| Dashboard tests    | [`test/agents.test.tsx`](../reporting/dashboard/test/agents.test.tsx), [`test-node/agent-layer-plugin.test.ts`](../reporting/dashboard/test-node/agent-layer-plugin.test.ts) | Expect four AI agents ("2 of 4") and the Analyzer's absent paths                                                                                                          |

**Why it must be one controlled change.** The Standard is frozen (its status table), versioned by
the rules of §15, and changed only by humans (gate H6). Removing an agent from the schema's enum
is a breaking change of the envelope (§15). The dashboard's build-time evidence check requires its
AI-agent list to equal the Standard's _Agent_ term, so changing only one side fails the build by
design.

**Recommendation** (for a later milestone): a new Agent Standard version that removes the
Analyzer and reassigns reading run evidence (for example to the Healer); the matching envelope
schema version (the agent enum and the `failure-analysis` artifact type) and validator types; then the Dashboard register and its tests, so the AI Agents
view shows "2 of 3". The root README already describes the approved architecture and labels the
Standard revision as pending.
