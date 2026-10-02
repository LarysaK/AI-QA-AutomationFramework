# AI-Assisted QA Automation Framework

A TypeScript + Playwright test automation framework with an AI agent layer that covers the
QA lifecycle: **requirements → test planning → test generation → execution → failure analysis
→ healing → reporting**.

The project shows how AI can speed up test engineering **without** making the test suite
non-deterministic, hard to audit, or dependent on an LLM to run.

## Architecture principle

> **AI is outside the Playwright runtime.**
> The test framework is deterministic and fully executable without an LLM.
> AI agents only _propose_ artifacts and patches; deterministic code validates every
> proposal, and a human approves it at defined gates.

Running Playwright tests never requires an LLM, an AI API key, or any AI tool or provider
(Claude, Copilot or others). You can remove the whole `agents/` directory and `npm test`
still works. See [ADR-0001](docs/adr/0001-ai-outside-test-runtime.md).

The demo application under test, RequestFlow, contains no AI functionality either.

## High-level architecture

```
   HUMAN ──▶ prompts/  (thin entry points: scope + parameters, no rules)
                │
┌───────────────▼──────────────────────────────────────────────────────┐
│ AI LAYER  agents/                                                    │
│   standard/      ONE shared contract: rules (by ID) + artifact schemas│
│   definitions/   Planner · Generator · Analyzer · Healer             │
│   orchestrator/  deterministic pipeline: context → LLM → schema      │
│                  validation → guards → staging → human approval      │
└───────────────┬──────────────────────────────────────┬───────────────┘
                │ proposes (never applies directly)    │ reads results
┌───────────────▼──────────────────────────┐   ┌───────┴──────────────┐
│ DETERMINISTIC RUNTIME (no AI)            │   │ reporting/           │
│   specs/      requirements · test cases  │   │ traceability:        │
│   tests/      Playwright specs           │   │ REQ → TC → result    │
│   apps/<aut>/ AUT source · page objects  │   └──────────────────────┘
│   framework/  fixtures · base classes ·  │
│               config · public API        │
└──────────────────────────────────────────┘
 integrations/  ports + adapters (local files first; Jira / Azure DevOps / GitHub / MCP later)
 docs/          architecture notes and ADRs
```

| Directory       | Responsibility                                                                               |
| --------------- | -------------------------------------------------------------------------------------------- |
| `framework/`    | App-agnostic Playwright runtime: fixtures, base classes, config, data, API                   |
| `apps/`         | One folder per application under test: AUT source (`app/`), later page objects and test data |
| `tests/`        | Playwright specs: test flow and business assertions only                                     |
| `specs/`        | Behavioral source of truth: requirements, test plans, test cases                             |
| `agents/`       | AI layer: shared standard, agent definitions, orchestrator                                   |
| `prompts/`      | Human-triggered entry points into the agent layer                                            |
| `integrations/` | Interfaces to external systems and their adapters                                            |
| `reporting/`    | Custom reporters and traceable run reports                                                   |
| `docs/`         | Architecture documentation and Architecture Decision Records                                 |
| `artifacts/`    | Run outputs, traces, reports, AI proposals (gitignored)                                      |

## Current project status

**Phase 0: Foundation (in progress).** The project skeleton, the demo application under test,
the human QA test plan and the first canonical reference test are in place.

Foundation:

- [x] Repository initialized with the Architecture v1 directory structure
- [x] Node environment defined (`.nvmrc`, `engines` in `package.json`)
- [x] TypeScript configured (strict mode)
- [x] Playwright configured
- [x] ESLint configured
- [x] Prettier configured
- [x] Validation passing (typecheck, lint, format check)
- [x] [ADR-0001](docs/adr/0001-ai-outside-test-runtime.md): AI outside the test runtime

Demo application ([RequestFlow v1](#demo-application-requestflow)):

- [x] Local server-rendered UI and JSON API
- [x] Employee and Reviewer roles with cookie-based demo authentication
- [x] Request lifecycle: `DRAFT → SUBMITTED → APPROVED / REJECTED`
- [x] Server-side authorization and validation
- [x] Deterministic in-memory state

Test design and reference tests:

- [x] [Human QA test plan](specs/requestflow/test-plan.md) for REQ-001 – REQ-010
- [x] CAN-001: Employee creates a valid request (passing)
- [x] Playwright starts and resets RequestFlow automatically

Not implemented yet:

- [ ] Remaining canonical reference tests (CAN-002 – CAN-005)
- [ ] Agent contracts (shared standard, artifact schemas)
- [ ] AI agents: Planner / Generator / Analyzer / Healer
- [ ] LLM integration
- [ ] External integrations (Jira, Azure DevOps, GitHub, MCP)

## Demo application: RequestFlow

RequestFlow is a small local application under test (AUT) built specifically for this QA
automation portfolio. It models a generic request-and-approval workflow and provides:

- a multi-role workflow (**Employee** creates and submits requests, **Reviewer** approves or
  rejects them);
- the same business rules through a UI and a JSON API;
- state transitions with terminal states;
- authorization by role and ownership;
- validation with stable, machine-readable error codes;
- deterministic local data, with no database or external services.

```
DRAFT → SUBMITTED → APPROVED
                  ↘ REJECTED
```

The behavioral source of truth is
[RequestFlow Requirements v1.2](specs/requestflow/requirements.md). The application code lives
in [`apps/requestflow/app/`](apps/requestflow/app/).

## Test design and canonical tests

The [human QA test plan](specs/requestflow/test-plan.md) was written by hand, before any agent
exists. It derives the test inventory from the requirements and traces every scenario to a
requirement ID (REQ-001 – REQ-010).

**Canonical tests** are a small set of handwritten reference tests selected from that plan.
They fix the patterns for structure, semantic locators, page objects, test data and
assertions. In a later phase, the Generator Agent will follow these patterns when it proposes
further tests. The agent does not exist yet.

| Canonical test | Scenario                         | Level | Traceability                  | Status          |
| -------------- | -------------------------------- | ----- | ----------------------------- | --------------- |
| CAN-001        | Employee creates a valid request | UI    | REQ-001 → TC-001-17 → CAN-001 | Implemented     |
| CAN-002        | Request validation boundaries    | API   | REQ-001 → TC-001-03 – 12      | Not implemented |
| CAN-003        | Employee edits own draft         | API   | REQ-002 → TC-002-01, 02, 04   | Not implemented |
| CAN-004        | Request approval workflow        | E2E   | REQ-005, REQ-008              | Not implemented |
| CAN-005        | Request rejection workflow       | E2E   | REQ-006, REQ-008              | Not implemented |

CAN-001 lives in
[`tests/requestflow/ui/create-request.spec.ts`](tests/requestflow/ui/create-request.spec.ts)
and is tagged `@REQ-001 @TC-001-17 @CAN-001`. Its page objects are in
[`apps/requestflow/pages/`](apps/requestflow/pages/).

## Planned phases

| Phase | Scope                                                                               |
| ----- | ----------------------------------------------------------------------------------- |
| 0     | **Foundation:** framework core, first AUT, handwritten reference tests, lint rules  |
| 1     | **Contracts:** shared agent standard, artifact schemas, structured test case format |
| 2     | **First vertical slice:** Planner → human approval → Generator → guards → execution |
| 3     | **Analysis:** Analyzer agent classifies failures; AI run report                     |
| 4     | **Healing:** Healer agent with assertion guard, validation reruns, human approval   |

## Getting started

### Prerequisites

- **Git**
- **Node.js** in a version that satisfies `engines` in `package.json`:
  `^20.19.0 || ^22.13.0 || >=24`
- **npm** (included with Node.js)

The repository includes an `.nvmrc` that pins Node 22. Using [nvm](https://github.com/nvm-sh/nvm)
is recommended but not required: any compatible Node.js installation works.

### Installation

```bash
git clone <repository-url>
cd ai-qa-automation

nvm use                          # optional: switches to the Node version from .nvmrc
npm install
npx playwright install chromium
```

`npm install` installs all development dependencies declared in `package.json`, including
Playwright, TypeScript, ESLint and Prettier. You don't need to install any of them separately.

`npx playwright install chromium` downloads the Chromium browser that Playwright runs tests in.

### Running RequestFlow

```bash
npm run aut:start
```

RequestFlow starts at **http://127.0.0.1:3100** (override with the `PORT` and `HOST`
environment variables). `GET /health` returns `200 {"status":"ok"}` and can be used as a
readiness check. State is held in memory, so every restart begins with no requests.

Starting RequestFlow manually is only needed to explore it in a browser. `npm test` starts
it by itself (see [Running tests](#running-tests)).

### Demo users

RequestFlow v1 uses simplified demo login: you choose one of the fixed synthetic users on the
login page (or send its user ID to `POST /api/auth/login`). There are no passwords, OAuth or
SSO.

| User        | User ID      | Role       |
| ----------- | ------------ | ---------- |
| Alex Morgan | `emp-alex`   | `EMPLOYEE` |
| Sam Rivera  | `emp-sam`    | `EMPLOYEE` |
| Jordan Lee  | `rev-jordan` | `REVIEWER` |

### Environment configuration

```bash
cp .env.example .env
```

`.env` is gitignored and loaded automatically by `playwright.config.ts`.

| Variable   | Purpose                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `BASE_URL` | URL of RequestFlow for Playwright. Default when empty: `http://127.0.0.1:3100` |

The default works without changes. Never commit real credentials or secrets.

### Validate the development environment

```bash
npm run typecheck      # TypeScript compiles in strict mode with no type errors
npm run lint           # ESLint rules (TypeScript + Playwright) pass
npm run format:check   # all files match Prettier formatting
```

### Running tests

```bash
npm test               # run Playwright tests headless
npm run test:headed    # run tests in a visible browser
```

You don't need to start RequestFlow first. `npm test`:

1. starts RequestFlow (`npm run aut:start`) through Playwright's `webServer`;
2. waits until `GET /health` responds;
3. enables the test-only reset hook (`POST /__test/reset`) for that server;
4. resets the application state once in `globalSetup`, so every run starts from the same
   deterministic state;
5. runs the Playwright suite;
6. stops the server afterwards.

Outside CI, Playwright reuses a RequestFlow server that is already running on the same address
and leaves it running. That server must have been started with the test hooks enabled,
otherwise `globalSetup` stops the run with an explanatory error. Stop it and let Playwright
start its own.

The reset hook exists only for automated tests. It is not part of the RequestFlow API, and a
server started with `npm run aut:start` does not have it.

Test results, HTML reports, and traces, screenshots and videos of failed tests are written to
`artifacts/` (gitignored).

### Available scripts

| Script                 | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `npm run aut:start`    | Start RequestFlow locally                           |
| `npm test`             | Start RequestFlow and run Playwright tests headless |
| `npm run test:headed`  | Same, in a visible browser                          |
| `npm run lint`         | ESLint                                              |
| `npm run typecheck`    | TypeScript type check                               |
| `npm run format`       | Format with Prettier                                |
| `npm run format:check` | Verify formatting                                   |

## Documentation

- [RequestFlow Requirements v1.2](specs/requestflow/requirements.md): approved behavioral
  baseline of the demo application
- [RequestFlow Test Plan v1](specs/requestflow/test-plan.md): human QA test design,
  traceability and canonical test candidates
- [ADR-0001](docs/adr/0001-ai-outside-test-runtime.md): AI agents are outside the deterministic
  Playwright runtime
