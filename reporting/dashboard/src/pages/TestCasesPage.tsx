import { useId } from 'react';

import { MarkdownInline } from '../components/Markdown';
import { Badge, PageHeader } from '../components/ui';
import {
  filterTestCases,
  filtersFromQuery,
  filtersToQuery,
  NO_FILTERS,
  type TestCaseFilters,
} from '../data/derive';
import type { Snapshot } from '../data/types';
import { href, navigate } from '../router';

export function TestCasesPage({ snapshot, query }: { snapshot: Snapshot; query: string }) {
  const filters = filtersFromQuery(query);
  const results = filterTestCases(snapshot.testCases, filters);
  const ids = { search: useId(), count: useId() };
  const active = filtersToQuery(filters) !== '';

  const update = (change: Partial<TestCaseFilters>, replace = false) => {
    navigate('/test-cases', filtersToQuery({ ...filters, ...change }), replace);
  };

  const select = (
    key: Exclude<keyof TestCaseFilters, 'query'>,
    label: string,
    options: readonly (readonly [string, string])[],
  ) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={filters[key]}
        onChange={(event) => {
          update({ [key]: event.target.value });
        }}
      >
        <option value="">All</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <PageHeader eyebrow="Approved test inventory" title="Test Cases">
        <p>
          All {snapshot.testCases.length} approved test cases, with their scenarios exactly as
          written in the test plan. “Linked” means a committed Playwright test carries the test-case
          tag; it is not an execution result.
        </p>
      </PageHeader>

      <form
        className="filters card"
        role="search"
        aria-label="Search and filter test cases"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="field field-search" htmlFor={ids.search}>
          <span className="field-label">Search ID or scenario</span>
          <input
            id={ids.search}
            type="search"
            value={filters.query}
            maxLength={200}
            placeholder="e.g. TC-003-07 or 409"
            aria-describedby={ids.count}
            onChange={(event) => {
              update({ query: event.target.value }, true);
            }}
          />
        </label>
        {select(
          'requirement',
          'Requirement',
          snapshot.requirements.map((r) => [r.id, `${r.id} — ${r.title}`] as const),
        )}
        {select('level', 'Level', [
          ['API', 'API'],
          ['UI', 'UI'],
          ['E2E', 'E2E'],
        ])}
        {select('priority', 'Priority', [
          ['P0', 'P0'],
          ['P1', 'P1'],
          ['P2', 'P2'],
        ])}
        {select('intent', 'Automation intent', [
          ['Yes', 'Intended (Yes)'],
          ['No', 'Not automated (No)'],
        ])}
        {select('linkage', 'Automation linkage', [
          ['linked', 'Linked to a committed test'],
          ['not-linked', 'Not linked'],
        ])}
        <div className="filters-footer">
          <p id={ids.count} className="result-count" role="status" aria-live="polite">
            Showing {results.length} of {snapshot.testCases.length} test cases
          </p>
          {active && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                navigate('/test-cases', filtersToQuery(NO_FILTERS));
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </form>

      {results.length === 0 ? (
        <p className="empty-state">No test cases match these filters.</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Test cases" tabIndex={0}>
          <table className="data-table test-case-table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Scenario</th>
                <th scope="col">Requirement</th>
                <th scope="col">Level</th>
                <th scope="col">Priority</th>
                <th scope="col">Automation intent</th>
                <th scope="col">Linkage</th>
              </tr>
            </thead>
            <tbody>
              {results.map((tc) => {
                const instances = tc.automationLinkage.testInstanceIds.length;
                return (
                  <tr key={tc.id}>
                    <th scope="row" data-label="ID">
                      <a className="mono" href={href(`/test-cases/${tc.id}`, query)}>
                        {tc.id}
                      </a>
                    </th>
                    <td data-label="Scenario" className="scenario-cell">
                      <MarkdownInline source={tc.scenario} />
                    </td>
                    <td data-label="Requirement" className="mono">
                      {tc.requirementId}
                    </td>
                    <td data-label="Level">{tc.level}</td>
                    <td data-label="Priority">{tc.priority}</td>
                    <td data-label="Automation intent">
                      {tc.automationIntent === 'Yes' ? (
                        'Yes'
                      ) : (
                        <Badge tone="warning">Automation: No</Badge>
                      )}
                    </td>
                    <td data-label="Linkage">
                      {instances > 0 ? (
                        <Badge tone="accent">
                          Linked · {instances} test{instances === 1 ? '' : 's'}
                        </Badge>
                      ) : (
                        <Badge tone="outline">Not linked</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
