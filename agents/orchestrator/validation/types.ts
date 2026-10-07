/**
 * Shared types for the deterministic guards (Agent Standard v1, section 14: Guards).
 */

export type GuardName = 'G-SCHEMA' | 'G-PATHS' | 'G-BASE' | 'G-TRACE';

export interface GuardFailure {
  readonly guard: GuardName;
  /** Agent Standard rule IDs the failure violates. */
  readonly ruleIds: readonly string[];
  /** Repository path concerned, when the failure is about one proposed change. */
  readonly path?: string;
  readonly reason: string;
}

export interface GuardResult {
  readonly guard: GuardName;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly failures: readonly GuardFailure[];
}

export type AgentName = 'planner' | 'generator' | 'analyzer' | 'healer';
export type ChangeKind = 'test-change' | 'support-change' | 'plan-change';
export type Operation = 'create' | 'modify';

/** The part of a schema-valid artifact that G-PATHS and G-BASE read. */
export interface ProposedChange {
  readonly path: string;
  readonly changeKind: ChangeKind;
  readonly operation: Operation;
  readonly baseSha?: string;
}

export interface Artifact {
  readonly agent: { readonly name: AgentName };
  readonly proposedChanges: readonly ProposedChange[];
}
