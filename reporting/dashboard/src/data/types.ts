/**
 * The dashboard snapshot, schema 1.1 (reporting/dashboard-data/snapshot.schema.json). The build
 * validates the snapshot against that schema before it is embedded, so these types describe
 * data that has already been checked; they are not a second definition of it.
 */

export type Level = 'API' | 'UI' | 'E2E';
export type Priority = 'P0' | 'P1' | 'P2';
export type AutomationIntent = 'Yes' | 'No';

export interface Linkage {
  readonly status: 'linked' | 'not-linked';
  readonly testInstanceIds: readonly string[];
}

export interface SourceDocument {
  readonly path: string;
  readonly title: string;
  readonly gitBlobSha: string;
}

export interface Requirement {
  readonly id: string;
  readonly title: string;
  readonly markdown: string;
  readonly automationLinkage: Linkage;
}

export interface TestCase {
  readonly id: string;
  readonly requirementId: string;
  readonly scenario: string;
  readonly level: Level;
  readonly type: string;
  readonly priority: Priority;
  readonly automationIntent: AutomationIntent;
  readonly automationLinkage: Linkage;
}

export interface Canonical {
  readonly id: string;
  readonly title: string;
  readonly level: Level;
  readonly covers: string;
  readonly heading: string;
  readonly markdown: string;
  readonly automationLinkage: Linkage;
}

export type PlanSection =
  | { readonly kind: 'text'; readonly heading: string; readonly markdown: string }
  | {
      readonly kind: 'inventory';
      readonly heading: string;
      readonly markdown: string;
      readonly requirementNotes: readonly {
        readonly requirementId: string;
        readonly markdown: string;
      }[];
    }
  | { readonly kind: 'canonicals'; readonly heading: string; readonly markdown: string };

export interface TestPlan {
  readonly title: string;
  readonly metadata: readonly { readonly item: string; readonly value: string }[];
  readonly preamble: string;
  readonly sections: readonly PlanSection[];
}

export interface TestInstance {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly describePath: readonly string[];
  readonly projects: readonly string[];
  readonly tags: {
    readonly requirements: readonly string[];
    readonly testCases: readonly string[];
    readonly canonicals: readonly string[];
  };
}

export interface Snapshot {
  readonly schemaVersion: '1.1';
  readonly app: string;
  readonly source: {
    readonly commit: string;
    readonly documents: readonly SourceDocument[];
    readonly discovery: {
      readonly method: string;
      readonly testDir: string;
      readonly playwrightVersion: string;
    };
  };
  readonly requirements: readonly Requirement[];
  readonly testCases: readonly TestCase[];
  readonly canonicals: readonly Canonical[];
  readonly testPlan: TestPlan;
  readonly testInstances: readonly TestInstance[];
  readonly execution: {
    readonly ci: { readonly status: 'no-ci-runs'; readonly runs: readonly never[] };
    readonly localResults: 'not-used';
  };
  readonly summary: {
    readonly requirements: number;
    readonly testCases: number;
    readonly testCasesByLevel: Readonly<Record<Level, number>>;
    readonly testCasesByPriority: Readonly<Record<Priority, number>>;
    readonly testCasesByAutomationIntent: Readonly<Record<AutomationIntent, number>>;
    readonly canonicals: number;
    readonly testInstances: number;
    readonly linkedTestCases: number;
    readonly linkedTestCasesWithIntentYes: number;
  };
}
