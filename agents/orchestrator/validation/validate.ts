import { resolve } from 'node:path';

import { loadApprovedIds } from './approved-ids';
import { checkBase } from './base-guard';
import { checkPaths } from './path-guard';
import { createSchemaGuard, isValidatedArtifact } from './schema-guard';
import { checkTrace, type TraceArtifact } from './trace-guard';
import type { GuardName, GuardResult } from './types';

export const ENVELOPE_SCHEMA_PATH = 'agents/standard/envelope.schema.json';

export interface ValidationOptions {
  /** Repository whose approved state the proposal is checked against. Never written to. */
  readonly repoRoot: string;
  /** Envelope schema; defaults to the Agent Standard schema in `repoRoot`. */
  readonly schemaPath?: string;
}

/** Guards implemented so far, in the order fixed by Agent Standard v1, section 14. */
export const GUARD_ORDER: readonly GuardName[] = ['G-SCHEMA', 'G-PATHS', 'G-BASE', 'G-TRACE'];

/**
 * Runs the implemented guards in order and stops at the first failing guard;
 * the remaining guards are reported as skipped. Read-only.
 */
export function validateArtifact(document: unknown, options: ValidationOptions): GuardResult[] {
  const schemaGuard = createSchemaGuard(
    options.schemaPath ?? resolve(options.repoRoot, ENVELOPE_SCHEMA_PATH),
  );

  const results: GuardResult[] = [schemaGuard(document)];
  const schemaResult = results[0];
  if (schemaResult === undefined || !isValidatedArtifact(document, schemaResult)) {
    return withSkipped(results);
  }

  const paths = checkPaths(document, options.repoRoot);
  results.push(paths);
  if (paths.status === 'failed') return withSkipped(results);

  const base = checkBase(document, options.repoRoot);
  results.push(base);
  if (base.status === 'failed') return withSkipped(results);

  // The envelope schema guarantees the traceability fields G-TRACE reads.
  const approved = loadApprovedIds(options.repoRoot);
  results.push(checkTrace(document as TraceArtifact, approved, options.repoRoot));
  return withSkipped(results);
}

export function hasFailed(results: readonly GuardResult[]): boolean {
  return results.some((result) => result.status === 'failed');
}

function withSkipped(results: GuardResult[]): GuardResult[] {
  const ran = new Set(results.map((result) => result.guard));
  const skipped = GUARD_ORDER.filter((guard) => !ran.has(guard)).map((guard): GuardResult => ({
    guard,
    status: 'skipped',
    failures: [],
  }));
  return [...results, ...skipped];
}
