import { MarkdownBlock, MarkdownInline } from '../components/Markdown';
import { Badge, Callout, Card, PageHeader } from '../components/ui';
import { instancesFor, planSectionsMentioning, shortSha } from '../data/derive';
import {
  type ExecutionHistory,
  formatInstant,
  MAPPING_REASON,
  mapResults,
  resultKey,
  runPath,
} from '../data/history';
import type { Snapshot, TestInstance } from '../data/types';
import { href } from '../router';

export function TestCaseDetail({
  snapshot,
  history = null,
  id,
  query,
}: {
  snapshot: Snapshot;
  history?: ExecutionHistory | null;
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
          <ExecutionAtSnapshotCommit
            snapshot={snapshot}
            history={history}
            testCase={tc.id}
            instances={instances}
          />
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

/**
 * This test case's results in the newest published CI run of the snapshot's own commit, under the
 * mapping contract (data/history.ts mapResults): only results whose instance is mapped to this test
 * case in both directions are shown; never inferred from suite counts or matched by title.
 */
function ExecutionAtSnapshotCommit({
  snapshot,
  history,
  testCase,
  instances,
}: {
  snapshot: Snapshot;
  history: ExecutionHistory | null;
  testCase: string;
  instances: readonly TestInstance[];
}) {
  if (history === null) {
    return (
      <Callout title="Execution history is not included in this build" tone="empty">
        <p>
          No CI result can be shown here. Published CI runs are listed on the{' '}
          <a href={href('/executions')}>Executions</a> page of builds that include them.
        </p>
      </Callout>
    );
  }
  if (instances.length === 0) {
    return (
      <Callout title="No CI result" tone="empty">
        <p>No committed test is linked to this test case, so no CI run reports a result for it.</p>
      </Callout>
    );
  }
  const run = history.records.find(
    (record) => record.commitSha === snapshot.source.commit && record.playwright !== null,
  );
  if (run === undefined) {
    return (
      <Callout title="No published CI run of this commit" tone="empty">
        <p>
          No published CI run tested commit <code>{shortSha(snapshot.source.commit)}</code>, which
          this dashboard describes. Results of runs of other commits are not mapped to test cases.{' '}
          <a href={href('/executions')}>All executions</a>
        </p>
      </Callout>
    );
  }
  const mapping = mapResults(run, snapshot);
  if (mapping.status === 'unavailable') {
    return (
      <Callout title="CI results are not mapped to this test case" tone="empty">
        <p>
          Published CI run <a href={href(runPath(run))}>#{String(run.run.number)}</a> tested this
          commit, but {MAPPING_REASON[mapping.reason ?? 'no-results']}.
        </p>
      </Callout>
    );
  }
  return (
    <>
      <p>
        In published CI run <a href={href(runPath(run))}>#{String(run.run.number)}</a> of this
        commit, completed {formatInstant(run.timestamps.jobCompletedAt)}:
      </p>
      <ul className="plain-list">
        {instances.flatMap((instance) =>
          instance.projects.map((project) => {
            const key = resultKey({ instanceId: instance.id, project });
            const result = run.playwright?.results.find((r) => resultKey(r) === key);
            const link = mapping.links.get(key);
            return (
              <li key={key}>
                {instance.title} ({project}):{' '}
                {result === undefined ? (
                  'no result recorded'
                ) : link?.kind !== 'mapped' ? (
                  `not mapped (${link?.why ?? 'unknown'})`
                ) : !link.testCases.includes(testCase) ? (
                  'not mapped (the linkage is not confirmed in both directions)'
                ) : (
                  <Badge
                    tone={
                      result.status === 'passed'
                        ? 'accent'
                        : result.status === 'skipped'
                          ? 'outline'
                          : 'warning'
                    }
                  >
                    {result.status}
                  </Badge>
                )}
              </li>
            );
          }),
        )}
      </ul>
      <p className="fine-print">
        The result of each linked test instance as Playwright reported it in that run, shown only
        where the mapping is exact. A passing linked test is not proof that every row or behaviour
        of the scenario is exercised.
      </p>
    </>
  );
}
