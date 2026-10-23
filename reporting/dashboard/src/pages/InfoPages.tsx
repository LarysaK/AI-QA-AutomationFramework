import { Callout, Card, PageHeader } from '../components/ui';
import type { VerifiedAgentLayer } from '../data/agents';
import { shortSha } from '../data/derive';
import { type ExecutionHistory, formatInstant } from '../data/history';
import type { Snapshot } from '../data/types';
import { href } from '../router';

export function HowToRead({
  snapshot,
  history = null,
  agents = null,
}: {
  snapshot: Snapshot;
  history?: ExecutionHistory | null;
  agents?: VerifiedAgentLayer | null;
}) {
  const { source, summary } = snapshot;
  const coverage = `${String(summary.linkedTestCasesWithIntentYes)} of ${String(summary.testCasesByAutomationIntent.Yes)}`;
  return (
    <>
      <PageHeader eyebrow="Definitions" title="How to read this dashboard">
        <p>
          Every figure comes from validated build-time data: the snapshot of the approved documents
          and committed tests, when included the published CI history, and the agent layer facts,
          checked against committed files. Four measures are kept apart, because each one says less
          than it may seem to.
        </p>
      </PageHeader>

      <Card title="Four separate measures">
        <dl className="definitions">
          <div>
            <dt>Planned test case</dt>
            <dd>
              An entry in the approved human test plan, with an ID such as <code>TC-003-07</code>,
              its requirement, level, type, priority and one scenario sentence. Planned says nothing
              about automation.
            </dd>
          </div>
          <div>
            <dt>Automation intent</dt>
            <dd>
              The plan's own <em>Automation</em> column: <em>Yes</em> means the test case is meant
              to be automated; <em>No</em> means the plan does not currently automate it (the plan
              gives the reason). Intent is a plan decision, not progress.
            </dd>
          </div>
          <div>
            <dt>Linked automation</dt>
            <dd>
              At least one committed Playwright test carries the test case's <code>@TC-…</code> tag,
              as discovered by Playwright itself. A link is traceability: it does not prove that
              every data row or behaviour in the scenario is exercised. Uncommitted tests and
              AI-generated proposals never count.
            </dd>
          </div>
          <div>
            <dt>Executed in CI</dt>
            <dd>
              A result recorded by a published CI run for a specific commit. Suite counts are per
              suite, not per test case. A test case shows a CI result only when a published run
              tested this dashboard’s snapshot commit, from the results of exactly its linked test
              instances. A CI run without a published record is not a failed run. Local runs are
              never published as results.
            </dd>
          </div>
        </dl>
        <Callout title={`Why linked coverage is shown as “${coverage}”`}>
          <p>
            “Linked coverage” counts linked test cases among those the plan intends to automate.
            Test cases marked <em>Automation: No</em> are shown separately and are not counted as
            unlinked. Colours stay neutral: green is reserved for real execution results.
          </p>
        </Callout>
      </Card>

      <Card title="Data provenance">
        <dl className="meta-list">
          <div className="meta-row">
            <dt>Source commit</dt>
            <dd>
              <code>{source.commit}</code>
            </dd>
          </div>
          {source.documents.map((document) => (
            <div className="meta-row" key={document.path}>
              <dt>{document.title}</dt>
              <dd>
                <code>{document.path}</code> · blob <code>{shortSha(document.gitBlobSha)}</code>
              </dd>
            </div>
          ))}
          <div className="meta-row">
            <dt>Committed tests</dt>
            <dd>
              <code>{source.discovery.method}</code> on <code>{source.discovery.testDir}/</code>,
              Playwright {source.discovery.playwrightVersion}
            </dd>
          </div>
          <div className="meta-row">
            <dt>Snapshot schema</dt>
            <dd>{snapshot.schemaVersion}</dd>
          </div>
          <div className="meta-row">
            <dt>CI execution history</dt>
            <dd>
              {history === null ? (
                'Not included in this build'
              ) : (
                <>
                  <code>ci-history</code> branch at <code>{history.source.commit}</code>, last
                  updated {formatInstant(history.source.committedAt)};{' '}
                  {String(history.source.records)} published run record
                  {history.source.records === 1 ? '' : 's'}; a build-time snapshot, not live
                </>
              )}
            </dd>
          </div>
          <div className="meta-row">
            <dt>AI agent layer facts</dt>
            <dd>
              {agents === null ? (
                'Not included in this build'
              ) : (
                <>
                  Checked against the committed files of commit <code>{agents.commit}</code> when
                  this site was built; no agent activity is recorded or shown
                </>
              )}
            </dd>
          </div>
          <div className="meta-row">
            <dt>Defect register</dt>
            <dd>Not connected; no defect records are shown or derived</dd>
          </div>
        </dl>
        <p className="fine-print">
          The snapshot is built only when the approved documents, the tests and everything
          Playwright loads are committed and unmodified. It is validated against its JSON Schema and
          scanned for local paths and credentials before it is written, and validated and
          safety-scanned again, with the same checks, when this site is built.
        </p>
      </Card>

      <Card title="What is deliberately not shown">
        <ul className="plain-list">
          <li>Raw Playwright reports, traces, screenshots, stdout or stderr.</li>
          <li>Local paths, environment variables or credentials.</li>
          <li>
            AI-generated test proposals or their code, which stay outside the repository until a
            human applies them.
          </li>
          <li>
            Execution history that was not published: no CI run is invented, and no unpublished run
            is counted as passed or failed.
          </li>
          <li>Live AI model activity: the agent suite in CI is tested with a fake model.</li>
          <li>
            Defects derived from test results: a failed test is an execution result, not a defect
            record.
          </li>
        </ul>
      </Card>
    </>
  );
}

export function NotFound() {
  return (
    <PageHeader eyebrow="Not found" title="Page not found">
      <p>
        This page does not exist. <a href={href('/')}>Go to the overview</a>
      </p>
    </PageHeader>
  );
}
