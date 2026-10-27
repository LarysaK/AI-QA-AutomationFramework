# RequestFlow QA Automation Framework — Documentation

This is the documentation package for the RequestFlow QA Automation Framework. It is written
for QA engineers joining the project, for reviewers of the portfolio and for technical
interviews.

> **Audit basis.** Every count and status in this package was derived from the repository at
> commit `76246404d874a5a0919f81e228139fa905d17829` (`main`, 2026-10-27), from Playwright
> discovery of the committed tests, and from the published CI record of run
> [#23](https://github.com/LarysaK/AI-QA-AutomationFramework/actions/runs/40497439668), which
> tested that commit. Where the repository and an earlier report disagree, the repository wins.

## Documents

|     | Document                                                                                              | What it answers                                                             |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A   | [Project Overview and Architecture](01-project-overview-and-architecture.md)                          | What the project is, how it is structured, what is implemented today        |
| B   | [Requirements Specification and Traceability](02-requirements-and-traceability.md)                    | The ten approved requirements, their acceptance criteria and their coverage |
| C   | [Test Strategy and Test Plan](03-test-strategy-and-plan.md)                                           | How the approved test plan designs, levels and prioritizes tests            |
| D   | [Complete Test Case Catalog](04-test-case-catalog.md)                                                 | Every one of the 96 test cases, with steps, status and evidence             |
| E   | [Automation Coverage Matrix](05-automation-coverage-matrix.md)                                        | What is automated, manual by design or not yet automated, at a glance       |
| F   | [Manual Testing Guide](06-manual-testing-guide.md)                                                    | How to execute and record a test case by hand                               |
| G   | [Playwright Automation Framework and Local Execution](07-playwright-framework-and-local-execution.md) | How the automated suite is built and run                                    |
| H   | [Test Data, Environments and Configuration](08-test-data-environments-and-configuration.md)           | Demo users, state, ports, variables and tool versions                       |
| I   | [AI Agent Architecture and Guardrails](09-ai-agent-architecture-and-guardrails.md)                    | The agent layer, the validator, H1–H7 and what AI may not do                |
| J   | [CI/CD, History Publication and Reconciliation](10-ci-cd-history-and-reconciliation.md)               | GitHub Actions, the approval-gated CI history and its audit                 |
| K   | [Dashboard and GitHub Pages](11-dashboard-and-github-pages.md)                                        | The read-only QA Dashboard and its public GitHub Pages site                 |
| L   | [Defect Management and Reporting](12-defect-management-and-reporting.md)                              | How defects are (and are not) recorded                                      |
| M   | [Known Limitations, Risks and Roadmap](13-limitations-risks-and-roadmap.md)                           | Gaps, risks, inconsistencies found and future work                          |
| N   | [Portfolio Demonstration and Interview Guide](14-portfolio-and-interview-guide.md)                    | A demo script and evidence-backed talking points                            |

Existing documents that remain authoritative and are linked, not copied:

- [RequestFlow Requirements v1.2](../specs/requestflow/requirements.md) (frozen baseline)
- [RequestFlow Test Plan v1](../specs/requestflow/test-plan.md) (approved human test design)
- [Agent Standard v2.0](../agents/standard/standard.md) (frozen agent contract: three AI agents and the deterministic Validator)
- [ADR-0001: AI agents are outside the deterministic Playwright runtime](adr/0001-ai-outside-test-runtime.md)
- [Generator Agent v1](generator-agent.md)
- [Planner Agent v1](planner-agent.md)
- [Healer Agent v1](healer-agent.md)
- [QA Dashboard README](../reporting/dashboard/README.md)

## Recommended reading order

1. **A** Overview, for the big picture and the implemented/planned boundary.
2. **B** Requirements, then **C** Test strategy.
3. **E** Coverage matrix, then **D** Catalog for any test case of interest.
4. **G** and **H** to run the suite; **F** to test by hand.
5. **I** AI agents, **J** CI, **K** Dashboard.
6. **L** Defects and **M** Limitations.
7. **N** for a demonstration or an interview.

## Conventions

- **Verified** statements cite a repository path, an identifier or a published CI record.
- **Recommendation** marks a suggestion of this audit. It is not an approved plan.
- **Planned** marks work that is not implemented. It is never presented as existing.
- **Limitation** marks a known gap of the current implementation.
- Demo users: **Alex** = `emp-alex` (EMPLOYEE), **Sam** = `emp-sam` (EMPLOYEE), **Jordan** =
  `rev-jordan` (REVIEWER). They are synthetic identities defined by the requirements.
- Links are relative to this folder. Line anchors (`#L32`) point to the audit commit.

## Regenerating the catalog and matrix

[D](04-test-case-catalog.md) and [E](05-automation-coverage-matrix.md) were generated from the
snapshot (`npm run dashboard:data`), the test plan's rows and the published CI record of the
audit commit. If tests or the plan change, these two documents must be regenerated or reviewed
again; their header names the commit they describe.
