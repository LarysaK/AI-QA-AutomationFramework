import { Callout, Card, MeterRow, PageHeader, Stat } from '../components/ui';
import {
  filtersToQuery,
  linkageLabel,
  NO_FILTERS,
  percent,
  requirementLinkage,
  shortSha,
} from '../data/derive';
import type { Snapshot } from '../data/types';
import { href } from '../router';

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.summary;
  const intended = s.testCasesByAutomationIntent.Yes;
  const manualOnly = s.testCasesByAutomationIntent.No;
  const linked = s.linkedTestCasesWithIntentYes;
  const requirements = requirementLinkage(snapshot);
  const testCasesFor = (requirement: string) =>
    href('/test-cases', filtersToQuery({ ...NO_FILTERS, requirement }));

  return (
    <>
      <PageHeader
        eyebrow={`${snapshot.testPlan.title} · Requirements ${requirementsVersion(snapshot)}`}
        title="Overview"
      >
        <p>
          Approved requirements and test design for RequestFlow, and how much of it is linked to
          committed Playwright automation. Built from commit{' '}
          <code>{shortSha(snapshot.source.commit)}</code>.
        </p>
      </PageHeader>

      <dl className="stats" aria-label="Key figures">
        <Stat
          label="Requirements"
          value={String(s.requirements)}
          detail="Approved, frozen baseline"
        />
        <Stat
          label="Planned test cases"
          value={String(s.testCases)}
          detail="Approved in the human test plan"
        />
        <Stat
          label="Intended for automation"
          value={String(intended)}
          detail={`${String(manualOnly)} marked Automation: No in the plan`}
        />
        <Stat
          label="Linked to committed tests"
          value={`${String(linked)} of ${String(intended)}`}
          detail={`${percent(linked, intended)} of automation-intended test cases`}
          tone="accent"
        />
        <Stat
          label="Committed test instances"
          value={String(s.testInstances)}
          detail={`Discovered by Playwright ${snapshot.source.discovery.playwrightVersion}`}
        />
        <Stat label="CI runs" value="None yet" detail="No CI runs yet" tone="muted" />
      </dl>

      <div className="grid-2">
        <Card title="From plan to execution">
          <p className="card-intro">
            Four separate measures. Each one is a subset of the previous one; none of them implies
            the next.
          </p>
          <div className="funnel">
            <MeterRow
              label="Planned"
              value={s.testCases}
              max={s.testCases}
              text={`${String(s.testCases)} test cases`}
              tone="neutral"
            />
            <MeterRow
              label="Automation intended"
              value={intended}
              max={s.testCases}
              text={`${String(intended)} of ${String(s.testCases)}`}
              tone="neutral"
            />
            <MeterRow
              label="Linked automation"
              value={linked}
              max={s.testCases}
              text={`${String(linked)} of ${String(intended)} intended`}
            />
            <div className="meter-row meter-row-empty">
              <span className="meter-label">Executed in CI</span>
              <span className="meter-empty">No CI runs yet</span>
              <span className="meter-text">—</span>
            </div>
          </div>
          <Callout title="What “linked” means">
            <p>
              A test case is <strong>linked</strong> when at least one committed Playwright test
              carries its <code>@TC-…</code> tag. Linkage is traceability, not proof that every data
              row or behaviour in the scenario is exercised, and it is not an execution result.{' '}
              <a href={href('/how-to-read')}>How to read this dashboard</a>
            </p>
          </Callout>
        </Card>

        <Card title="Test cases by level and priority">
          <h3 className="subheading">Level</h3>
          {(['API', 'UI', 'E2E'] as const).map((level) => (
            <MeterRow
              key={level}
              label={level}
              value={s.testCasesByLevel[level]}
              max={s.testCases}
              text={String(s.testCasesByLevel[level])}
              tone="neutral"
            />
          ))}
          <h3 className="subheading">Priority</h3>
          {(['P0', 'P1', 'P2'] as const).map((priority) => (
            <MeterRow
              key={priority}
              label={priority}
              value={s.testCasesByPriority[priority]}
              max={s.testCases}
              text={String(s.testCasesByPriority[priority])}
              tone="neutral"
            />
          ))}
          <p className="fine-print">
            Levels and priorities are defined in the{' '}
            <a href={href('/test-plan')}>approved test plan</a> (test strategy).
          </p>
        </Card>
      </div>

      <Card title="Linkage by requirement">
        <div
          className="table-scroll"
          role="region"
          aria-label="Linkage by requirement"
          tabIndex={0}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Linked automation</th>
                <th scope="col" className="num">
                  Intended
                </th>
                <th scope="col">Canonical tests</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((requirement) => (
                <tr key={requirement.id}>
                  <th scope="row">
                    <a href={testCasesFor(requirement.id)}>
                      <span className="mono">{requirement.id}</span> {requirement.title}
                    </a>
                  </th>
                  <td>
                    <div className="inline-meter">
                      <meter
                        className="meter meter-accent"
                        min={0}
                        max={Math.max(requirement.testCases, 1)}
                        value={requirement.linked}
                        aria-hidden="true"
                      />
                      <span>{linkageLabel(requirement.linked, requirement.testCases)}</span>
                    </div>
                  </td>
                  <td className="num">
                    {requirement.automationIntended} of {requirement.testCases}
                  </td>
                  <td>
                    {requirement.canonicals.length > 0 ? requirement.canonicals.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine-print">
          “Intended” counts test cases whose plan entry says <em>Automation: Yes</em>. Canonical
          tests are the hand-written reference tests whose committed instances are tagged with the
          requirement.
        </p>
      </Card>

      <Card title="Execution results">
        <Callout title="No CI runs yet" tone="empty">
          <p>
            Continuous integration is not connected, so there is no execution history to show. Local
            Playwright runs are deliberately not published as results. This section will show real
            CI runs, each linked to its commit and workflow run, once they exist.
          </p>
        </Callout>
      </Card>
    </>
  );
}

function requirementsVersion(snapshot: Snapshot): string {
  const title = snapshot.source.documents.find((document) =>
    document.path.endsWith('/requirements.md'),
  )?.title;
  return /v\d+(\.\d+)*/.exec(title ?? '')?.[0] ?? '';
}
