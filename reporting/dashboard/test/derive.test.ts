import snapshotData from 'virtual:dashboard-snapshot';
import { describe, expect, test } from 'vitest';

import {
  filterTestCases,
  filtersFromQuery,
  filtersToQuery,
  linkageLabel,
  NO_FILTERS,
  requirementLinkage,
} from '../src/data/derive';
import type { Snapshot } from '../src/data/types';

const snapshot = snapshotData as Snapshot;

describe('derived views', () => {
  test('requirement linkage is always "n of m test cases linked" and adds up to the summary', () => {
    expect(linkageLabel(0, 7)).toBe('0 of 7 test cases linked');
    expect(linkageLabel(1, 1)).toBe('1 of 1 test case linked');
    const rows = requirementLinkage(snapshot);
    expect(rows).toHaveLength(snapshot.summary.requirements);
    expect(rows.reduce((sum, row) => sum + row.testCases, 0)).toBe(snapshot.summary.testCases);
    expect(rows.reduce((sum, row) => sum + row.linked, 0)).toBe(snapshot.summary.linkedTestCases);
  });

  test('filters round-trip through the URL; invalid values are ignored', () => {
    const filters = { ...NO_FILTERS, query: 'TC-003', level: 'API', linkage: 'linked' } as const;
    expect(filtersFromQuery(filtersToQuery(filters))).toEqual(filters);
    expect(
      filtersFromQuery('level=<script>&priority=P9&intent=Maybe&requirement=REQ-1&linkage=x'),
    ).toEqual(NO_FILTERS);
  });

  test('search matches the ID and the verbatim scenario, case-insensitively', () => {
    const byId = filterTestCases(snapshot.testCases, { ...NO_FILTERS, query: 'tc-003-07' });
    expect(byId.map((tc) => tc.id)).toEqual(['TC-003-07']);
    const byText = filterTestCases(snapshot.testCases, {
      ...NO_FILTERS,
      query: 'invalid_state_transition',
    });
    expect(byText.length).toBe(
      snapshot.testCases.filter((tc) =>
        tc.scenario.toLowerCase().includes('invalid_state_transition'),
      ).length,
    );
    expect(byText.length).toBeGreaterThan(0);
  });
});
