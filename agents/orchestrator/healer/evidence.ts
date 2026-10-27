import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  defaultSafetyContext,
  publicSafetyFindings,
} from '../../../reporting/dashboard-data/sanitize';
import { parsePlaywrightJson } from '../../../reporting/ci/reports';
import { section, supportFiles } from '../generator/context';
import { GeneratorStop } from '../generator/select';
import { findSecrets } from '../generator/stage';
import { screenUntrustedText } from '../planner/context';
import { loadApprovedIds } from '../validation/approved-ids';
import { gitBlobSha } from '../validation/base-guard';
import { idsInStringLiterals } from '../validation/trace-guard';

/**
 * Failure evidence for the Healer (Healer definition: Evidence). Deterministic and read-only; runs
 * before any model call, and every problem stops the run. The only accepted evidence is a
 * Playwright JSON report in which the selected, committed test failed. Everything taken from the
 * report is untrusted: it is sanitized, screened for instructions and secrets, and bounded.
 */

export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
export const MAX_ITEM_BYTES = 8 * 1024;
export const MAX_STEPS = 50;
export const CONTEXT_LIMIT_BYTES = 64 * 1024;
const TESTS_DIR = 'tests';
const STANDARD = 'agents/standard/standard.md';
const SELECTOR = /^(tests\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:spec|test)\.ts):([1-9]\d*)$/;

export class HealerStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealerStop';
  }
}

export type EvidenceKind =
  | 'error-message'
  | 'stack'
  | 'expected-actual'
  | 'steps'
  | 'attempts'
  | 'environment'
  | 'test-source'
  | 'support-source';

export interface EvidenceItem {
  readonly id: string;
  readonly kind: EvidenceKind;
  /** Where it came from: a report location or a repository path. */
  readonly source: string;
  readonly text: string;
}

export interface ContextPiece {
  readonly path: string;
  readonly role: 'architecture' | 'requirements' | 'test-plan';
  readonly section: string;
  readonly text: string;
  readonly bytes: number;
  readonly blobSha: string;
  readonly ids: readonly string[];
}

export interface FailureEvidence {
  readonly app: string;
  readonly report: {
    readonly name: string;
    readonly sha256: string;
    readonly playwrightVersion: string;
    readonly startedAt: string;
  };
  readonly failure: {
    readonly specId: string;
    readonly testFile: string;
    readonly title: string;
    readonly line: number;
    readonly project: string;
    readonly attempts: readonly string[];
  };
  readonly requirements: readonly string[];
  readonly testCases: readonly string[];
  readonly testRole: 'test' | 'canonical-test';
  readonly supportFiles: readonly string[];
  readonly items: readonly EvidenceItem[];
  readonly pieces: readonly ContextPiece[];
  readonly totalBytes: number;
}

export function parseSelector(value: string): { testFile: string; line: number } {
  const match = SELECTOR.exec(value);
  if (!match?.[1] || !match[2] || match[1].split('/').some((s) => s === '..' || s === '.')) {
    throw new HealerStop(`"${value}" is not a test reference (tests/<path>.spec.ts:<line>)`);
  }
  return { testFile: match[1], line: Number(match[2]) };
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A scalar as text; anything else as "unknown" (never "[object Object]"). */
const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : 'unknown';
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export function loadFailureEvidence(
  repoRoot: string,
  app: string,
  reportPath: string,
  selector: { readonly testFile: string; readonly line: number },
  env: NodeJS.ProcessEnv,
): FailureEvidence {
  // 1. Authentic failure evidence: a complete, consistent Playwright JSON report.
  const stat = lstatSync(reportPath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    throw new HealerStop(
      `no failure evidence: the report ${basename(reportPath)} is missing or not a regular file`,
    );
  }
  if (stat.size > MAX_REPORT_BYTES)
    throw new HealerStop(`the report is larger than ${String(MAX_REPORT_BYTES)} bytes`);
  const bytes = readFileSync(reportPath);
  const text = bytes.toString('utf8');
  const parsed = parsePlaywrightJson(text);
  if (!parsed.ok)
    throw new HealerStop(
      `no failure evidence: the report is not a valid Playwright JSON report (${parsed.reason})`,
    );
  const report = JSON.parse(text) as Json;
  const config = report['config'] as Json;
  const stats = report['stats'] as Json;

  // 2. The selected test, failed in this report.
  const spec = findSpec(report['suites'], selector);
  if (spec === undefined) {
    throw new HealerStop(
      `no failure evidence: the report has no test at ${selector.testFile}:${String(selector.line)}`,
    );
  }
  const tests = Array.isArray(spec['tests']) ? (spec['tests'] as unknown[]).filter(isRecord) : [];
  const failed = tests.find((t) => t['status'] === 'unexpected');
  if (failed === undefined) {
    throw new HealerStop(
      `no failure evidence: ${selector.testFile}:${String(selector.line)} did not fail in this report (status ${tests.map((t) => String(t['status'])).join(', ') || 'unknown'})`,
    );
  }
  const results = (Array.isArray(failed['results']) ? failed['results'] : []).filter(isRecord);
  const project = String(failed['projectName']);
  const title = String(spec['title']);

  // 3. A committed test whose tags are approved and present in the file.
  const testFile = selector.testFile;
  const absolute = join(repoRoot, testFile);
  if (!existsSync(absolute) || !isTracked(repoRoot, testFile)) {
    throw new HealerStop(`${testFile} is not a committed test file`);
  }
  const source = readFileSync(absolute, 'utf8');
  const declaration = source.split('\n')[selector.line - 1] ?? '';
  if (!/\btest(\.\w+)?\s*\(/.test(declaration)) {
    throw new HealerStop(
      `line ${String(selector.line)} of ${testFile} does not declare a test; the report does not match the committed file`,
    );
  }
  const { ids, errors } = loadApprovedIds(repoRoot);
  if (errors.length > 0)
    throw new HealerStop(`approved documents cannot be parsed:\n  ${errors.join('\n  ')}`);
  const literals = new Set(idsInStringLiterals(source, testFile));
  const tags = (Array.isArray(spec['tags']) ? spec['tags'] : []).map((t) =>
    String(t).replace(/^@/, ''),
  );
  const requirements: string[] = [];
  const testCases: string[] = [];
  for (const tag of tags) {
    if (/^REQ-\d{3}$/.test(tag) || /^TC-\d{3}-\d{2}$/.test(tag)) {
      const approved = ids.requirements.has(tag) || ids.testCases.has(tag);
      if (!approved)
        throw new HealerStop(`the report tags the test with ${tag}, which is not approved`);
      if (!literals.has(tag))
        throw new HealerStop(
          `the report tags the test with ${tag}, which the committed file does not contain`,
        );
      (tag.startsWith('REQ-') ? requirements : testCases).push(tag);
    }
  }

  // 4. Evidence items, sanitized, in a fixed order.
  const raw: Omit<EvidenceItem, 'id'>[] = [];
  results.forEach((result, i) => {
    const at = `report: attempt ${String(i + 1)}`;
    const extra: unknown[] = Array.isArray(result['errors']) ? (result['errors'] as unknown[]) : [];
    const messages = [result['error'], ...extra]
      .filter(isRecord)
      .map((e) => (typeof e['message'] === 'string' ? e['message'] : ''))
      .filter((m) => m !== '');
    for (const message of [...new Set(messages)])
      raw.push({ kind: 'error-message', source: `${at} error`, text: message });
    const error = isRecord(result['error']) ? result['error'] : undefined;
    if (i === firstFailure(results) && typeof error?.['stack'] === 'string') {
      raw.push({ kind: 'stack', source: `${at} stack`, text: error['stack'] });
      const expectedActual = expectedAndReceived(
        stripAnsi(typeof error['message'] === 'string' ? error['message'] : ''),
      );
      if (expectedActual !== undefined)
        raw.push({ kind: 'expected-actual', source: `${at} error`, text: expectedActual });
    }
  });
  const steps = results.flatMap((r) => stepLines(r['steps'], 0));
  if (steps.length > MAX_STEPS)
    throw new HealerStop(`the report has more than ${String(MAX_STEPS)} steps for this test`);
  if (steps.length > 0)
    raw.push({ kind: 'steps', source: 'report: steps', text: steps.join('\n') });
  raw.push({
    kind: 'attempts',
    source: 'report: results',
    text: results
      .map(
        (r, i) =>
          `attempt ${String(i + 1)}: ${String(r['status'])} (retry ${String(r['retry'])}, ${String(r['duration'])} ms)`,
      )
      .join('\n'),
  });
  const projectConfig = (Array.isArray(config['projects']) ? config['projects'] : [])
    .filter(isRecord)
    .find((p) => p['name'] === project);
  raw.push({
    kind: 'environment',
    source: 'report: config',
    text: [
      `Playwright ${String(config['version'])}`,
      `project ${project}`,
      `retries ${str(projectConfig?.['retries'])}`,
      `timeout ${str(projectConfig?.['timeout'] ?? failed['timeout'])} ms`,
      `workers ${str(config['workers'])}`,
      `run started ${String(stats['startTime'])}`,
    ].join('; '),
  });
  const sanitized = raw.map((item) => ({ ...item, text: sanitize(item.text, repoRoot) }));

  // Committed source: the test and the support files it imports.
  let support: string[];
  try {
    support = supportFiles(repoRoot, app, [testFile]);
  } catch (error) {
    if (error instanceof GeneratorStop) throw new HealerStop(error.message);
    throw error;
  }
  const sourceItems: Omit<EvidenceItem, 'id'>[] = [
    { kind: 'test-source', source: testFile, text: source },
    ...support.map((path) => ({
      kind: 'support-source' as const,
      source: path,
      text: readFileSync(join(repoRoot, path), 'utf8'),
    })),
  ];
  const items = [...sanitized, ...sourceItems].map((item, i) => ({
    id: `E-${String(i + 1).padStart(3, '0')}`,
    ...item,
  }));

  // 5. Untrusted text screen, secret scan and limits; nothing is truncated.
  const safety = defaultSafetyContext(repoRoot);
  for (const item of items) {
    const instructions = screenUntrustedText(item.text);
    if (instructions.length > 0) {
      throw new HealerStop(
        `${item.id} (${item.source}) contains ${instructions.join(' and ')}; evidence is data, and nothing was sent to a model`,
      );
    }
    const unsafe = [
      ...findSecrets([{ path: item.id, content: item.text }], env),
      ...publicSafetyFindings({ text: item.text }, safety)
        .map((finding) => finding.replace(/^\/text: /, ''))
        .filter((category) => category !== 'stack trace'),
    ];
    if (unsafe.length > 0) {
      throw new HealerStop(
        `${item.id} (${item.source}) contains ${[...new Set(unsafe)].join(', ')}; redact the evidence first, and nothing was sent to a model`,
      );
    }
    if (Buffer.byteLength(item.text) > MAX_ITEM_BYTES) {
      throw new HealerStop(
        `${item.id} (${item.source}) is larger than ${String(MAX_ITEM_BYTES)} bytes; nothing was truncated`,
      );
    }
  }

  // 6. Approved context: the rules a diagnosis follows, and the behaviour the test checks.
  const pieces = approvedContext(repoRoot, app, requirements, testCases);
  const totalBytes = [
    ...pieces.map((p) => p.bytes),
    ...items.map((i) => Buffer.byteLength(i.text)),
  ].reduce((a, b) => a + b, 0);
  if (totalBytes > CONTEXT_LIMIT_BYTES) {
    throw new HealerStop(
      `context is ${String(totalBytes)} bytes, over the ${String(CONTEXT_LIMIT_BYTES)}-byte limit; nothing was truncated`,
    );
  }

  return {
    app,
    report: {
      name: basename(reportPath),
      sha256: sha256(bytes),
      playwrightVersion: String(config['version']),
      startedAt: String(stats['startTime']),
    },
    failure: {
      specId: String(spec['id']),
      testFile,
      title,
      line: selector.line,
      project,
      attempts: results.map((r) => String(r['status'])),
    },
    requirements: [...requirements].sort(),
    testCases: [...testCases].sort(),
    testRole: /@CAN-\d{3}/.test(source) ? 'canonical-test' : 'test',
    supportFiles: support,
    items,
    pieces,
    totalBytes,
  };
}

export function evidenceDigest(item: EvidenceItem): string {
  return sha256(item.text);
}

function findSpec(suites: unknown, selector: { testFile: string; line: number }): Json | undefined {
  const stack = Array.isArray(suites) ? [...(suites as unknown[])] : [];
  while (stack.length > 0) {
    const suite = stack.shift();
    if (!isRecord(suite)) continue;
    for (const spec of Array.isArray(suite['specs']) ? (suite['specs'] as unknown[]) : []) {
      if (
        isRecord(spec) &&
        `${TESTS_DIR}/${String(spec['file'])}` === selector.testFile &&
        spec['line'] === selector.line
      ) {
        return spec;
      }
    }
    if (Array.isArray(suite['suites'])) stack.push(...(suite['suites'] as unknown[]));
  }
  return undefined;
}

function firstFailure(results: readonly Json[]): number {
  return results.findIndex((r) => r['status'] !== 'passed');
}

function stepLines(steps: unknown, depth: number): string[] {
  if (!Array.isArray(steps) || depth > 5) return [];
  return steps
    .filter(isRecord)
    .flatMap((step) => [
      `${'  '.repeat(depth)}- ${String(step['title'])}${isRecord(step['error']) ? ' (failed)' : ''}`,
      ...stepLines(step['steps'], depth + 1),
    ]);
}

/** Playwright's "Expected: … / Received: …" lines, when the message has them. */
function expectedAndReceived(message: string): string | undefined {
  const expected = /^\s*Expected(?: [^:\n]*)?:\s*(.+)$/m.exec(message)?.[1];
  const received = /^\s*Received(?: [^:\n]*)?:\s*(.+)$/m.exec(message)?.[1];
  if (expected === undefined && received === undefined) return undefined;
  return [
    `Expected: ${expected ?? '(not stated)'}`,
    `Received: ${received ?? '(not stated)'}`,
  ].join('\n');
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** ANSI codes removed; absolute paths reduced to their repository part, or replaced by <path>. */
export function sanitize(text: string, repoRoot: string): string {
  const withoutRoot = stripAnsi(text).split(repoRoot).join('');
  return withoutRoot.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`()<>:,]+){2,}/g, (path) => {
    const posix = path.split('\\').join('/');
    const at = posix.search(/\/(tests|apps|agents|specs|node_modules)\//);
    return at >= 0 ? posix.slice(at + 1) : '<path>';
  });
}

function isTracked(repoRoot: string, path: string): boolean {
  return (
    spawnSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd: repoRoot }).status === 0
  );
}

function approvedContext(
  repoRoot: string,
  app: string,
  requirements: readonly string[],
  testCases: readonly string[],
): ContextPiece[] {
  const pieces: ContextPiece[] = [];
  const add = (
    path: string,
    role: ContextPiece['role'],
    label: string,
    text: string,
    pieceIds: readonly string[] = [],
  ): void => {
    pieces.push({
      path,
      role,
      section: label,
      text,
      bytes: Buffer.byteLength(text),
      blobSha: gitBlobSha(readFileSync(join(repoRoot, path))),
      ids: pieceIds,
    });
  };
  const sectionOf = (markdown: string, heading: RegExp, path: string): string => {
    try {
      return section(markdown, heading, path);
    } catch (error) {
      throw new HealerStop(error instanceof Error ? error.message : String(error));
    }
  };
  const read = (path: string): string => {
    try {
      return readFileSync(join(repoRoot, path), 'utf8');
    } catch {
      throw new HealerStop(`required context file ${path} not found`);
    }
  };
  const standard = read(STANDARD);
  for (const [heading, label] of [
    [/^## 3\. /, '## 3.'],
    [/^## 10\. /, '## 10.'],
    [/^## 11\. /, '## 11.'],
    [/^## 12\. /, '## 12.'],
    [/^## 13\. /, '## 13.'],
  ] as const) {
    add(STANDARD, 'architecture', label, sectionOf(standard, heading, STANDARD));
  }
  const requirementsPath = `specs/${app}/requirements.md`;
  const planPath = `specs/${app}/test-plan.md`;
  const requirementsText = read(requirementsPath);
  for (const req of requirements) {
    add(
      requirementsPath,
      'requirements',
      `## ${req}`,
      sectionOf(requirementsText, new RegExp(`^## ${req} — `), requirementsPath),
      [req],
    );
  }
  add(
    requirementsPath,
    'requirements',
    '# API',
    sectionOf(requirementsText, /^# API$/, requirementsPath),
  );
  const plan = read(planPath);
  add(planPath, 'test-plan', '## 1.', sectionOf(plan, /^## 1\. /, planPath));
  const owners = [...new Set(testCases.map((tc) => `REQ-${tc.slice(3, 6)}`))].sort();
  for (const req of owners) {
    add(
      planPath,
      'test-plan',
      `### ${req}`,
      sectionOf(plan, new RegExp(`^### ${req} — `), planPath),
      testCases.filter((tc) => tc.startsWith(`TC-${req.slice(4)}-`)),
    );
  }
  for (const piece of pieces) {
    const found = screenUntrustedText(piece.text);
    if (found.length > 0)
      throw new HealerStop(
        `${piece.path} § ${piece.section} contains ${found.join(' and ')}; nothing was sent to a model`,
      );
  }
  return pieces;
}
