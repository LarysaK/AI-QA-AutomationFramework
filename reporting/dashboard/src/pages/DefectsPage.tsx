import { Fragment } from 'react';

import { Badge, Callout, Card, PageHeader } from '../components/ui';
import type { VerifiedAgentLayer } from '../data/agents';
import { type DefectSource, validateDefectSource } from '../data/defects';
import { formatInstant } from '../data/history';
import type { Snapshot } from '../data/types';
import { href } from '../router';

function NotDefects({ agents }: { agents: VerifiedAgentLayer | null }) {
  return (
    <Card title="What is never shown as a defect">
      <ul className="plain-list">
        <li>
          <strong>Failed CI tests.</strong> A failed test is an execution result for a commit, shown
          on the <a href={href('/executions')}>Executions</a> page. It may point to a product
          defect, a test defect or an environment problem; only a human triage decides, and no
          defect is created from it here.
        </li>
        <li>
          <strong>CI runs that were not published.</strong> A missing record says nothing about the
          product.
        </li>
        <li>
          <strong>Agents’ defect candidates.</strong>{' '}
          {agents === null
            ? 'Findings that AI agents raise in their proposals await human triage and are not defects.'
            : agents.layer.defectCandidates.text}{' '}
          Proposals stay outside the repository and are not shown.
        </li>
        <li>
          <strong>Test cases without automation.</strong> A test case marked <em>Automation: No</em>{' '}
          is a plan decision, not a gap or a defect.
        </li>
      </ul>
    </Card>
  );
}

function Traceability({
  requirementIds,
  testCaseIds,
}: {
  requirementIds: readonly string[];
  testCaseIds: readonly string[];
}) {
  if (requirementIds.length === 0 && testCaseIds.length === 0) return <>—</>;
  return (
    <>
      {requirementIds.map((id, index) => (
        <Fragment key={id}>
          {index > 0 && ', '}
          <code>{id}</code>
        </Fragment>
      ))}
      {requirementIds.length > 0 && testCaseIds.length > 0 && ' · '}
      {testCaseIds.map((id, index) => (
        <Fragment key={id}>
          {index > 0 && ', '}
          <a href={href(`/test-cases/${id}`)}>{id}</a>
        </Fragment>
      ))}
    </>
  );
}

export function DefectsPage({
  snapshot,
  defects,
  agents = null,
}: {
  snapshot: Snapshot;
  defects: DefectSource;
  agents?: VerifiedAgentLayer | null;
}) {
  const problems = validateDefectSource(defects, snapshot);

  if (defects.status === 'not-connected' || problems.length > 0) {
    const invalid = problems.length > 0;
    return (
      <>
        <PageHeader eyebrow="Defect register" title="Defects">
          <p>
            Defects are shown here only from a verified defect register, with the source system’s
            own identifiers, status, severity and links to approved requirements and test cases.
          </p>
        </PageHeader>
        <Card>
          {invalid ? (
            <Callout title="The defect data did not pass validation" tone="empty">
              <p>
                This build’s defect data has {String(problems.length)} problem
                {problems.length === 1 ? '' : 's'}, so none of it is shown. Nothing is shown from
                partly valid data.
              </p>
            </Callout>
          ) : (
            <Callout title="No defect register is connected" tone="empty">
              <p>
                This dashboard has no defect data source connected, so there is nothing to list.{' '}
                <strong>An empty list here is not evidence that the product has no defects</strong>:
                it only means that no verified defect records are available to this build.
              </p>
            </Callout>
          )}
        </Card>
        <NotDefects agents={agents} />
        <Card title="When a defect register is connected">
          <p>
            Each defect will be listed only if its record passes validation at build time, with:
          </p>
          <dl className="definitions">
            <div>
              <dt>Identifier and title</dt>
              <dd>
                The source system’s own key (for example a tracker issue key), never one made up
                here.
              </dd>
            </div>
            <div>
              <dt>Status and severity</dt>
              <dd>Exactly as the source system reports them; nothing is renamed or inferred.</dd>
            </div>
            <div>
              <dt>Traceability</dt>
              <dd>
                Links to approved requirements and test cases; a record that names an ID the
                approved documents do not define is rejected.
              </dd>
            </div>
            <div>
              <dt>Provenance</dt>
              <dd>
                The source system, a link to the record, when it last changed, and when the register
                was exported.
              </dd>
            </div>
          </dl>
          <p>
            <a href={href('/how-to-read')}>How to read this dashboard</a>
          </p>
        </Card>
      </>
    );
  }

  const { records, system, retrievedAt } = defects;
  return (
    <>
      <PageHeader eyebrow="Defect register" title="Defects">
        <p>
          {String(records.length)} defect record{records.length === 1 ? '' : 's'} from {system},
          exported {formatInstant(retrievedAt)}. A build-time snapshot, not live.
        </p>
      </PageHeader>
      <Card title="Defect records">
        {records.length === 0 ? (
          <Callout title={`${system} returned no defect records`} tone="empty">
            <p>
              The connected register holds no records in its export. That is not evidence that the
              product has no defects.
            </p>
          </Callout>
        ) : (
          <div className="table-scroll" role="region" aria-label="Defect records" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Requirements and test cases</th>
                  <th scope="col">Last changed (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <th scope="row">
                      {record.url === null ? (
                        <code>{record.id}</code>
                      ) : (
                        <a href={record.url} rel="noopener noreferrer" className="external">
                          <code>{record.id}</code>
                          <span className="visually-hidden"> (opens {system})</span>
                        </a>
                      )}
                    </th>
                    <td>{record.title}</td>
                    <td>
                      <Badge tone="outline">{record.status}</Badge>
                    </td>
                    <td>{record.severity ?? '—'}</td>
                    <td>
                      <Traceability
                        requirementIds={record.requirementIds}
                        testCaseIds={record.testCaseIds}
                      />
                    </td>
                    <td>{formatInstant(record.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <NotDefects agents={agents} />
    </>
  );
}
