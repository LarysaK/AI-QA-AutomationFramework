import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLAIM_PATTERNS } from './claims';
import type { GuardFailure } from './types';

/**
 * Healer content rules (Healer definition 1.0: HEA-001 – HEA-009), checked by G-TRACE for every
 * `heal-proposal` artifact, after G-SCHEMA has validated the envelope and the Healer payload
 * schema. Read-only: the committed files are read, never written.
 *
 * HEA-005 – HEA-007 implement the Healer's part of the deferred G-ASSERT guard (Agent Standard
 * section 16) without changing the Standard's guard table: a repair may not weaken checks,
 * suppress tests, or conceal failures with waits, timeouts or retries.
 *
 * The proposal is untrusted model output. A schema-valid repair is not an approved repair: it still
 * needs the execution-capable guards (H7) and human approval (H3), and it is never applied here.
 */

export type FailureClassification =
  | 'test-code-issue'
  | 'application-defect'
  | 'environment-or-infrastructure'
  | 'test-data-or-setup'
  | 'insufficient-evidence';

/** The classifications that may carry a repair; all others are diagnosis only. */
export const REPAIRABLE: readonly FailureClassification[] = [
  'test-code-issue',
  'test-data-or-setup',
];
export const MAX_REPAIR_CHANGES = 3;

export interface HealPayload {
  readonly modelCall: 'anthropic-api' | 'offline-recorded-output';
  readonly requestedModel: string | null;
  readonly effort: string | null;
  readonly maxTokens: number | null;
  readonly failure: { readonly testFile: string };
  readonly evidence: readonly {
    readonly id: string;
    readonly kind: string;
    readonly source: string;
  }[];
  readonly diagnosis: {
    readonly classification: FailureClassification;
    readonly explanation: string;
    readonly evidenceRefs: readonly string[];
    readonly alternatives: readonly {
      readonly classification: FailureClassification;
      readonly explanation: string;
      readonly evidenceRefs: readonly string[];
    }[];
    readonly missingEvidence: readonly string[];
    readonly recommendedInvestigation: readonly string[];
  };
  readonly repair: {
    readonly expectedBehaviorPreserved: string;
    readonly risks: readonly string[];
    readonly validationSteps: readonly string[];
  } | null;
}

/** The fields of a schema-valid `heal-proposal` envelope that the Healer rules read. */
export interface HealArtifact {
  readonly status: 'READY' | 'BLOCKED' | 'NEEDS_HUMAN_DECISION';
  readonly summary: string;
  readonly sourceReferences: readonly { readonly path: string; readonly role: string }[];
  readonly assumptions: readonly { readonly statement: string; readonly impact: string }[];
  readonly findings: readonly { readonly kind: string; readonly message: string }[];
  readonly contextRequests?: readonly string[];
  readonly proposedChanges: readonly {
    readonly path: string;
    readonly operation: string;
    readonly content: string;
    readonly rationale: string;
    readonly impact?: string;
  }[];
  readonly payload: HealPayload;
}

/** Healer-specific claims, beyond the shared approval, authorization and execution claims. */
export const HEALER_CLAIM_PATTERNS: readonly (readonly [string, RegExp])[] = [
  [
    'a resolved defect',
    /\b(defect|bug|issue|failure|problem)\s+(is|has been|was)\s+(now\s+)?(fixed|resolved|closed)\b/i,
  ],
  [
    'a verified repair',
    /\b(repair|fix|patch|change)\s+(has\s+)?(passed|been verified|been validated|was verified|works|is verified)\b/i,
  ],
  ['a verified repair', /\b(verified|confirmed)\s+(that\s+)?(the\s+)?(repair|fix|patch)\b/i],
  ['a passing run', /\b(tests?|suite)\s+(now\s+)?(pass(es)?|is green|are green)\b/i],
  ['a re-run', /\bre-?ran\b/i],
  [
    'a defect or ticket ID',
    /\b(ticket|issue|bug|defect|jira)\s*(#|id)?\s*:?\s*([A-Z][A-Z0-9]{1,9}-\d+|#\d+)\b/i,
  ],
  [
    'a created defect record',
    /\b(filed|created|opened|raised|logged)\s+(a\s+|the\s+)?(defect|bug|ticket|issue)\b/i,
  ],
];

/**
 * Lines that check behaviour: assertions, status and error codes, authentication helpers and
 * response-status guards (`response.ok()`).
 */
const CHECK_LINE =
  /\bexpect(\.\w+)?\s*\(|\.(toBe|toEqual|toStrictEqual|toHave\w*|toMatch\w*|toContain\w*|toBeTruthy|toBeFalsy|toBeNull|toBeDefined|toBeUndefined|toThrow\w*|toBeVisible|toBeHidden|toBeGreaterThan\w*|toBeLessThan\w*)\s*\(|\b(400|401|403|404|409)\b|\b(VALIDATION_ERROR|UNAUTHENTICATED|FORBIDDEN|NOT_FOUND|INVALID_STATE_TRANSITION)\b|\b(loginAs|logInAs)\s*\(|\.ok\(\s*\)/;

const TAUTOLOGIES: readonly RegExp[] = [
  /expect\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
  /expect\(\s*([A-Za-z_$][\w$.]*)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
  /expect\(\s*(true|1|'[^']+'|"[^"]+")\s*\)\s*\.\s*toBeTruthy\(\s*\)/,
  /expect\(\s*(false|0|null|undefined)\s*\)\s*\.\s*toBeFalsy\(\s*\)/,
];

const SUPPRESSIONS: readonly (readonly [string, RegExp])[] = [
  [
    'a skip, only, fixme, fail or slow annotation',
    /\b(test|it|describe)(\.(describe|serial|parallel))?\.(skip|only|fixme|fail|slow)\b/g,
  ],
  ['a soft assertion', /\bexpect\.soft\b/g],
  ['an empty catch block', /catch\s*(\([^)]*\))?\s*\{\s*\}/g],
  ['a type-check or lint suppression', /@ts-(ignore|expect-error|nocheck)|eslint-disable/g],
];

const FIXED_WAIT = /\bwaitForTimeout\s*\(/g;
const TIMER = /\bsetTimeout\s*\(/g;
const TIMEOUT_VALUES =
  /\b(timeout|retries|actionTimeout|navigationTimeout|expectTimeout)\s*[:=]\s*(\d[\d_]*)|\b(setTimeout|\.timeout|test\.setTimeout)\s*\(\s*(?:[^,()]*,\s*)?(\d[\d_]*)/g;

export function checkHealProposal(artifact: HealArtifact, repoRoot: string): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const fail = (ruleId: string, reason: string, path?: string): void => {
    failures.push({
      guard: 'G-TRACE',
      ruleIds: [ruleId],
      reason,
      ...(path === undefined ? {} : { path }),
    });
  };

  // HEA-001: a complete Healer payload (G-SCHEMA guarantees it; G-TRACE may be called directly).
  if (!isHealShape(artifact)) {
    fail('HEA-001', 'not a schema-valid Healer artifact: the payload or its parts are missing');
    return failures;
  }
  const { payload, proposedChanges: changes } = artifact;
  const { diagnosis, failure } = payload;
  const testRefs = artifact.sourceReferences.filter(
    (s) => s.role === 'test' || s.role === 'canonical-test',
  );
  if (testRefs.length !== 1 || testRefs[0]?.path !== failure.testFile) {
    fail('HEA-001', `sourceReferences must name the failing test ${failure.testFile} exactly once`);
  }
  const supportPaths = new Set(
    artifact.sourceReferences.filter((s) => s.role === 'support').map((s) => s.path),
  );

  // HEA-009: provenance and evidence identity.
  if (payload.modelCall === 'offline-recorded-output') {
    if (payload.requestedModel !== null || payload.effort !== null || payload.maxTokens !== null) {
      fail(
        'HEA-009',
        'an offline-recorded output records no requested model, effort or token budget',
      );
    }
  } else if (payload.requestedModel === null) {
    fail('HEA-009', 'a model call must record the requested model');
  }
  const ids = payload.evidence.map((e) => e.id);
  const expected = ids.map((_, i) => `E-${String(i + 1).padStart(3, '0')}`);
  if (ids.join() !== expected.join()) {
    fail('HEA-009', 'evidence IDs must be unique and numbered E-001, E-002, … in order');
  }

  // HEA-002: evidence references.
  const known = new Set(ids);
  const checkRefs = (refs: readonly string[], where: string): void => {
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!known.has(ref)) fail('HEA-002', `${where} cites ${ref}, which is not an evidence item`);
      if (seen.has(ref)) fail('HEA-002', `${where} cites ${ref} more than once`);
      seen.add(ref);
    }
  };
  if (diagnosis.evidenceRefs.length === 0) fail('HEA-002', 'the diagnosis cites no evidence');
  checkRefs(diagnosis.evidenceRefs, 'the diagnosis');
  diagnosis.alternatives.forEach((alt, i) => {
    checkRefs(alt.evidenceRefs, `alternative ${String(i + 1)}`);
    if (alt.classification === diagnosis.classification) {
      fail(
        'HEA-002',
        `alternative ${String(i + 1)} repeats the primary classification ${alt.classification}`,
      );
    }
  });

  // HEA-003: classification, status and repair belong together.
  const hasRepair = changes.length > 0;
  if (hasRepair !== (payload.repair !== null)) {
    fail(
      'HEA-003',
      'repair metadata and proposed changes must be present together, or both absent',
    );
  }
  if (hasRepair && !REPAIRABLE.includes(diagnosis.classification)) {
    fail(
      'HEA-003',
      `a ${diagnosis.classification} diagnosis must not propose a repair${diagnosis.classification === 'application-defect' ? '; escalate the defect candidate instead of working around it' : ''}`,
    );
  }
  if (hasRepair && artifact.status !== 'READY') {
    fail('HEA-003', `status ${artifact.status} must not propose a repair`);
  }
  if (
    diagnosis.classification === 'application-defect' &&
    !artifact.findings.some((f) => f.kind === 'defect-candidate')
  ) {
    fail(
      'HEA-003',
      'an application-defect diagnosis needs a defect-candidate finding for human triage',
    );
  }
  if (
    diagnosis.classification === 'insufficient-evidence' &&
    diagnosis.missingEvidence.length === 0
  ) {
    fail('HEA-003', 'an insufficient-evidence diagnosis must list the missing evidence');
  }

  // HEA-004 – HEA-007: each proposed change.
  if (changes.length > MAX_REPAIR_CHANGES) {
    fail(
      'HEA-004',
      `a repair proposes at most ${String(MAX_REPAIR_CHANGES)} changes, not ${String(changes.length)}`,
    );
  }
  for (const change of changes) {
    const { path } = change;
    if (change.operation !== 'modify') {
      fail('HEA-004', 'a repair only modifies existing files; it never creates one', path);
      continue;
    }
    if (path !== failure.testFile && !supportPaths.has(path)) {
      fail(
        'HEA-004',
        'a repair may only modify the failing test or a support file it imports',
        path,
      );
      continue;
    }
    const full = join(repoRoot, path);
    if (!existsSync(full)) {
      fail('HEA-004', 'the file to modify does not exist', path);
      continue;
    }
    checkContent(readFileSync(full, 'utf8'), change.content, path, fail);
  }

  // HEA-008: no claims of approval, authorization, execution, verification or resolution.
  // Suggested validation steps may name a command for a human to run; every other pattern applies.
  for (const [where, text] of modelText(artifact)) {
    for (const [what, pattern] of [...CLAIM_PATTERNS, ...HEALER_CLAIM_PATTERNS]) {
      if (where.startsWith('validation step') && what === 'a command to execute') continue;
      if (pattern.test(text))
        fail('HEA-008', `${where} claims or requests ${what}: "${clip(text)}"`);
    }
  }
  return failures;
}

/** HEA-005 – HEA-007 for one change: the current file against the proposed content. */
export function checkContent(
  current: string,
  proposed: string,
  path: string,
  fail: (ruleId: string, reason: string, path?: string) => void,
): void {
  const lines = (text: string): string[] =>
    text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const proposedLines = new Set(lines(proposed));
  const currentLines = new Set(lines(current));

  // HEA-005: every check line is kept verbatim; no tautology is added.
  for (const line of lines(current)) {
    if (line !== '' && CHECK_LINE.test(line) && !proposedLines.has(line)) {
      fail('HEA-005', `removes or changes the check "${clip(line)}"`, path);
    }
  }
  for (const line of lines(proposed)) {
    if (currentLines.has(line)) continue;
    if (TAUTOLOGIES.some((pattern) => pattern.test(line))) {
      fail('HEA-005', `adds a tautological assertion "${clip(line)}"`, path);
    }
  }

  // HEA-006: no added suppression.
  for (const [what, pattern] of SUPPRESSIONS) {
    if (count(proposed, pattern) > count(current, pattern)) fail('HEA-006', `adds ${what}`, path);
  }

  // HEA-007: no added fixed waits or timers; no new or larger timeouts or retries.
  if (count(proposed, FIXED_WAIT) > count(current, FIXED_WAIT))
    fail('HEA-007', 'adds a fixed wait (waitForTimeout)', path);
  if (count(proposed, TIMER) > count(current, TIMER))
    fail('HEA-007', 'adds a timer (setTimeout)', path);
  const before = timeoutValues(current);
  const after = timeoutValues(proposed);
  if (after.length > before.length || Math.max(0, ...after) > Math.max(0, ...before)) {
    fail('HEA-007', 'adds or increases a timeout or retry value', path);
  }
}

function timeoutValues(text: string): number[] {
  return [...text.matchAll(TIMEOUT_VALUES)].map((m) =>
    Number((m[2] ?? m[4] ?? '0').replace(/_/g, '')),
  );
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function isHealShape(artifact: HealArtifact): boolean {
  const value = artifact as unknown as Record<string, unknown>;
  const raw: unknown = value['payload'];
  if (typeof raw !== 'object' || raw === null) return false;
  const payload = raw as Record<string, unknown>;
  const diagnosis = payload['diagnosis'] as Record<string, unknown> | null | undefined;
  const failure = payload['failure'] as Record<string, unknown> | null | undefined;
  const arrays = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
    keys.every((key) => Array.isArray(record[key]));
  return (
    typeof diagnosis === 'object' &&
    diagnosis !== null &&
    typeof failure === 'object' &&
    failure !== null &&
    typeof failure['testFile'] === 'string' &&
    arrays(diagnosis, [
      'evidenceRefs',
      'alternatives',
      'missingEvidence',
      'recommendedInvestigation',
    ]) &&
    arrays(payload, ['evidence']) &&
    'repair' in payload &&
    typeof value['summary'] === 'string' &&
    arrays(value, ['sourceReferences', 'assumptions', 'findings', 'proposedChanges'])
  );
}

/** Every model-owned text field, with its location. File contents are checked by HEA-005 – 007. */
function modelText(artifact: HealArtifact): [string, string][] {
  const { diagnosis, repair } = artifact.payload;
  const out: [string, string][] = [
    ['summary', artifact.summary],
    ['diagnosis explanation', diagnosis.explanation],
  ];
  diagnosis.alternatives.forEach((a, i) =>
    out.push([`alternative ${String(i + 1)}`, a.explanation]),
  );
  diagnosis.missingEvidence.forEach((t, i) => out.push([`missing evidence ${String(i + 1)}`, t]));
  diagnosis.recommendedInvestigation.forEach((t, i) =>
    out.push([`investigation ${String(i + 1)}`, t]),
  );
  if (repair !== null) {
    out.push(['expected behaviour preserved', repair.expectedBehaviorPreserved]);
    repair.risks.forEach((t, i) => out.push([`risk ${String(i + 1)}`, t]));
    repair.validationSteps.forEach((t, i) => out.push([`validation step ${String(i + 1)}`, t]));
  }
  artifact.proposedChanges.forEach((c) => {
    out.push([`${c.path} rationale`, c.rationale]);
    if (c.impact !== undefined) out.push([`${c.path} impact`, c.impact]);
  });
  artifact.assumptions.forEach((a, i) =>
    out.push([`assumption ${String(i + 1)}`, `${a.statement} ${a.impact}`]),
  );
  artifact.findings.forEach((f, i) => out.push([`finding ${String(i + 1)}`, f.message]));
  (artifact.contextRequests ?? []).forEach((c, i) =>
    out.push([`context request ${String(i + 1)}`, c]),
  );
  return out;
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
