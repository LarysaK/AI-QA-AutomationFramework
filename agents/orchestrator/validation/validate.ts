import { resolve } from 'node:path';

import { loadApprovedIds } from './approved-ids';
import { checkBase } from './base-guard';
import { checkDiscovery, type ListRunner } from './discovery-guard';
import { checkPaths } from './path-guard';
import { createSchemaGuard, isValidatedArtifact } from './schema-guard';
import { checkRun, type TestRunner } from './run-guard';
import { checkStatic, type ScriptRunner } from './static-guard';
import { checkTrace, type TraceArtifact } from './trace-guard';
import type { GuardName, GuardResult } from './types';

export const ENVELOPE_SCHEMA_PATH = 'agents/standard/envelope.schema.json';

export interface ValidationOptions {
  /** Repository whose approved state the proposal is checked against. Never written to. */
  readonly repoRoot: string;
  /** Envelope schema; defaults to the Agent Standard schema in `repoRoot`. */
  readonly schemaPath?: string;
  /** Runs one npm script for G-STATIC; tests inject a stub. Defaults to the real npm scripts. */
  readonly runScript?: ScriptRunner;
  /** Runs the Playwright listing for G-DISCOVERY and G-RUN; tests inject a stub. */
  readonly runList?: ListRunner;
  /** Runs `playwright test` for G-RUN; tests inject a stub. */
  readonly runTests?: TestRunner;
  /** Port helpers for G-RUN; tests inject stubs. */
  readonly allocatePort?: () => number;
  readonly isPortOpen?: (port: number) => boolean;
  /** SHA-256 of the raw artifact bytes, computed by the caller from the bytes it validates. */
  readonly artifactSha256?: string;
  /**
   * Human execution authorization (gate H7): the artifact SHA-256 the human authorized.
   * Supplied only by the human-invoked CLI, never by the artifact or the environment.
   */
  readonly executionAuthorization?: string;
}

/** Guards implemented so far, in the order fixed by Agent Standard v1, section 14. */
export const GUARD_ORDER: readonly GuardName[] = [
  'G-SCHEMA',
  'G-PATHS',
  'G-BASE',
  'G-TRACE',
  'G-STATIC',
  'G-DISCOVERY',
  'G-RUN',
];

/** Guards that import or run proposed code (STD-AUTH-005). */
export const EXECUTION_CAPABLE_GUARDS: readonly GuardName[] = ['G-DISCOVERY', 'G-RUN'];

export type ValidationOutcome = 'passed' | 'failed' | 'incomplete';

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
  const trace = checkTrace(document as TraceArtifact, approved, options.repoRoot);
  results.push(trace);
  if (trace.status === 'failed') return withSkipped(results);

  const staticResult = checkStatic(document as TraceArtifact, options.repoRoot, options.runScript);
  results.push(staticResult);
  if (staticResult.status === 'failed') return withSkipped(results);

  // Execution boundary (gate H7): nothing below runs proposed code without authorization.
  const denied = authorizationProblem(options);
  if (denied !== undefined) {
    for (const guard of EXECUTION_CAPABLE_GUARDS) {
      results.push({
        guard,
        status: 'not-authorized',
        failures: [{ guard, ruleIds: ['STD-AUTH-005'], reason: denied }],
      });
    }
    return withSkipped(results);
  }

  const discovery = checkDiscovery(
    document as TraceArtifact,
    approved,
    options.repoRoot,
    options.runList,
  );
  results.push(discovery);
  if (discovery.status === 'failed') return withSkipped(results);

  results.push(
    checkRun(document as TraceArtifact, options.repoRoot, {
      ...(options.runTests === undefined ? {} : { runTests: options.runTests }),
      ...(options.runList === undefined ? {} : { runList: options.runList }),
      ...(options.allocatePort === undefined ? {} : { allocatePort: options.allocatePort }),
      ...(options.isPortOpen === undefined ? {} : { isPortOpen: options.isPortOpen }),
    }),
  );
  return withSkipped(results);
}

export function hasFailed(results: readonly GuardResult[]): boolean {
  return results.some((result) => result.status === 'failed');
}

/**
 * `passed` only when every guard ran and passed; `incomplete` when execution-capable guards
 * were not authorized; `failed` when any guard failed.
 */
export function outcomeOf(results: readonly GuardResult[]): ValidationOutcome {
  if (hasFailed(results)) return 'failed';
  const allPassed = GUARD_ORDER.every(
    (guard) => results.find((result) => result.guard === guard)?.status === 'passed',
  );
  return allPassed ? 'passed' : 'incomplete';
}

function authorizationProblem(options: ValidationOptions): string | undefined {
  if (options.executionAuthorization === undefined) {
    return 'runs proposed test module code; requires human execution authorization for this exact artifact';
  }
  if (
    options.artifactSha256 === undefined ||
    options.executionAuthorization !== options.artifactSha256
  ) {
    return 'execution authorization does not match this artifact (it changed after authorization, or the digest is wrong)';
  }
  return undefined;
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
