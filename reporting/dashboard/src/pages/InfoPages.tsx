import { Callout, Card, PageHeader } from '../components/ui';
import { shortSha } from '../data/derive';
import type { Snapshot } from '../data/types';
import { href } from '../router';

export function HowToRead({ snapshot }: { snapshot: Snapshot }) {
  const { source, summary } = snapshot;
  const coverage = `${String(summary.linkedTestCasesWithIntentYes)} of ${String(summary.testCasesByAutomationIntent.Yes)}`;
  return (
    <>
      <PageHeader eyebrow="Definitions" title="How to read this dashboard">
        <p>
          Every figure comes from one validated snapshot. Four measures are kept apart, because each
          one says less than it may seem to.
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
              A pass or fail recorded by a CI run for a specific commit.{' '}
              <strong>No CI runs exist yet</strong>, so the dashboard shows no results. Local runs
              are not published as results.
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
          <li>Execution history that does not exist.</li>
        </ul>
      </Card>
    </>
  );
}

const UNAVAILABLE = {
  executions: {
    title: 'Executions',
    body: 'CI is not connected yet. When it is, this page will list real CI runs, each with its commit, workflow run and per-test results. Until then there is nothing to show, and local runs are not published.',
  },
  'ai-agents': {
    title: 'AI Agents',
    body: 'The agent layer (a Generator agent, a deterministic validator and human approval gates) exists in the repository, but its activity is not exported to this dashboard yet. Proposals will only be shown from a reviewed, sanitized export, and never their code.',
  },
  defects: {
    title: 'Defects',
    body: 'No defect records exist yet. This page will list defects backed by real evidence, and later a Jira integration, linked to test cases by ID.',
  },
} as const;

export function NotAvailable({ kind }: { kind: keyof typeof UNAVAILABLE }) {
  const page = UNAVAILABLE[kind];
  return (
    <>
      <PageHeader eyebrow="Not available yet" title={page.title} />
      <Card>
        <Callout title="This integration is not connected" tone="empty">
          <p>{page.body}</p>
        </Callout>
        <p>
          <a href={href('/how-to-read')}>How to read this dashboard</a>
        </p>
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
