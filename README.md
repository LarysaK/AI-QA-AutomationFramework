# AI-Assisted QA Automation Framework

A TypeScript + Playwright test automation framework for **RequestFlow**, a small multi-role
request-and-approval application built as the application under test, with an AI agent layer
that may only _propose_ tests.

**Live QA Dashboard:** <https://larysak.github.io/AI-QA-AutomationFramework/> · **Full
documentation:** [`docs/`](docs/README.md)

## Architecture principle

> **AI is outside the Playwright runtime.**
> The test framework is deterministic and fully executable without an LLM.
> AI agents only _propose_ artifacts and patches; deterministic code validates every
> proposal, and a human approves it at defined gates.

Running Playwright tests never requires an LLM, an AI API key, or any AI tool or provider. ESLint
forbids runtime code from importing `agents/**` or an LLM SDK. See
[ADR-0001](docs/adr/0001-ai-outside-test-runtime.md).

## At a glance

| Area         | Status                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements | [RequestFlow Requirements v1.2](specs/requestflow/requirements.md): 10 approved requirements (frozen)                                                                                                                 |
| Test design  | [Test Plan v1](specs/requestflow/test-plan.md): 96 traceable test cases (82 API, 11 UI, 3 E2E)                                                                                                                        |
| Automation   | 30 Playwright tests in 5 files: the five canonical reference tests CAN-001 – CAN-005. 21 test cases are linked by tags, 20 of them fully consistent; see the [coverage matrix](docs/05-automation-coverage-matrix.md) |
| CI           | GitHub Actions on every push and pull request to `main`; actions pinned to commit SHAs                                                                                                                                |
| CI history   | One immutable, approval-gated record per CI run on `main`, on the `ci-history` branch, with read-only reconciliation                                                                                                  |
| Dashboard    | Read-only, build-time data, strict CSP; published on GitHub Pages after each published CI record                                                                                                                      |
| AI agents    | Planner and Generator agents and the deterministic Validator implemented; **no live model run yet; H7 closed**                                                                                                        |

## Repository layout

| Directory                                 | Responsibility                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `specs/`                                  | Behavioural source of truth: requirements and the test plan                                        |
| `apps/requestflow/`                       | The AUT (`app/`), page objects (`pages/`), API client (`api/`) and demo users (`data/`)            |
| `tests/`                                  | Playwright tests: test flow and business assertions                                                |
| `agents/`                                 | AI layer: the Agent Standard, the Generator definition, the orchestrator (Generator and Validator) |
| `reporting/`                              | Dashboard data, CI run records and history, the QA Dashboard                                       |
| `.github/workflows/`                      | `ci.yml`, `ci-history.yml`, `pages.yml`                                                            |
| `docs/`                                   | Project documentation and Architecture Decision Records                                            |
| `framework/`, `prompts/`, `integrations/` | **Planned** layers; placeholders only today                                                        |
| `artifacts/`                              | Run outputs, reports, AI proposals (gitignored)                                                    |

## Project status

Foundation, demo application and test design:

- [x] TypeScript (strict), Playwright, ESLint and Prettier configured; validation passing
- [x] RequestFlow v1: UI and JSON API, Employee and Reviewer roles, demo authentication,
      `DRAFT → SUBMITTED → APPROVED / REJECTED`, server-side authorization and validation
- [x] Requirements v1.2 (frozen) and the human QA test plan for REQ-001 – REQ-010
- [x] Five canonical reference tests, CAN-001 – CAN-005 (passing in CI)

CI, history and dashboard:

- [x] CI workflow with snapshot, quality, agent, dashboard and Playwright checks
- [x] Approval-gated CI history publication and read-only reconciliation
- [x] QA Dashboard on GitHub Pages, deployed by `pages.yml`

Agent layer:

- [x] [Agent Standard v1.2](agents/standard/standard.md) and the artifact envelope schema
- [x] Deterministic validator with seven guards and human execution authorization (H7)
- [x] [Generator agent v1](docs/generator-agent.md): one new test per approved test case,
      staged and validated; demonstrated offline with a hand-written fixture (not model output)
- [x] [Planner agent v1](docs/planner-agent.md): test-planning proposals (provisional test
      cases, automation candidates) for approved requirements, checked deterministically and
      staged for human review at H1; offline only, tested with a fake model
- [x] ESLint import boundary: runtime code cannot import `agents/**` or the LLM SDK

Not implemented yet:

- [ ] A live Generator run (real model output)
- [ ] A live Planner run (Planner v1 is offline-only)
- [ ] Healer agent
- [ ] Analyzer agent — removed from the approved architecture; still named in Agent Standard
      v1.2 until its revision
- [ ] Proposal approval and apply workflow
- [ ] Automation of the remaining test cases (73 not yet automated, 2 manual by design)
- [ ] External integrations (Jira, Azure DevOps, GitHub, MCP)

## AI agent architecture

Approved target architecture: **three AI agents**, **Planner**, **Generator** and **Healer**,
and one **deterministic Validator**, which is not an AI agent. The standalone Analyzer agent has
been removed from the plan. Today the Planner, the Generator and the Validator are implemented;
the Healer is planned. The Agent Standard, its envelope schema and the Dashboard still describe the
earlier four-agent design; their revision is a separate, pending change. Details and guardrails (H1–H7):
[AI Agent Architecture and Guardrails](docs/09-ai-agent-architecture-and-guardrails.md).

## Getting started

### Prerequisites

- **Git** and **Node.js** with npm. `.nvmrc` pins Node 22; the dashboard and CI require
  **Node 22.22.2 or later** (the root `engines` field alone allows `^20.19.0 || ^22.13.0 || >=24`).

### Installation

```bash
git clone https://github.com/LarysaK/AI-QA-AutomationFramework.git
cd AI-QA-AutomationFramework

nvm use                          # optional: switches to the Node version from .nvmrc
npm install
npx playwright install chromium
cp .env.example .env             # optional; .env is gitignored
```

### Running RequestFlow

```bash
npm run aut:start
```

RequestFlow starts at **http://127.0.0.1:3100** (override with `PORT` and `HOST`).
`GET /health` returns `200 {"status":"ok"}`. State is held in memory, so every restart begins
with no requests.

| User        | User ID      | Role       |
| ----------- | ------------ | ---------- |
| Alex Morgan | `emp-alex`   | `EMPLOYEE` |
| Sam Rivera  | `emp-sam`    | `EMPLOYEE` |
| Jordan Lee  | `rev-jordan` | `REVIEWER` |

Log in by choosing a user on the login page, or by sending its user ID to
`POST /api/auth/login`. There are no passwords.

### Running tests

```bash
npm test                              # starts RequestFlow and runs the suite headless
npm run test:headed                   # the same, in a visible browser
npx playwright test --grep @CAN-004   # one canonical pattern
npx playwright test --grep @REQ-006   # everything traced to a requirement
```

`npm test` starts RequestFlow through Playwright's `webServer` with a test-only reset hook,
resets the state once in `globalSetup`, runs the suite and stops the server. Reports, traces,
screenshots and videos of failed tests go to `artifacts/` (gitignored). Details:
[Playwright framework and local execution](docs/07-playwright-framework-and-local-execution.md).

### Available scripts

| Script                                                        | Purpose                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run aut:start`                                           | Start RequestFlow locally                                                                  |
| `npm test` / `npm run test:headed`                            | Playwright tests, headless / headed                                                        |
| `npm run typecheck` / `npm run lint` / `npm run format:check` | Quality gates                                                                              |
| `npm run format`                                              | Format with Prettier                                                                       |
| `npm run agents:test`                                         | Agent layer tests (fake model; no model calls)                                             |
| `npm run agents:validate`                                     | Validate an agent artifact (seven guards; H7 by `--authorize-execution`)                   |
| `npm run agents:generate`                                     | Generate one test proposal for an approved test case (live mode calls a model)             |
| `npm run agents:plan`                                         | Propose test-planning additions for approved requirements (offline: `--fake-model-output`) |
| `npm run dashboard:data`                                      | Build the validated dashboard snapshot                                                     |
| `npm run dashboard:history`                                   | Export the published CI history for the dashboard                                          |
| `npm run dashboard:test` / `npm run ci:test`                  | Dashboard data and CI record tests                                                         |

## Documentation

Start with the [documentation index](docs/README.md). Key documents:

- [Project overview and architecture](docs/01-project-overview-and-architecture.md)
- [Requirements and traceability](docs/02-requirements-and-traceability.md) and the
  [automation coverage matrix](docs/05-automation-coverage-matrix.md)
- [Complete test case catalog](docs/04-test-case-catalog.md)
- [CI/CD, history publication and reconciliation](docs/10-ci-cd-history-and-reconciliation.md)
- [Dashboard and GitHub Pages](docs/11-dashboard-and-github-pages.md)
- [Known limitations, risks and roadmap](docs/13-limitations-risks-and-roadmap.md)

Authoritative sources: [Requirements v1.2](specs/requestflow/requirements.md),
[Test Plan v1](specs/requestflow/test-plan.md), [Agent Standard v1.2](agents/standard/standard.md),
[ADR-0001](docs/adr/0001-ai-outside-test-runtime.md), [Generator agent v1](docs/generator-agent.md).
