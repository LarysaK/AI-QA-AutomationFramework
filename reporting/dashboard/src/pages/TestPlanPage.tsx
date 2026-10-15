import { useEffect } from 'react';

import { MarkdownBlock, MarkdownInline } from '../components/Markdown';
import { Badge, Callout, Card, PageHeader } from '../components/ui';
import { filtersToQuery, NO_FILTERS, planSectionKey, shortSha } from '../data/derive';
import type { PlanSection, Snapshot } from '../data/types';
import { href } from '../router';

/**
 * The approved test plan, rendered from the snapshot. All prose is the plan's own text; the
 * inventory and canonical tables are rendered from the structured snapshot records.
 */
export function TestPlanPage({ snapshot, query }: { snapshot: Snapshot; query: string }) {
  const plan = snapshot.testPlan;
  const planDocument = snapshot.source.documents.find((document) =>
    document.path.endsWith('/test-plan.md'),
  );
  const target = new URLSearchParams(query).get('section');

  // Scroll to the section named in the route (#/test-plan?section=2).
  useEffect(() => {
    if (target === null) return;
    const element = document.getElementById(sectionId(target));
    element?.scrollIntoView({ block: 'start' });
    element?.focus({ preventScroll: true });
  }, [target]);

  return (
    <>
      <PageHeader eyebrow="Approved human test design" title={plan.title}>
        <p>
          Rendered verbatim from <code>{planDocument?.path}</code> at commit{' '}
          <code>{shortSha(snapshot.source.commit)}</code>. The plan is the source of truth; this
          page does not add to it.
        </p>
      </PageHeader>

      <Card title="Plan details">
        <dl className="meta-list">
          {plan.metadata.map((row) => (
            <div key={row.item} className="meta-row">
              <dt>{row.item}</dt>
              <dd>
                <MarkdownInline source={row.value} />
              </dd>
            </div>
          ))}
        </dl>
        {plan.preamble !== '' && <MarkdownBlock source={plan.preamble} />}
      </Card>

      <nav className="toc card" aria-label="Test plan sections">
        <h2 className="card-title">Contents</h2>
        <ul>
          {plan.sections.map((section) => (
            <li key={section.heading}>
              <a href={href('/test-plan', `section=${encodeURIComponent(sectionKey(section))}`)}>
                {section.heading}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {plan.sections.map((section) => (
        <section
          key={section.heading}
          id={sectionId(sectionKey(section))}
          className="card plan-section"
          tabIndex={-1}
          aria-labelledby={`${sectionId(sectionKey(section))}-heading`}
        >
          <h2 className="card-title" id={`${sectionId(sectionKey(section))}-heading`}>
            {section.heading}
          </h2>
          {section.markdown !== '' && <MarkdownBlock source={section.markdown} />}
          {section.kind === 'inventory' && (
            <InventoryContent snapshot={snapshot} notes={section.requirementNotes} />
          )}
          {section.kind === 'canonicals' && <CanonicalContent snapshot={snapshot} />}
        </section>
      ))}
    </>
  );
}

function InventoryContent({
  snapshot,
  notes,
}: {
  snapshot: Snapshot;
  notes: Extract<PlanSection, { kind: 'inventory' }>['requirementNotes'];
}) {
  return (
    <>
      <Callout title="Test cases">
        <p>
          The inventory's {snapshot.testCases.length} test cases are listed in the{' '}
          <a href={href('/test-cases')}>Test Case Explorer</a>, with search, filters and the exact
          approved scenario text.
        </p>
      </Callout>
      <div
        className="table-scroll"
        role="region"
        aria-label="Inventory by requirement"
        tabIndex={0}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col" className="num">
                Test cases
              </th>
              <th scope="col">Notes in the plan</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.requirements.map((requirement) => {
              const count = snapshot.testCases.filter(
                (tc) => tc.requirementId === requirement.id,
              ).length;
              const note = notes.find((n) => n.requirementId === requirement.id);
              return (
                <tr key={requirement.id}>
                  <th scope="row">
                    <a
                      href={href(
                        '/test-cases',
                        filtersToQuery({ ...NO_FILTERS, requirement: requirement.id }),
                      )}
                    >
                      <span className="mono">{requirement.id}</span> {requirement.title}
                    </a>
                  </th>
                  <td className="num">{count}</td>
                  <td>{note === undefined ? '—' : <MarkdownBlock source={note.markdown} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CanonicalContent({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="canonical-list">
      {snapshot.canonicals.map((canonical) => {
        const instances = canonical.automationLinkage.testInstanceIds.length;
        return (
          <article
            key={canonical.id}
            className="canonical"
            aria-labelledby={`${canonical.id}-heading`}
          >
            <header className="canonical-header">
              <h3 id={`${canonical.id}-heading`}>{canonical.heading}</h3>
              <div className="badges">
                <Badge>{canonical.level}</Badge>
                <Badge tone={instances > 0 ? 'accent' : 'muted'}>
                  {instances > 0
                    ? `${String(instances)} committed test instance${instances === 1 ? '' : 's'}`
                    : 'No committed test instance'}
                </Badge>
              </div>
            </header>
            <p className="canonical-covers">
              <span className="label">Covers (as stated in the plan):</span>{' '}
              <MarkdownInline source={canonical.covers} />
            </p>
            <MarkdownBlock source={canonical.markdown} />
          </article>
        );
      })}
      <p className="fine-print">
        A canonical test's committed instances are found through its <code>@CAN-…</code> tag.
        “Covers” is the plan's own statement, not a measured result.
      </p>
    </div>
  );
}

function sectionKey(section: PlanSection): string {
  return planSectionKey(section.heading);
}

function sectionId(key: string): string {
  return `plan-section-${key.replace(/[^A-Za-z0-9-]/g, '-')}`;
}
