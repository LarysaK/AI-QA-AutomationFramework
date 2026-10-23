import { Badge, Callout, Card, PageHeader, Stat } from '../components/ui';
import { shortSha } from '../data/derive';
import {
  CONCLUSION_LABEL,
  type Conclusion,
  conclusions,
  type ExecutionHistory,
  findRun,
  formatDuration,
  formatInstant,
  MAPPING_REASON,
  mapResults,
  jobDurationMs,
  resultKey,
  type ResultStatus,
  type RunRecord,
  runPath,
  safeRunUrl,
  SUITES,
  suiteStates,
  type SuiteState,
  testTotals,
  UNPUBLISHED,
} from '../data/history';
import type { Snapshot } from '../data/types';
import { href } from '../router';

const conclusionTone = (c: Conclusion): 'accent' | 'warning' | 'muted' =>
  c === 'success' ? 'accent' : c === 'failure' ? 'warning' : 'muted';
const stateTone = (s: SuiteState): 'accent' | 'warning' | 'outline' =>
  s === 'passed' ? 'accent' : s === 'failed' || s === 'flaky' ? 'warning' : 'outline';
const resultTone = (s: ResultStatus): 'accent' | 'warning' | 'outline' =>
  s === 'passed' ? 'accent' : s === 'skipped' ? 'outline' : 'warning';
const cell = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : String(n);

/** An external link to the GitHub Actions run, only for this repository's exact run URL. */
function RunLink({
  record,
  repository,
  children,
}: {
  record: RunRecord;
  repository: string;
  children: string;
}) {
  const url = safeRunUrl(record, repository);
  if (url === null) return <span>—</span>;
  return (
    <a href={url} rel="noopener noreferrer" className="external">
      {children}
      <span className="visually-hidden">
        {' '}
        (GitHub Actions run #{String(record.run.number)}, opens GitHub)
      </span>
    </a>
  );
}

function Freshness({ history }: { history: ExecutionHistory }) {
  return (
    <p>
      Published runs of the <code>CI</code> workflow on <code>main</code>, read from the{' '}
      <code>ci-history</code> branch at commit <code>{shortSha(history.source.commit)}</code>, last
      updated {formatInstant(history.source.committedAt)}. This is a snapshot taken when the
      dashboard was built; it does not update live.
    </p>
  );
}

function NotIncluded() {
  return (
    <>
      <PageHeader eyebrow="CI execution history" title="Executions" />
      <Card>
        <Callout title="Execution history is not included in this build" tone="empty">
          <p>
            This build of the dashboard was made without an export of the <code>ci-history</code>{' '}
            branch, so no CI runs can be shown. That does not mean no CI runs exist: published runs
            are kept on the <code>ci-history</code> branch, and a build that includes them lists
            them here.
          </p>
        </Callout>
        <p>
          <a href={href('/how-to-read')}>How to read this dashboard</a>
        </p>
      </Card>
    </>
  );
}

function CoverageCard({ history }: { history: ExecutionHistory }) {
  const { coverage } = history;
  if (coverage === null) {
    return (
      <Card title="Coverage of CI runs">
        <Callout title="Coverage was not checked for this build">
          <p>
            Only published records are shown. This build did not compare them with the CI runs that
            GitHub Actions lists, so some CI runs may be missing here. A missing run is not a failed
            run.
          </p>
        </Callout>
      </Card>
    );
  }
  const eligible = coverage.counts['published'] ?? 0;
  const total = eligible + coverage.missingAttempts;
  return (
    <Card title="Coverage of CI runs">
      <p className="card-intro">
        When this dashboard was built, GitHub Actions listed {String(coverage.runsListed)} runs of
        the <code>CI</code> workflow on <code>main</code>
        {coverage.listingComplete ? '' : ' (an incomplete listing)'}.{' '}
        <strong>
          {String(eligible)} of {String(total)} eligible run attempts are published
        </strong>
        {coverage.verdict === 'undetermined' ? '; others may be missing from the listing.' : '.'}
      </p>
      {coverage.unpublished.length > 0 && (
        <>
          <div
            className="table-scroll"
            role="region"
            aria-label="Eligible runs without a published record"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col" className="num">
                    Attempt
                  </th>
                  <th scope="col">Why there is no record</th>
                </tr>
              </thead>
              <tbody>
                {coverage.unpublished.map((u) => (
                  <tr key={`${String(u.runId)}-${String(u.attempt)}`}>
                    <th scope="row">#{String(u.runNumber)}</th>
                    <td className="num">{String(u.attempt)}</td>
                    <td>{UNPUBLISHED[u.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine-print">
            These runs have no published record, so this dashboard has no results for them. A run
            without a record did not necessarily fail, and “no artifact listed” is not evidence that
            a run did not happen. Records are never backfilled.
          </p>
        </>
      )}
    </Card>
  );
}

export function ExecutionsPage({ history }: { history: ExecutionHistory | null }) {
  if (history === null) return <NotIncluded />;
  const { records, source } = history;
  const latest = records[0];
  const counts = conclusions(history);

  return (
    <>
      <PageHeader eyebrow="CI execution history" title="Executions">
        <Freshness history={history} />
      </PageHeader>

      {latest === undefined ? (
        <Card>
          <Callout title="No published CI runs yet" tone="empty">
            <p>
              The <code>ci-history</code> branch holds no run records at this commit. Records are
              added only after an eligible CI run on <code>main</code> completes and its publication
              is approved.
            </p>
          </Callout>
        </Card>
      ) : (
        <>
          <dl className="stats" aria-label="Published CI runs">
            <Stat
              label="Published runs"
              value={String(records.length)}
              detail="Records on the ci-history branch"
            />
            <Stat
              label="Latest published run"
              value={`#${String(latest.run.number)}`}
              detail={`${CONCLUSION_LABEL[latest.conclusion]} · ${formatInstant(latest.timestamps.jobCompletedAt)}`}
              tone="accent"
            />
            <Stat
              label="Conclusions"
              value={(Object.keys(counts) as Conclusion[])
                .filter((c) => counts[c] > 0)
                .map((c) => `${String(counts[c])} ${CONCLUSION_LABEL[c].toLowerCase()}`)
                .join(', ')}
              detail="Of published runs only"
            />
            <Stat
              label="Tests passed in the latest run"
              value={`${String(testTotals(latest).passed)} of ${String(testTotals(latest).total)}`}
              detail={`Across ${String(latest.suites.length)} CI test suites${testTotals(latest).complete ? '' : '; some suites reported no counts'}`}
            />
          </dl>

          <Card title="Published runs">
            <div className="table-scroll" role="region" aria-label="Published runs" tabIndex={0}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Completed (UTC)</th>
                    <th scope="col">Commit</th>
                    <th scope="col">Conclusion</th>
                    <th scope="col">Suites</th>
                    <th scope="col" className="num">
                      Tests passed
                    </th>
                    <th scope="col">GitHub</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => {
                    const totals = testTotals(record);
                    const states = suiteStates(record);
                    return (
                      <tr key={runPath(record)}>
                        <th scope="row">
                          <a href={href(runPath(record))}>
                            #{String(record.run.number)}
                            {record.run.attempt > 1
                              ? ` (attempt ${String(record.run.attempt)})`
                              : ''}
                          </a>
                        </th>
                        <td>{formatInstant(record.timestamps.jobCompletedAt)}</td>
                        <td>
                          <code>{shortSha(record.commitSha)}</code>
                        </td>
                        <td>
                          <Badge tone={conclusionTone(record.conclusion)}>
                            {CONCLUSION_LABEL[record.conclusion]}
                          </Badge>
                        </td>
                        <td>
                          {(Object.keys(states) as SuiteState[])
                            .filter((s) => states[s] > 0)
                            .map((s) => `${String(states[s])} ${s}`)
                            .join(', ')}
                        </td>
                        <td className="num">
                          {String(totals.passed)} of {String(totals.total)}
                          {totals.failed > 0 ? ` (${String(totals.failed)} failed)` : ''}
                          {totals.complete ? '' : ' *'}
                        </td>
                        <td>
                          <RunLink record={record} repository={source.repository}>
                            View run
                          </RunLink>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="fine-print">
              Newest first. Counts are what each CI job reported for its test suites, as recorded at
              publication; they are not per-test-case results. * Some suites reported no counts.
            </p>
          </Card>
        </>
      )}

      <CoverageCard history={history} />
    </>
  );
}

export function ExecutionDetail({
  history,
  snapshot,
  runKey,
}: {
  history: ExecutionHistory | null;
  snapshot: Snapshot;
  runKey: string;
}) {
  const record = history === null ? undefined : findRun(history, runKey);
  if (history === null || record === undefined) {
    return (
      <PageHeader eyebrow="Executions" title="Run not found">
        <p>
          No published record <code>{runKey}</code> is included in this build.{' '}
          <a href={href('/executions')}>Back to executions</a>
        </p>
      </PageHeader>
    );
  }
  const mapping = mapResults(record, snapshot);
  const results = record.playwright?.results ?? [];
  const byStatus = (status: ResultStatus) => results.filter((r) => r.status === status).length;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href={href('/executions')}>Executions</a> <span aria-hidden="true">/</span>{' '}
        <span aria-current="page">Run #{String(record.run.number)}</span>
      </nav>
      <PageHeader
        eyebrow={`CI run · attempt ${String(record.run.attempt)}`}
        title={`Run #${String(record.run.number)}`}
      >
        <div className="badges">
          <Badge tone={conclusionTone(record.conclusion)}>
            {CONCLUSION_LABEL[record.conclusion]}
          </Badge>
          <Badge>{record.trigger.event}</Badge>
          <Badge>
            <code>{shortSha(record.commitSha)}</code>
          </Badge>
        </div>
      </PageHeader>

      <Card title="Run">
        <dl className="meta-list">
          {(
            [
              ['Workflow / job', `${record.workflow} / ${record.job}`],
              ['Trigger', `${record.trigger.event} on ${record.trigger.ref}`],
              ['Commit', <code key="c">{record.commitSha}</code>],
              ['Run created', formatInstant(record.timestamps.runCreatedAt)],
              ['Job started', formatInstant(record.timestamps.jobStartedAt)],
              ['Job completed', formatInstant(record.timestamps.jobCompletedAt)],
              ['Job duration', formatDuration(jobDurationMs(record))],
              ['Runner', record.environment.runnerLabel ?? '—'],
              [
                'Node.js / Playwright',
                `${record.environment.node ?? '—'} / ${record.environment.playwright ?? '—'}`,
              ],
              [
                'GitHub Actions',
                <RunLink key="l" record={record} repository={history.source.repository}>
                  Open the original run
                </RunLink>,
              ],
            ] as const
          ).map(([label, value]) => (
            <div className="meta-row" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Test suites">
        <div className="table-scroll" role="region" aria-label="Test suites" tabIndex={0}>
          <table className="data-table exec-table">
            <thead>
              <tr>
                <th scope="col">Suite</th>
                <th scope="col">State</th>
                {['Passed', 'Failed', 'Flaky', 'Skipped', 'Todo', 'Cancelled', 'Total'].map((h) => (
                  <th scope="col" className="num" key={h}>
                    {h}
                  </th>
                ))}
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {record.suites.map((suite) => (
                <tr key={suite.id}>
                  <th scope="row">
                    {SUITES[suite.id].label}
                    <span className="cell-note">{SUITES[suite.id].about}</span>
                  </th>
                  <td>
                    <Badge tone={stateTone(suite.state)}>{suite.state}</Badge>
                  </td>
                  {(
                    ['passed', 'failed', 'flaky', 'skipped', 'todo', 'cancelled', 'total'] as const
                  ).map((k) => (
                    <td className="num" key={k}>
                      {cell(suite.counts?.[k])}
                    </td>
                  ))}
                  <td>{formatDuration(suite.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine-print">
          “—” means the tool does not report that category, or the suite did not run or complete.
          The agent suite tests the AI agent layer with a fake model: it is a CI test suite, not a
          record of live AI model runs.
        </p>
      </Card>

      {record.playwright !== null && (
        <Card title="Playwright test results">
          <dl className="stats stats-compact" aria-label="Playwright results">
            <Stat label="Passed" value={String(byStatus('passed'))} />
            <Stat label="Failed" value={String(byStatus('failed'))} />
            <Stat label="Flaky" value={String(byStatus('flaky'))} />
            <Stat label="Skipped" value={String(byStatus('skipped'))} />
            <Stat label="Global errors" value={String(record.playwright.globalErrors)} />
          </dl>
          <p className="card-intro">
            One result per test instance, as Playwright reported it in this run.{' '}
            {mapping.status === 'unavailable' ? (
              <>
                Results are not related to test cases:{' '}
                {MAPPING_REASON[mapping.reason ?? 'no-results']} (snapshot{' '}
                <code>{shortSha(snapshot.source.commit)}</code>, Playwright{' '}
                {snapshot.source.discovery.playwrightVersion}). Instances are listed by ID.
              </>
            ) : (
              <>
                This run tested this dashboard’s snapshot commit with the same Playwright version,
                so each result whose instance is committed in the snapshot is shown with its test
                and the test cases linked to it in both directions.
              </>
            )}
          </p>
          <div
            className="table-scroll"
            role="region"
            aria-label="Playwright test results"
            tabIndex={0}
          >
            <table className="data-table exec-table">
              <thead>
                <tr>
                  <th scope="col">Test</th>
                  {mapping.status === 'mapped' && <th scope="col">Test cases</th>}
                  <th scope="col">Project</th>
                  <th scope="col">Result</th>
                  <th scope="col" className="num">
                    Attempts
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.map((result, i) => {
                  const link = mapping.links.get(resultKey(result));
                  return (
                    <tr key={`${String(i)} ${result.instanceId} ${result.project}`}>
                      <th scope="row">
                        {link?.kind === 'mapped' ? (
                          link.instance.title
                        ) : (
                          <>
                            <code>{result.instanceId}</code>
                            {link !== undefined && (
                              <span className="cell-note">
                                {link.kind === 'ambiguous' ? 'Ambiguous: ' : 'Not mapped: '}
                                {link.why}
                              </span>
                            )}
                          </>
                        )}
                      </th>
                      {mapping.status === 'mapped' && (
                        <td>
                          {link?.kind !== 'mapped' || link.testCases.length === 0
                            ? '—'
                            : link.testCases.map((tc, j) => (
                                <span key={tc}>
                                  {j > 0 && ', '}
                                  <a href={href(`/test-cases/${tc}`)} className="mono">
                                    {tc}
                                  </a>
                                </span>
                              ))}
                          {link?.kind === 'mapped' && link.unconfirmed.length > 0 && (
                            <span className="cell-note">
                              Not confirmed by the snapshot’s linkage: {link.unconfirmed.join(', ')}
                            </span>
                          )}
                        </td>
                      )}
                      <td>{result.project}</td>
                      <td>
                        <Badge tone={resultTone(result.status)}>{result.status}</Badge>
                      </td>
                      <td className="num">{String(result.attempts)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Steps">
        <details className="source-text">
          <summary>
            {String(record.steps.length)} steps of the <code>{record.job}</code> job
          </summary>
          <ul className="plain-list step-list">
            {record.steps.map((step, i) => (
              <li key={`${String(i)} ${step.name}`}>
                <span>{step.name}</span>{' '}
                <Badge
                  tone={
                    step.conclusion === 'success'
                      ? 'accent'
                      : step.conclusion === 'skipped'
                        ? 'outline'
                        : 'warning'
                  }
                >
                  {step.conclusion}
                </Badge>
              </li>
            ))}
          </ul>
        </details>
      </Card>
    </>
  );
}
