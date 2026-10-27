# A. Project Overview and Architecture

## What this project is

The AI-Assisted QA Automation Framework is a TypeScript and Playwright portfolio project. It
tests **RequestFlow**, a small request-and-approval web application built as the application
under test (AUT), and adds an AI agent layer that may _propose_ tests but never runs inside the
test runtime.

The governing principle is [ADR-0001](adr/0001-ai-outside-test-runtime.md): **AI agents are
outside the deterministic Playwright runtime.** `npm test` needs no model, API key or network
access to an AI provider, and the product tests never import the agent layer
([`eslint.config.mjs`](../eslint.config.mjs) enforces this import boundary, tested by
[`eslint-boundary.test.ts`](../agents/orchestrator/generator/eslint-boundary.test.ts)).

## Layers

```
 Approved sources            Deterministic runtime              Evidence and reporting
 ─────────────────           ─────────────────────              ──────────────────────
 specs/requestflow/          apps/requestflow/app/  (AUT)       .github/workflows/ci.yml
   requirements.md   ──▶     apps/requestflow/pages|api|data    reporting/ci/  (records)
   test-plan.md              tests/requestflow/  (Playwright)   ci-history branch
                             playwright.config.ts               reporting/dashboard/ (site)
            │
            ▼  (proposes only; validated; human-approved)
 Agent layer: agents/standard · agents/definitions · agents/orchestrator
```

| Path                                                                                                                              | Responsibility                                                                             | Status at the audit commit                           |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [`specs/requestflow/`](../specs/requestflow/)                                                                                     | Requirements v1.2 and Test Plan v1: the behavioural source of truth                        | Implemented, frozen baseline                         |
| [`apps/requestflow/app/`](../apps/requestflow/app/)                                                                               | RequestFlow: server-rendered UI and JSON API, in-memory state                              | Implemented                                          |
| [`apps/requestflow/pages/`](../apps/requestflow/pages/), [`api/`](../apps/requestflow/api/), [`data/`](../apps/requestflow/data/) | Page objects, a thin API client, demo users                                                | Implemented                                          |
| [`tests/requestflow/`](../tests/requestflow/)                                                                                     | Playwright tests (API, UI, E2E)                                                            | 5 files, 30 test instances                           |
| [`agents/`](../agents/)                                                                                                           | Agent Standard, agent definitions, orchestrator (three agents and deterministic validator) | Planner, Generator, Healer and validator implemented |
| [`reporting/dashboard-data/`](../reporting/dashboard-data/)                                                                       | Builds the validated dashboard snapshot from committed sources                             | Implemented                                          |
| [`reporting/ci/`](../reporting/ci/)                                                                                               | CI run records, hand-off, publisher, reconciliation, history export                        | Implemented                                          |
| [`reporting/dashboard/`](../reporting/dashboard/)                                                                                 | The read-only QA Dashboard (React, build-time data)                                        | Implemented; published on GitHub Pages (see K)       |
| [`framework/`](../framework/), [`prompts/`](../prompts/), [`integrations/`](../integrations/)                                     | Planned shared runtime, prompt entry points and external integrations                      | **Planned: placeholders only** (`.gitkeep`)          |

## Implemented today (verified)

- RequestFlow v1 with Employee and Reviewer roles, the `DRAFT → SUBMITTED → APPROVED / REJECTED`
  lifecycle, server-side validation and authorization, and demo cookie authentication.
- The approved human test plan: **96 test cases** for **10 requirements**, and **5 canonical
  reference tests** (CAN-001 – CAN-005), automated and passing.
- **30 committed Playwright test instances** in 5 files, linked to **21** test cases by
  `@TC-…` tags; all 30 passed in published CI run #23 at the audit commit.
- The agent layer: Agent Standard v2.0 with exactly three AI agents (Planner, Generator, Healer)
  and the deterministic Validator, which is not an AI agent; a seven-guard validator with human
  execution authorization (H7); Generator Agent v1, demonstrated **offline only** with a
  hand-written fixture, [Planner Agent v1](planner-agent.md) and [Healer Agent v1](healer-agent.md), both offline-only
  and tested with a fake model. **No live AI model run has been made**, and H7 is closed.
- CI on GitHub Actions, an approval-gated CI history branch (`ci-history`) with 5 published run
  records, read-only reconciliation, and the QA Dashboard showing them.
- The Dashboard's GitHub Pages deployment ([`pages.yml`](../.github/workflows/pages.yml), merged in
  pull request #11). The project owner has confirmed that the site is public and working at
  <https://larysak.github.io/AI-QA-AutomationFramework/>; see
  [K](11-dashboard-and-github-pages.md) for what was verified independently.

## Planned, not implemented

- A live Generator, Planner or Healer run; a proposal approval and apply workflow.
- Shared framework code in `framework/`, prompt entry points, and integrations (Jira, Azure
  DevOps, GitHub, MCP).
- A defect register: none exists (see [L](12-defect-management-and-reporting.md)).

## Technology

| Area          | Choice                                                                                          | Evidence                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Language      | TypeScript, strict mode                                                                         | [`tsconfig.json`](../tsconfig.json)                                                                                                 |
| Tests         | Playwright 1.63.0 (installed), project `chromium`                                               | [`playwright.config.ts`](../playwright.config.ts), CI record #23                                                                    |
| Quality gates | ESLint, Prettier, `tsc`                                                                         | [`package.json`](../package.json) scripts                                                                                           |
| Node.js       | `.nvmrc`: 22; root `engines` `^20.19.0 \|\| ^22.13.0 \|\| >=24`; the dashboard needs `^22.22.2` | [`.nvmrc`](../.nvmrc), [`package.json`](../package.json), [`reporting/dashboard/package.json`](../reporting/dashboard/package.json) |
| CI            | GitHub Actions, actions pinned to commit SHAs                                                   | [`.github/workflows/`](../.github/workflows/)                                                                                       |
| AI SDK        | `@anthropic-ai/sdk` (dev dependency, agent layer only)                                          | [`package.json`](../package.json)                                                                                                   |
