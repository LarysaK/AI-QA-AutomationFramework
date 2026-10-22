# CI history

This branch stores the execution history of the `CI` workflow of
[AI-QA-AutomationFramework](https://github.com/LarysaK/AI-QA-AutomationFramework). It holds
data only: no source code, no workflows, and nothing on it is ever executed.

## Layout (version 1)

| Path                             | Content                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `README.md`                      | This notice                                                            |
| `v1/runs/<runId>-<attempt>.json` | One record per CI run attempt (`ci-run` schema 1.0); immutable         |
| `v1/index.json`                  | Every record, ordered by job completion time; rebuilt on each addition |

## Rules

- Records are created once and never modified or overwritten. A run attempt that has a record
  keeps it; re-running the publisher for it changes nothing.
- The index is derived deterministically from the records and is never edited by hand.
- Only completed `push` and `workflow_dispatch` runs on `main` of this repository are recorded.
  Pull requests and forks are never recorded.
- Every record is validated against the `ci-run` 1.0 schema and a public-safety scan before it
  is published. Records contain counts, step outcomes and test identifiers: no logs, no local
  paths, no credentials and no personal data.
- Records are added by the repository's `CI history` workflow, one commit per run attempt. Force
  pushes and deletion of this branch are not allowed.

## Integrity

The `sha256` values in the index are a consistency check between the index and the record files.
They are not independent tamper evidence; that comes from this branch's git history and its
protection rules. A record shows what the CI job reported, not that the tested software is
correct.

The schemas and the tools that write and verify this branch live on `main` under `reporting/ci/`.
