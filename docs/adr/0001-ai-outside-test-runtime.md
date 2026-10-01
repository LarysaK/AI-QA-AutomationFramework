# ADR-0001: AI agents are outside the deterministic Playwright runtime

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

This project uses AI agents to help with planning, generating, analyzing and healing
automated tests. LLMs are useful for these tasks but have properties that conflict with what
a test suite needs:

- **Non-determinism:** the same input can produce different output.
- **Opacity:** decisions are hard to audit after the fact.
- **External dependency:** availability, latency, cost, rate limits and credentials.
- **Risk of masking defects:** an AI that adapts tests at runtime can make a genuine
  application regression look like a passing test.

A test suite exists to give a trustworthy, reproducible signal about the application under
test. If AI takes part in test execution, for example through self-healing locators at
runtime or LLM-evaluated assertions, the signal is only as trustworthy as the model.

## Decision

**AI agents are outside the deterministic Playwright runtime.**

1. `framework/`, `apps/`, `tests/` and `playwright.config.ts` must not import, call or
   depend on any AI agent, orchestrator module or LLM SDK.
2. Running `npm test` must not require network access to an LLM, API keys or any AI
   tooling.
3. AI agents act only **before** execution (planning, generation) or **after** execution
   (analysis, healing, reporting). They read results and propose artifacts or patches.
4. Agent output is staged in `artifacts/`, validated by deterministic code (schemas,
   type-check, lint, guards), and only enters the codebase after human approval.
5. Any change produced by AI becomes ordinary, reviewed source code. At runtime, no
   distinction exists between human-written and AI-assisted tests.

## Consequences

- The dependency direction is one-way: `agents/` may read the runtime code, but the runtime
  never depends on `agents/`. A lint rule should enforce this once `agents/` contains code.
- Healing is an offline, reviewable patch, never runtime adaptation.
- The framework, page objects and conventions must be designed for humans first. Agents
  consume them as they are and do not shape them.
- Generated code is held to the same standards (strict TypeScript, ESLint) as handwritten
  code.

## Benefits

- **Reproducibility:** test results depend only on code and the application under test.
- **Trustworthy signal:** a failing test cannot be silently "fixed" by a model during
  execution.
- **Auditability:** every AI contribution exists as a reviewable diff with a recorded
  rationale.
- **Resilience:** CI keeps working if the LLM provider is down, rate-limited or replaced.
- **Cost control:** no LLM calls per test run.
- **Replaceability:** the agent layer or LLM vendor can change without touching the test
  suite.

## Trade-offs

- **No runtime self-healing:** a locator change fails the run until a heal is proposed,
  validated and approved. This is a deliberate choice: we accept a red build over a hidden
  regression.
- **Slower feedback loop for healing:** human approval adds latency compared to fully
  autonomous fixes.
- **More engineering effort:** guards, schemas and staging must be built instead of letting
  agents edit files directly.
- **AI cannot reason over live runtime state** during execution; it relies on recorded
  artifacts (traces, screenshots, DOM snapshots, logs), which must therefore be captured
  reliably.
