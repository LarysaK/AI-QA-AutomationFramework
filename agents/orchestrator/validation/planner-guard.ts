import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type ApprovedIds, parseRequirements, parseTestPlanRows } from './approved-ids';
import { CLAIM_PATTERNS } from './claims';
import { idsInStringLiterals } from './trace-guard';
import type { GuardFailure } from './types';

/**
 * Planner content rules (Planner definition 1.0: PLN-001 – PLN-006), checked by G-TRACE for every
 * `test-plan-proposal` artifact, after G-SCHEMA has validated the envelope and the Planner
 * payload schema. Read-only: the approved documents and committed tests are read, never written.
 *
 * The proposal is untrusted model output. A schema-valid proposal is not an approved plan: it only
 * becomes eligible for human review at gate H1.
 */

export interface PlanProposedTestCase {
  readonly provisionalId: string;
  readonly requirementId: string;
  readonly scenario: string;
  readonly level: string;
  readonly type: string;
  readonly priority: string;
  readonly automationCandidate: boolean;
  readonly rationale: string;
  readonly acceptanceCriteria: readonly string[];
  readonly relatedTestCases: readonly string[];
}

export interface PlanPayload {
  readonly modelCall: 'anthropic-api' | 'offline-recorded-output';
  readonly requestedModel: string | null;
  readonly servedModel: string;
  readonly effort: string | null;
  readonly maxTokens: number | null;
  readonly definitionVersion: string;
  readonly requestedRequirements: readonly string[];
  readonly reviewGate: 'H1';
  readonly proposedTestCases: readonly PlanProposedTestCase[];
  readonly automationCandidates: readonly {
    readonly testCaseId: string;
    readonly rationale: string;
  }[];
}

/** The fields of a schema-valid `test-plan-proposal` envelope that the Planner rules read. */
export interface PlanArtifact {
  readonly status: 'READY' | 'BLOCKED' | 'NEEDS_HUMAN_DECISION';
  readonly summary: string;
  readonly traceability: {
    readonly requirements: readonly string[];
    readonly testCases: readonly string[];
  };
  readonly sourceReferences: readonly {
    readonly path: string;
    readonly role: string;
    readonly ids?: readonly string[];
  }[];
  readonly assumptions: readonly { readonly statement: string; readonly impact: string }[];
  readonly findings: readonly { readonly message: string }[];
  readonly contextRequests?: readonly string[];
  readonly proposedChanges: readonly unknown[];
  readonly payload: PlanPayload;
}

// The claim patterns are shared with the Healer rules (claims.ts); re-exported for callers.
export { CLAIM_PATTERNS } from './claims';

const PTC = /^PTC-(\d{3})-\d{2}$/;

export function checkPlanProposal(
  artifact: PlanArtifact,
  approved: ApprovedIds,
  repoRoot: string,
): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const fail = (ruleId: string, reason: string): void => {
    failures.push({ guard: 'G-TRACE', ruleIds: [ruleId], reason });
  };
  // G-SCHEMA guarantees this shape; G-TRACE can also be called directly, so fail closed here.
  if (!isPlanShape(artifact)) {
    fail(
      'PLN-006',
      'not a schema-valid Planner artifact: the payload, its arrays or the text fields are missing',
    );
    return failures;
  }
  const { payload, traceability } = artifact;
  const requested = [...payload.requestedRequirements].sort();

  // PLN-001: no file changes.
  if (artifact.proposedChanges.length > 0) {
    fail(
      'PLN-001',
      `a Planner v1 artifact proposes no file changes, but it has ${String(artifact.proposedChanges.length)}`,
    );
  }

  // PLN-006: provenance, part 1 (the request and the gate).
  if (requested.join() !== [...traceability.requirements].sort().join()) {
    fail('PLN-006', 'payload.requestedRequirements must equal traceability.requirements');
  }
  if (payload.modelCall === 'offline-recorded-output') {
    if (payload.requestedModel !== null || payload.effort !== null || payload.maxTokens !== null) {
      fail(
        'PLN-006',
        'an offline-recorded output records no requested model, effort or token budget',
      );
    }
  } else if (payload.requestedModel === null) {
    fail('PLN-006', 'a model call must record the requested model');
  }

  // PLN-006: provenance, part 2 (the approved sources the proposal was made from).
  const sources = approvedSources(artifact, requested, repoRoot, fail);
  if (sources === undefined) return failures;
  const { requirementsText, planRows } = sources;

  // PLN-005: status consistency.
  const proposals = payload.proposedTestCases;
  const candidates = payload.automationCandidates;
  if (artifact.status === 'READY' && proposals.length === 0 && candidates.length === 0) {
    fail('PLN-005', 'a READY plan proposal needs at least one proposed test case or candidate');
  }
  if (artifact.status !== 'READY' && (proposals.length > 0 || candidates.length > 0)) {
    fail('PLN-005', `status ${artifact.status} must carry no proposals or automation candidates`);
  }

  // PLN-002 / PLN-003: each proposed test case.
  const seenIds = new Set<string>();
  const seenScenarios = new Map<string, string>();
  const approvedScenarios = new Map<string, string>(); // normalized scenario → TC
  for (const row of planRows.values()) {
    if (requested.includes(row.requirement)) {
      approvedScenarios.set(normalize(row.cells['Scenario'] ?? ''), row.testCase);
    }
  }
  const cited = new Set<string>();
  for (const proposal of proposals) {
    const at = proposal.provisionalId;
    if (seenIds.has(at)) fail('PLN-002', `duplicate provisional ID ${at}`);
    seenIds.add(at);
    if (!requested.includes(proposal.requirementId)) {
      fail('PLN-002', `${at}: ${proposal.requirementId} is not a requested requirement`);
      continue;
    }
    const number = PTC.exec(at)?.[1];
    if (`REQ-${number ?? ''}` !== proposal.requirementId) {
      fail('PLN-002', `${at}: a provisional ID must use the number of ${proposal.requirementId}`);
    }
    const criteria = acceptanceCriteria(requirementsText, proposal.requirementId);
    for (const quote of proposal.acceptanceCriteria) {
      if (!criteria.includes(normalizeQuote(quote))) {
        fail(
          'PLN-002',
          `${at}: "${clip(quote)}" is not an acceptance criterion of ${proposal.requirementId}`,
        );
      }
    }
    const scenario = normalize(proposal.scenario);
    const sameAsApproved = approvedScenarios.get(scenario);
    if (sameAsApproved !== undefined) {
      fail('PLN-003', `${at} restates approved test case ${sameAsApproved}; reference it instead`);
    }
    const sameAsProposed = seenScenarios.get(scenario);
    if (sameAsProposed !== undefined) {
      fail('PLN-003', `${at} duplicates the scenario of ${sameAsProposed}`);
    }
    seenScenarios.set(scenario, at);
    for (const tc of proposal.relatedTestCases) {
      cited.add(tc);
      checkApprovedTestCase(tc, `${at}: related test case`, approved, requested, fail);
    }
  }

  // PLN-003: automation candidates.
  const referenced = committedReferences(repoRoot);
  const seenCandidates = new Set<string>();
  for (const { testCaseId: tc } of candidates) {
    cited.add(tc);
    if (seenCandidates.has(tc)) fail('PLN-003', `automation candidate ${tc} is listed twice`);
    seenCandidates.add(tc);
    if (!checkApprovedTestCase(tc, 'automation candidate', approved, requested, fail)) continue;
    const automation = planRows.get(tc)?.cells['Automation'];
    if (automation !== 'Yes') {
      fail(
        'PLN-003',
        `automation candidate ${tc} is marked "Automation: ${automation ?? '?'}" in the approved plan; changing that is a plan change (H1)`,
      );
    }
    const files = referenced.get(tc);
    if (files !== undefined) {
      fail('PLN-003', `automation candidate ${tc} is already referenced by ${files.join(', ')}`);
    }
  }

  // PLN-006: traceability.testCases is exactly the approved test cases the payload cites.
  if ([...cited].sort().join() !== [...traceability.testCases].sort().join()) {
    fail(
      'PLN-006',
      'traceability.testCases must list exactly the related test cases and automation candidates',
    );
  }

  // PLN-004: no claims of approval, authorization or execution.
  for (const [where, text] of modelText(artifact)) {
    for (const [what, pattern] of CLAIM_PATTERNS) {
      if (pattern.test(text))
        fail('PLN-004', `${where} claims or requests ${what}: "${clip(text)}"`);
    }
  }

  return failures;
}

function isPlanShape(artifact: PlanArtifact): boolean {
  const value = artifact as unknown as Record<string, unknown>;
  const raw: unknown = value['payload'];
  if (typeof raw !== 'object' || raw === null) return false;
  const payload = raw as Record<string, unknown>;
  const isArray = (v: unknown): boolean => Array.isArray(v);
  return (
    isArray(payload['requestedRequirements']) &&
    isArray(payload['proposedTestCases']) &&
    isArray(payload['automationCandidates']) &&
    typeof value['summary'] === 'string' &&
    isArray(value['assumptions']) &&
    isArray(value['findings']) &&
    isArray(value['sourceReferences']) &&
    isArray(value['proposedChanges'])
  );
}

/** The requirements and test plan the artifact cites, if they are consistent and approved. */
function approvedSources(
  artifact: PlanArtifact,
  requested: readonly string[],
  repoRoot: string,
  fail: (ruleId: string, reason: string) => void,
): { requirementsText: string; planRows: ReturnType<typeof parseTestPlanRows> } | undefined {
  const requirementRefs = artifact.sourceReferences.filter((s) => s.role === 'requirements');
  const planRefs = artifact.sourceReferences.filter((s) => s.role === 'test-plan');
  const requirementsPath = requirementRefs[0]?.path;
  const planPath = planRefs[0]?.path;
  const unique = (refs: readonly { path: string }[]): boolean =>
    new Set(refs.map((r) => r.path)).size === 1;
  if (
    requirementsPath === undefined ||
    planPath === undefined ||
    !unique(requirementRefs) ||
    !unique(planRefs) ||
    !/^specs\/(.+\/)?requirements\.md$/.test(requirementsPath) ||
    planPath !== join(dirname(requirementsPath), 'test-plan.md').split('\\').join('/')
  ) {
    fail(
      'PLN-006',
      'sourceReferences must name exactly one requirements.md and the test-plan.md next to it',
    );
    return undefined;
  }
  const root = (path: string): string | undefined => {
    const full = join(repoRoot, path);
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
  };
  const requirementsText = root(requirementsPath);
  const planText = root(planPath);
  if (requirementsText === undefined || planText === undefined) {
    fail('PLN-006', `the cited sources ${requirementsPath} and ${planPath} must exist`);
    return undefined;
  }
  const defined = parseRequirements(requirementsText).ids;
  const cited = new Set(requirementRefs.flatMap((r) => r.ids ?? []));
  for (const req of requested) {
    if (!defined.includes(req)) fail('PLN-006', `${req} is not defined in ${requirementsPath}`);
    if (!cited.has(req)) fail('PLN-006', `the requirements source reference does not cite ${req}`);
  }
  return { requirementsText, planRows: parseTestPlanRows(planText) };
}

function checkApprovedTestCase(
  tc: string,
  where: string,
  approved: ApprovedIds,
  requested: readonly string[],
  fail: (ruleId: string, reason: string) => void,
): boolean {
  const owner = approved.testCases.get(tc);
  if (owner === undefined) {
    fail('PLN-003', `${where} ${tc} is not an approved test case`);
    return false;
  }
  if (!requested.includes(owner)) {
    fail('PLN-003', `${where} ${tc} belongs to ${owner}, which is not a requested requirement`);
    return false;
  }
  return true;
}

/** The normalized text of a requirement's "### Acceptance criteria" block. */
export function acceptanceCriteria(requirementsText: string, requirement: string): string {
  const lines = requirementsText.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${requirement} — `));
  if (start < 0) return '';
  const block: string[] = [];
  let inCriteria = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line) || /^---\s*$/.test(line)) break;
    if (/^###\s/.test(line)) {
      inCriteria = /^###\s+Acceptance criteria\s*$/.test(line);
      continue;
    }
    if (inCriteria) block.push(line);
  }
  return normalizeQuote(block.join('\n'));
}

/** Whitespace-insensitive text without bullets or Markdown link targets. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s*-\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparable scenario text: case, Markdown code marks, spacing and final period ignored. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
}

/**
 * Test-case IDs in the string literals of committed `tests/**` TypeScript files, with the files
 * (sorted). A static reference, not proof of coverage.
 */
export function committedReferences(repoRoot: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const testsDir = join(repoRoot, 'tests');
  if (!existsSync(testsDir)) return found;
  const files = readdirSync(testsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    const rel = file
      .slice(repoRoot.length + 1)
      .split('\\')
      .join('/');
    for (const id of idsInStringLiterals(readFileSync(file, 'utf8'), file)) {
      if (id.startsWith('TC-')) found.set(id, [...(found.get(id) ?? []), rel]);
    }
  }
  return found;
}

/** Every model-owned text field, with its location. */
function modelText(artifact: PlanArtifact): [string, string][] {
  const out: [string, string][] = [['summary', artifact.summary]];
  artifact.payload.proposedTestCases.forEach((p) => {
    out.push(
      [`${p.provisionalId} scenario`, p.scenario],
      [`${p.provisionalId} rationale`, p.rationale],
    );
  });
  artifact.payload.automationCandidates.forEach((c) => {
    out.push([`candidate ${c.testCaseId} rationale`, c.rationale]);
  });
  artifact.assumptions.forEach((a, i) => {
    out.push([`assumption ${String(i + 1)}`, `${a.statement} ${a.impact}`]);
  });
  artifact.findings.forEach((f, i) => {
    out.push([`finding ${String(i + 1)}`, f.message]);
  });
  (artifact.contextRequests ?? []).forEach((c, i) => {
    out.push([`context request ${String(i + 1)}`, c]);
  });
  return out;
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
