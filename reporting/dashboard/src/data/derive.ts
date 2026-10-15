import type { AutomationIntent, Level, Priority, Snapshot, TestCase, TestInstance } from './types';

/**
 * Pure views over the snapshot. Nothing here adds information: every number is a count of
 * snapshot records, and "linked" always means tag-level linkage to committed tests.
 */

export interface RequirementLinkage {
  readonly id: string;
  readonly title: string;
  /** Test cases the plan assigns to the requirement. */
  readonly testCases: number;
  /** Of those, how many have at least one committed test tagged with their ID. */
  readonly linked: number;
  readonly automationIntended: number;
  readonly canonicals: readonly string[];
}

export function requirementLinkage(snapshot: Snapshot): RequirementLinkage[] {
  return snapshot.requirements.map((requirement) => {
    const cases = snapshot.testCases.filter((tc) => tc.requirementId === requirement.id);
    const instances = new Set(requirement.automationLinkage.testInstanceIds);
    const canonicals = snapshot.canonicals
      .filter((can) => can.automationLinkage.testInstanceIds.some((id) => instances.has(id)))
      .map((can) => can.id);
    return {
      id: requirement.id,
      title: requirement.title,
      testCases: cases.length,
      linked: cases.filter((tc) => tc.automationLinkage.status === 'linked').length,
      automationIntended: cases.filter((tc) => tc.automationIntent === 'Yes').length,
      canonicals,
    };
  });
}

/** "n of m test cases linked" — the only way requirement linkage is described. */
export function linkageLabel(linked: number, total: number): string {
  return `${String(linked)} of ${String(total)} test case${total === 1 ? '' : 's'} linked`;
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${String(Math.round((part / whole) * 100))}%`;
}

export type LinkageFilter = 'linked' | 'not-linked';

export interface TestCaseFilters {
  readonly query: string;
  readonly requirement: string;
  readonly level: Level | '';
  readonly priority: Priority | '';
  readonly intent: AutomationIntent | '';
  readonly linkage: LinkageFilter | '';
}

export const NO_FILTERS: TestCaseFilters = {
  query: '',
  requirement: '',
  level: '',
  priority: '',
  intent: '',
  linkage: '',
};

const FILTER_KEYS = ['query', 'requirement', 'level', 'priority', 'intent', 'linkage'] as const;
const ALLOWED: Record<(typeof FILTER_KEYS)[number], RegExp> = {
  query: /^[\s\S]{0,200}$/,
  requirement: /^REQ-\d{3}$/,
  level: /^(API|UI|E2E)$/,
  priority: /^P[0-2]$/,
  intent: /^(Yes|No)$/,
  linkage: /^(linked|not-linked)$/,
};

/** Filters from a URL query string; unknown keys and invalid values are ignored. */
export function filtersFromQuery(query: string): TestCaseFilters {
  const params = new URLSearchParams(query);
  const result: Record<string, string> = { ...NO_FILTERS };
  for (const key of FILTER_KEYS) {
    const value = params.get(key === 'query' ? 'q' : key);
    if (value !== null && ALLOWED[key].test(value)) result[key] = value;
  }
  return result as unknown as TestCaseFilters;
}

export function filtersToQuery(filters: TestCaseFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value !== '') params.set(key === 'query' ? 'q' : key, value);
  }
  return params.toString();
}

/** Case-insensitive search over the test-case ID and the verbatim scenario text. */
export function filterTestCases(cases: readonly TestCase[], filters: TestCaseFilters): TestCase[] {
  const needle = filters.query.trim().toLowerCase();
  return cases.filter(
    (tc) =>
      (needle === '' ||
        tc.id.toLowerCase().includes(needle) ||
        tc.scenario.toLowerCase().includes(needle)) &&
      (filters.requirement === '' || tc.requirementId === filters.requirement) &&
      (filters.level === '' || tc.level === filters.level) &&
      (filters.priority === '' || tc.priority === filters.priority) &&
      (filters.intent === '' || tc.automationIntent === filters.intent) &&
      (filters.linkage === '' || tc.automationLinkage.status === filters.linkage),
  );
}

export function instancesFor(snapshot: Snapshot, ids: readonly string[]): TestInstance[] {
  const wanted = new Set(ids);
  return snapshot.testInstances.filter((instance) => wanted.has(instance.id));
}

/** The route key of a plan section: its number ("6" for "6. Known limitations"). */
export function planSectionKey(heading: string): string {
  return /^(\d+)\./.exec(heading)?.[1] ?? heading;
}

/** Plan sections whose own text mentions `id` (text sections and inventory notes). */
export function planSectionsMentioning(
  snapshot: Snapshot,
  id: string,
): { heading: string; key: string }[] {
  return snapshot.testPlan.sections
    .filter(
      (section) =>
        (section.kind === 'text' && section.markdown.includes(id)) ||
        (section.kind === 'inventory' &&
          section.requirementNotes.some((note) => note.markdown.includes(id))),
    )
    .map((section) => ({ heading: section.heading, key: planSectionKey(section.heading) }));
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
