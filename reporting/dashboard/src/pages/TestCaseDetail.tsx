import { MarkdownBlock, MarkdownInline } from '../components/Markdown';
import { Badge, Callout, Card, PageHeader } from '../components/ui';
import { instancesFor, planSectionsMentioning, shortSha } from '../data/derive';
import type { Snapshot } from '../data/types';
import { href } from '../router';

export function TestCaseDetail({
  snapshot,
  id,
  query,
}: {
  snapshot: Snapshot;
  id: string;
  query: string;
}) {
  const index = snapshot.testCases.findIndex((tc) => tc.id === id);
  const tc = snapshot.testCases[index];
  if (tc === undefined) {
    return (
      <PageHeader eyebrow="Test Cases" title="Test case not found">
        <p>
          <code>{id}</code> is not an approved test case.{' '}
          <a href={href('/test-cases')}>Back to all test cases</a>
        </p>
      </PageHeader>
    );
  }

  const requirement = snapshot.requirements.find((r) => r.id === tc.requirementId);
  const instances = instancesFor(snapshot, tc.automationLinkage.testInstanceIds);
  const canonicals = [...new Set(instances.flatMap((instance) => instance.tags.canonicals))].sort();
  const mentions = planSectionsMentioning(snapshot, tc.id);
  const previous = snapshot.testCases[index - 1];
  const next = snapshot.testCases[index + 1];

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href={href('/test-cases', query)}>Test Cases</a> <span aria-hidden="true">/</span>{' '}
        <span aria-current="page">{tc.id}</span>
      </nav>
      <PageHeader eyebrow={`${tc.requirementId} · ${requirement?.title ?? ''}`} title={tc.id}>
        <div className="badges">
          <Badge>{tc.level}</Badge>
          <Badge>{tc.type}</Badge>
          <Badge>{tc.priority}</Badge>
        </div>
      </PageHeader>

      <Card title="Approved scenario">
        <p className="scenario">
          <MarkdownInline source={tc.scenario} />
        </p>
        <details className="source-text">
          <summary>Exact source text from the test plan</summary>
          <pre>
            <code>{tc.scenario}</code>
          </pre>
        </details>
        <p className="fine-print">
          The scenario is the plan's single statement of the test case. The plan does not list
          separate steps or expected results, and this dashboard does not add any.
        </p>
      </Card>

      <div className="grid-2">
        <Card title="Automation">
          <dl className="meta-list">
            <div className="meta-row">
              <dt>Automation intent (plan)</dt>
              <dd>
                {tc.automationIntent === 'Yes'
                  ? 'Yes, intended for automation'
                  : 'No, not automated in the current plan'}
              </dd>
            </div>
            <div className="meta-row">
              <dt>Linked committed tests</dt>
              <dd>{instances.length === 0 ? 'None' : String(instances.length)}</dd>
            </div>
            {tc.automationIntent === 'No' && (
              <div className="meta-row">
                <dt>Reason given in the plan</dt>
                <dd>
                  {mentions.length === 0
                    ? 'The plan does not name this test case elsewhere.'
                    : mentions.map((section, i) => (
                        <span key={section.key}>
                          {i > 0 && ', '}
                          <a
                            href={href('/test-plan', `section=${encodeURIComponent(section.key)}`)}
                          >
                            {section.heading}
                          </a>
                        </span>
                      ))}
                </dd>
              </div>
            )}
            {canonicals.length > 0 && (
              <div className="meta-row">
                <dt>Through canonical tests</dt>
                <dd>{canonicals.join(', ')}</dd>
              </div>
            )}
          </dl>
          {instances.length > 0 ? (
            <ul className="instance-list">
              {instances.map((instance) => (
                <li key={instance.id} className="instance">
                  <p className="instance-title">
                    {[...instance.describePath, instance.title].join(' › ')}
                  </p>
                  <p className="instance-meta">
                    <code>
                      {instance.file}:{instance.line}
                    </code>{' '}
                    · {instance.projects.join(', ')}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No committed Playwright test carries the <code>@{tc.id}</code> tag
              {tc.automationIntent === 'No' ? '; the plan marks it Automation: No.' : ' yet.'}
            </p>
          )}
          <Callout title="Linkage is not full coverage">
            <p>
              A link means the committed test is tagged with this test case. It does not prove that
              every data row or behaviour in the scenario is exercised.
            </p>
          </Callout>
        </Card>

        <Card title="Execution">
          <Callout title="No CI runs yet" tone="empty">
            <p>
              There is no execution result for this test case. CI is not connected, and local runs
              are not published.
            </p>
          </Callout>
        </Card>
      </div>

      {requirement !== undefined && (
        <Card title={`${requirement.id} — ${requirement.title}`}>
          <p className="fine-print">
            From the approved requirements at commit <code>{shortSha(snapshot.source.commit)}</code>
            .
          </p>
          <MarkdownBlock source={requirement.markdown} />
        </Card>
      )}

      <nav className="pager" aria-label="Adjacent test cases">
        {previous !== undefined ? (
          <a href={href(`/test-cases/${previous.id}`, query)}>← {previous.id}</a>
        ) : (
          <span />
        )}
        {next !== undefined ? (
          <a href={href(`/test-cases/${next.id}`, query)}>{next.id} →</a>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}
