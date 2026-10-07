import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

import type { ApprovedIdsResult } from './approved-ids';
import type { Artifact, GuardFailure, GuardResult, ProposedChange } from './types';

/**
 * G-TRACE (STD-TRC-001, STD-TRC-002, STD-TRC-003): approved traceability, checked
 * deterministically against the approved documents (see approved-ids.ts).
 *
 * - Every cited REQ, TC and CAN ID exists; every cited TC belongs to a cited REQ.
 * - A Generator test proposal cites at least one approved REQ and TC, and every test-change
 *   it contains cites at least one TC.
 * - A test file's REQ/TC IDs (read from its string literals) equal its declared traceability.
 *   The exact runtime Playwright tags are G-DISCOVERY's job.
 * - Proposed content never contains a `@CAN-` tag; a modified test keeps its REQ/TC IDs.
 *
 * Read-only: proposed content is parsed in memory, never written.
 */

interface TraceIds {
  readonly requirements: readonly string[];
  readonly testCases: readonly string[];
  readonly canonicalPatterns?: readonly string[];
}

/** The fields G-TRACE reads, beyond those G-PATHS and G-BASE use. */
export interface TraceArtifact extends Artifact {
  readonly artifactType: string;
  readonly traceability: TraceIds;
  readonly sourceReferences: readonly { readonly path: string; readonly ids?: readonly string[] }[];
  readonly proposedChanges: readonly (ProposedChange & {
    readonly content: string;
    readonly traceability: TraceIds;
  })[];
}

/** Playwright's default test file pattern. */
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const ID_IN_TEXT = /\b(REQ-\d{3}|TC-\d{3}-\d{2}|CAN-\d{3})\b/g;
const CAN_TAG = /@CAN-\d{3}/;

export function checkTrace(
  artifact: TraceArtifact,
  approved: ApprovedIdsResult,
  repoRoot: string,
): GuardResult {
  const failures: GuardFailure[] = [];
  const fail = (ruleId: string, reason: string, path?: string): void => {
    failures.push({
      guard: 'G-TRACE',
      ruleIds: [ruleId],
      reason,
      ...(path === undefined ? {} : { path }),
    });
  };

  // Fail closed: if the approved documents cannot be parsed, no ID can be trusted.
  if (approved.errors.length > 0) {
    for (const error of approved.errors)
      fail('STD-TRC-001', `approved sources cannot be parsed: ${error}`);
    return result(failures);
  }
  const { ids } = approved;

  const checkIds = (trace: TraceIds, where: string, path?: string): void => {
    for (const req of trace.requirements) {
      if (!ids.requirements.has(req))
        fail('STD-TRC-001', `${where}: unknown requirement ${req}`, path);
    }
    for (const tc of trace.testCases) {
      const owner = ids.testCases.get(tc);
      if (owner === undefined) fail('STD-TRC-001', `${where}: unknown test case ${tc}`, path);
      else if (!trace.requirements.includes(owner)) {
        fail(
          'STD-TRC-001',
          `${where}: ${tc} belongs to ${owner}, which is not in its requirements`,
          path,
        );
      }
    }
    for (const can of trace.canonicalPatterns ?? []) {
      if (!ids.canonicals.has(can))
        fail('STD-TRC-001', `${where}: unknown canonical test ${can}`, path);
    }
  };

  // 1. Every cited ID exists, and TCs belong to the cited REQs.
  checkIds(artifact.traceability, 'traceability');
  for (const source of artifact.sourceReferences) {
    for (const id of source.ids ?? []) {
      if (!isApproved(id, approved))
        fail('STD-TRC-001', `sourceReferences: unknown ID ${id}`, source.path);
    }
  }

  // 2. A Generator test proposal carries approved traceability.
  if (artifact.artifactType === 'test-proposal') {
    if (
      artifact.traceability.requirements.length === 0 ||
      artifact.traceability.testCases.length === 0
    ) {
      fail(
        'STD-TRC-001',
        'test proposal must cite at least one approved requirement and test case',
      );
    }
  }

  for (const change of artifact.proposedChanges) {
    const { path, changeKind, traceability } = change;
    checkIds(traceability, 'change traceability', path);

    // Each change cites only what the artifact as a whole claims.
    for (const id of [...traceability.requirements, ...traceability.testCases]) {
      if (
        ![...artifact.traceability.requirements, ...artifact.traceability.testCases].includes(id)
      ) {
        fail('STD-TRC-001', `${id} is not in the artifact's traceability`, path);
      }
    }

    if (changeKind === 'plan-change') continue; // the plan legitimately names IDs; Planner payload not yet validated

    // 3. No proposed content may claim canonical status.
    const literalIds = idsInStringLiterals(change.content, path);
    if (CAN_TAG.test(change.content) || literalIds.some((id) => id.startsWith('CAN-'))) {
      fail(
        'STD-TRC-003',
        'proposed content contains a canonical (@CAN-) tag; only humans designate canonical tests',
        path,
      );
    }

    if (changeKind !== 'test-change' || !TEST_FILE.test(path)) continue;

    // 4. A test file's IDs equal its declared traceability.
    if (artifact.agent.name === 'generator' && traceability.testCases.length === 0) {
      fail('STD-TRC-001', 'generated test must cite at least one approved test case', path);
    }
    const found = new Set(literalIds.filter((id) => !id.startsWith('CAN-')));
    for (const id of [...traceability.requirements, ...traceability.testCases]) {
      if (!found.has(id))
        fail('STD-TRC-002', `declared ${id} is missing from the test's tags`, path);
    }
    for (const id of found) {
      if (![...traceability.requirements, ...traceability.testCases].includes(id)) {
        fail('STD-TRC-002', `test references ${id}, which its traceability does not declare`, path);
      }
    }

    // 5. A modified test keeps its REQ/TC IDs.
    if (change.operation === 'modify') {
      const current = readFileSync(resolve(repoRoot, path), 'utf8');
      const before = idsInStringLiterals(current, path)
        .filter((id) => !id.startsWith('CAN-'))
        .sort();
      const after = [...found].sort();
      if (before.join() !== after.join()) {
        fail(
          'STD-TRC-003',
          `modified test changes its IDs from [${before.join(', ')}] to [${after.join(', ')}]`,
          path,
        );
      }
    }
  }

  return result(failures);
}

/**
 * REQ, TC and CAN IDs appearing in the file's string and template literals, deduplicated.
 * Comments are ignored. This covers literal tags (`'@TC-001-17'`) and data-driven tags
 * whose IDs live in data rows (`tc: 'TC-001-04'` with `tag: \`@${tc}\``).
 */
export function idsInStringLiterals(source: string, fileName = 'proposed.ts'): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      for (const match of node.text.matchAll(ID_IN_TEXT)) {
        if (match[1]) found.add(match[1]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found];
}

function isApproved(id: string, approved: ApprovedIdsResult): boolean {
  return (
    approved.ids.requirements.has(id) ||
    approved.ids.testCases.has(id) ||
    approved.ids.canonicals.has(id)
  );
}

function result(failures: GuardFailure[]): GuardResult {
  return { guard: 'G-TRACE', status: failures.length === 0 ? 'passed' : 'failed', failures };
}
