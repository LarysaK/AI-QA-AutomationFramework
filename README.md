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
│   apps/<aut>/ page objects · data        │   └──────────────────────┘
│   framework/  fixtures · base classes ·  │
│               config · public API        │
└──────────────────────────────────────────┘
 integrations/  ports + adapters (local files first; Jira / Azure DevOps / GitHub / MCP later)
 docs/          architecture notes and ADRs
```

| Directory       | Responsibility                                                              |
| --------------- | --------------------------------------------------------------------------- |
| `framework/`    | App-agnostic Playwright runtime: fixtures, base classes, config, data, API  |
| `apps/`         | One adapter per application under test: page objects, components, test data |
| `tests/`        | Playwright specs: test flow and business assertions only                    |
| `specs/`        | Behavioral source of truth: requirements, test plans, test cases            |
| `agents/`       | AI layer: shared standard, agent definitions, orchestrator                  |
| `prompts/`      | Human-triggered entry points into the agent layer                           |
| `integrations/` | Interfaces to external systems and their adapters                           |
| `reporting/`    | Custom reporters and traceable run reports                                  |
| `docs/`         | Architecture documentation and Architecture Decision Records                |
| `artifacts/`    | Run outputs, traces, reports, AI proposals (gitignored)                     |

## Current project status

**Phase 0: Foundation (in progress).** The project skeleton is in place and validated.

Foundation:

- [x] Repository initialized with the Architecture v1 directory structure
- [x] Node environment defined (`.nvmrc`, `engines` in `package.json`)
- [x] TypeScript configured (strict mode)
- [x] Playwright configured
- [x] ESLint configured
- [x] Prettier configured
- [x] Validation passing (typecheck, lint, format check)
- [x] [ADR-0001](docs/adr/0001-ai-outside-test-runtime.md): AI outside the test runtime

Not implemented yet:

- [ ] Demo application under test
- [ ] Reference tests
- [ ] Agent contracts (shared standard, artifact schemas)
- [ ] Planner / Generator / Analyzer / Healer agents
- [ ] LLM integration
- [ ] External integrations (Jira, Azure DevOps, GitHub, MCP)

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

### Environment configuration

```bash
cp .env.example .env
```

`.env` is gitignored and loaded automatically by `playwright.config.ts`.

| Variable   | Purpose                                                               |
| ---------- | --------------------------------------------------------------------- |
| `BASE_URL` | Base URL of the application under test, used by Playwright navigation |

No demo application has been selected or configured yet, so `BASE_URL` can stay empty.
This configuration will evolve during Phase 0. Never commit real credentials or secrets.

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

The repository does not contain any reference tests yet. At the current Foundation stage,
Playwright reports `Error: No tests found` and exits with a non-zero code. This is expected.

Test results, traces and HTML reports are written to `artifacts/` (gitignored).

### Available scripts

| Script                 | Purpose                        |
| ---------------------- | ------------------------------ |
| `npm test`             | Run Playwright tests headless  |
| `npm run test:headed`  | Run tests in a visible browser |
| `npm run lint`         | ESLint                         |
| `npm run typecheck`    | TypeScript type check          |
| `npm run format`       | Format with Prettier           |
| `npm run format:check` | Verify formatting              |
