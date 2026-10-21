# CI run record test fixtures

Test inputs for `reporting/ci/ci.test.ts`. They are **not** CI history: no run record is
stored or published from them.

Every report here is real output of the tool that produces it. Absolute paths of the machine
that generated them were replaced with runner-style placeholders (`/home/runner/work/...`), and
its home directory, user name and host name were removed. Variants (truncated, inconsistent,
tampered or time-shifted inputs) are derived inside the tests, which say so.

| File                                                                    | Produced by                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright/mixed.json`                                                 | Playwright 1.63.0 on `sources/playwright-synthetic.spec.ts.txt` with `sources/playwright.config.ts.txt` (`retries: 1`): one pass, one failure on both attempts, one flaky test (fails, then passes on retry), one skipped test    |
| `playwright/import-error.json`                                          | The same configuration on `sources/playwright-import-error.spec.ts.txt`, a file that throws while loading: no tests, two global errors                                                                                            |
| `playwright/repository-pass.json`                                       | `npm test` in this repository at commit `11f78cd`                                                                                                                                                                                 |
| `tap/mixed.tap`                                                         | `npx tsx --test sources/node-synthetic.test.ts.txt` (renamed to `.ts`): pass, fail, skip, todo, nested suites, a timed-out parent (Node counts it and its child as cancelled), and a test printing text that looks like a summary |
| `tap/repository-pass.tap`                                               | `npm run dashboard:test` at commit `11f78cd`, stdout (Node's default reporter when stdout is not a terminal is TAP)                                                                                                               |
| `vitest/mixed.json`, `vitest/import-error.json`                         | Vitest 5.0.4 `--reporter=json` on a temporary suite: pass, fail, skip and todo; and a file that throws while loading                                                                                                              |
| `vitest/repository-pass.json`                                           | `npm --prefix reporting/dashboard run test -- --reporter=json` at commit `11f78cd`                                                                                                                                                |
| `github/run-39144953322.json`, `github/jobs-39144953322-attempt-1.json` | The public GitHub Actions API responses for CI run #2 (push to `main`, commit `11f78cd`), trimmed to the fields the collector reads plus two decoy fields that must never be copied (`actor`, `display_title`)                    |
| `github/workflow-run-event-39144953322.json`                            | **Synthetic**: run #2's public API data arranged in the shape of a `workflow_run` event payload (`action`, `repository`, `workflow_run` with `repository` and `head_repository`). No real event payload has been captured yet.    |
| `snapshot/dashboard-data.json`                                          | `npm run dashboard:data` at commit `11f78cd`                                                                                                                                                                                      |

The `sources/*.txt` files are kept as text so they are never compiled, linted or discovered by
any test runner. To regenerate a report, copy the source to a temporary folder (for Playwright
and Vitest, inside the package that provides the runner, so it can be resolved), run the command
above, and replace machine-specific paths before committing.

**Hand-off data (Phase 5.3 M3c) is synthetic.** `handoff.test.ts` derives, inside the tests, the
attempt-scoped run and jobs responses (run #2's data plus `head_repository` and the three M3c
steps), the artifact listings (IDs, digests, sizes and timestamps are invented) and the artifact
contents (the snapshot above and suite results collected from the repository-pass reports). No
run with hand-off artifacts, and no real `workflow_run` payload, has been observed yet; the
first real dry run's field-shape table (`event-shape.mjs`) is how the event fixture is checked.
