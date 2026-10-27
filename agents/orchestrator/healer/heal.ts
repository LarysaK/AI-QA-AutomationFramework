import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { OutputRejected, parseModelOutput } from '../generator/envelope';
import { runValidatorCli, type ValidatorRunner, validatorEnvironment } from '../generator/generate';
import {
  DEFAULT_MAX_TOKENS,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../generator/model-client';
import { GeneratorStop } from '../generator/select';
import { findSecrets, stage, type StagedFile } from '../generator/stage';
import { loadApprovedIds } from '../validation/approved-ids';
import { checkBase, gitBlobSha } from '../validation/base-guard';
import type { FailureClassification } from '../validation/healer-guard';
import { checkPaths } from '../validation/path-guard';
import { createSchemaGuard } from '../validation/schema-guard';
import { checkTrace, type TraceArtifact } from '../validation/trace-guard';
import type { Artifact, GuardResult } from '../validation/types';
import { ENVELOPE_SCHEMA_PATH, payloadSchemas } from '../validation/validate';
import {
  evidenceDigest,
  type FailureEvidence,
  HealerStop,
  loadFailureEvidence,
  parseSelector,
} from './evidence';

/**
 * Healer Agent v1 pipeline: evidence → screen → context → one model call → check → envelope →
 * guards → stage → (repair only) validator without execution authorization. Only the model call
 * involves AI. The Healer never writes outside its task directory, never applies a repair, never
 * runs proposed code, and never requests or supplies H7: a repair's execution-capable guards wait
 * for a human, and applying it needs gate H3.
 */

export const DEFINITION_DIR = 'agents/definitions/healer';
export const OUTPUT_SCHEMA_PATH = `${DEFINITION_DIR}/healer-output.schema.json`;
export const OFFLINE_NOTICE = 'OFFLINE — no LLM was called';
const OFFLINE_MODEL = 'offline-recorded-output';

export interface HealOptions {
  readonly repoRoot: string;
  readonly app: string;
  /** The Playwright JSON report: the only accepted failure evidence. */
  readonly report: string;
  /** `tests/<path>.spec.ts:<line>`, as the report locates the failing test. */
  readonly test: string;
  /** Where task directories are created; default `<repoRoot>/artifacts/proposals`. */
  readonly proposalsRoot?: string;
  /** Healer v1 is offline-only: the recorded model output's source and SHA-256. */
  readonly offline: { readonly source: string; readonly sha256: string };
}

export interface HealDependencies {
  readonly modelClient: ModelClient;
  readonly runValidator?: ValidatorRunner;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

export type HealExitCode = 0 | 1 | 2 | 4 | 5;

export interface HealResult {
  readonly exitCode: HealExitCode;
  readonly lines: readonly string[];
  readonly taskId?: string;
  readonly taskDir?: string;
  readonly artifactSha256?: string;
}

export interface HealerOutput {
  readonly status: 'READY' | 'BLOCKED' | 'NEEDS_HUMAN_DECISION';
  readonly summary: string;
  readonly diagnosis: {
    readonly classification: FailureClassification;
    readonly explanation: string;
    readonly evidenceRefs: readonly string[];
    readonly confidence: 'low' | 'medium' | 'high';
    readonly alternatives: readonly {
      readonly classification: FailureClassification;
      readonly explanation: string;
      readonly evidenceRefs: readonly string[];
    }[];
    readonly missingEvidence: readonly string[];
    readonly recommendedInvestigation: readonly string[];
  };
  readonly repair: {
    readonly changes: readonly {
      readonly path: string;
      readonly content: string;
      readonly rationale: string;
    }[];
    readonly impact: string;
    readonly expectedBehaviorPreserved: string;
    readonly risks: readonly string[];
    readonly validationSteps: readonly string[];
  } | null;
  readonly assumptions: readonly { readonly statement: string; readonly impact: string }[];
  readonly findings: readonly {
    readonly kind: string;
    readonly severity: string;
    readonly message: string;
  }[];
  readonly contextRequests: readonly string[];
}

export function definitionVersion(repoRoot: string): string {
  const text = readFileSync(join(repoRoot, DEFINITION_DIR, 'definition.md'), 'utf8');
  const version = /^definitionVersion:\s*(\d+\.\d+)\s*$/m.exec(text)?.[1];
  if (version === undefined)
    throw new HealerStop(`${DEFINITION_DIR}/definition.md declares no definitionVersion`);
  return version;
}

export async function heal(options: HealOptions, deps: HealDependencies): Promise<HealResult> {
  const result = await runHealer(options, deps);
  return { ...result, lines: [...result.lines, OFFLINE_NOTICE] };
}

async function runHealer(options: HealOptions, deps: HealDependencies): Promise<HealResult> {
  const env = deps.env ?? process.env;
  const repoRoot = resolve(options.repoRoot);
  const stop = (message: string): HealResult => ({
    exitCode: 2,
    lines: [`Healer stopped: ${message}`],
  });

  // 1–6. Authentic, sanitized, screened and bounded evidence; no model call on any problem.
  let evidence: FailureEvidence;
  let version: string;
  try {
    evidence = loadFailureEvidence(
      repoRoot,
      options.app,
      resolve(options.report),
      parseSelector(options.test),
      env,
    );
    version = definitionVersion(repoRoot);
  } catch (error) {
    if (error instanceof HealerStop) return stop(error.message);
    throw error;
  }

  const slug = evidence.failure.testFile
    .replace(/^tests\//, '')
    .replace(/\.(spec|test)\.ts$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase();
  const taskId =
    `heal-${slug}-l${String(evidence.failure.line)}-${timestamp((deps.now ?? (() => new Date()))())}`.slice(
      0,
      128,
    );
  const request: ModelRequest = {
    model: OFFLINE_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    system: readFileSync(join(repoRoot, DEFINITION_DIR, 'prompt.md'), 'utf8'),
    context: renderContext(evidence),
    task: renderTask(evidence),
    schema: JSON.parse(readFileSync(join(repoRoot, OUTPUT_SCHEMA_PATH), 'utf8')) as Record<
      string,
      unknown
    >,
  };
  const requestRecord = json({
    taskId,
    definitionVersion: version,
    offline: true,
    recordedOutput: { path: options.offline.source, sha256: options.offline.sha256 },
    model: null,
    effort: null,
    maxTokens: null,
    application: evidence.app,
    report: evidence.report,
    failure: evidence.failure,
    traceability: { requirements: evidence.requirements, testCases: evidence.testCases },
    evidence: evidence.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      source: item.source,
      sha256: evidenceDigest(item),
    })),
    context: {
      totalBytes: evidence.totalBytes,
      pieces: evidence.pieces.map(({ path, role, section, bytes, blobSha }) => ({
        path,
        role,
        section,
        bytes,
        blobSha,
      })),
    },
    task: request.task,
  });

  const proposalsRoot = options.proposalsRoot ?? join(repoRoot, 'artifacts', 'proposals');
  const rejected = (
    reasons: readonly string[],
    response?: ModelResponse | { error: string },
  ): HealResult => {
    const files: StagedFile[] = [
      { path: 'request.json', content: requestRecord },
      { path: 'response.json', content: json(response ?? null) },
      { path: 'rejection.json', content: json({ reasons }) },
    ];
    try {
      const taskDir = stage(proposalsRoot, taskId, files, env);
      return {
        exitCode: 4,
        taskId,
        taskDir,
        lines: [
          'Heal proposal rejected; nothing was staged for review:',
          ...reasons.map((r) => `  ${r}`),
          `Recorded in ${taskDir}`,
        ],
      };
    } catch (error) {
      if (error instanceof GeneratorStop)
        return {
          exitCode: 4,
          lines: [`Heal proposal rejected and not recorded: ${error.message}`],
        };
      throw error;
    }
  };

  // 7. One model call.
  let response: ModelResponse;
  try {
    response = await deps.modelClient.generate(request);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return rejected([`the model call failed: ${message}`], { error: message });
  }

  // 8. Check the output; never repair it.
  let output: HealerOutput;
  try {
    output = parseModelOutput(response, request.schema) as HealerOutput;
  } catch (error) {
    if (error instanceof OutputRejected) return rejected(error.reasons, response);
    throw error;
  }

  // 9. Envelope, then the deterministic guards that need no execution.
  const envelope = assembleHealEnvelope(repoRoot, evidence, output, {
    taskId,
    definitionVersion: version,
    servedModel: response.servedModel,
  });
  const results = runHealGuards(envelope, repoRoot);
  const failures = results.flatMap((r) => r.failures);
  if (failures.length > 0) {
    return rejected(
      failures.map(
        (f) =>
          `${f.guard} [${f.ruleIds.join(', ')}]${f.path === undefined ? '' : ` ${f.path}:`} ${f.reason}`,
      ),
      response,
    );
  }

  // 10. Stage. A diagnosis is a report; a repair waits for H7 (execution guards) and H3 (approval).
  const artifact = json(envelope);
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
  const files: StagedFile[] = [
    { path: 'artifact.json', content: artifact },
    { path: 'request.json', content: requestRecord },
    { path: 'response.json', content: json(response) },
  ];
  let taskDir: string;
  try {
    taskDir = stage(proposalsRoot, taskId, files, env);
  } catch (error) {
    if (error instanceof GeneratorStop)
      return { exitCode: 4, lines: [`Nothing staged: ${error.message}`] };
    throw error;
  }
  const { diagnosis } = output;
  const header = [
    `Staged ${taskId} (${output.status}) in ${taskDir}`,
    `Diagnosis: ${diagnosis.classification} (confidence ${diagnosis.confidence}): ${diagnosis.explanation}`,
    `Evidence cited: ${diagnosis.evidenceRefs.join(', ')}`,
    ...diagnosis.alternatives.map((a) => `Alternative: ${a.classification}: ${a.explanation}`),
    ...diagnosis.missingEvidence.map((m) => `Missing evidence: ${m}`),
    ...diagnosis.recommendedInvestigation.map((m) => `Investigate: ${m}`),
    ...output.findings.map((f) => `Finding (${f.severity}, ${f.kind}): ${f.message}`),
    ...output.contextRequests.map((c) => `Context request: ${c}`),
  ];

  if (output.repair === null) {
    const report = results.map((r) => `${r.guard.padEnd(12)} ${r.status}`).join('\n');
    writeRecords(
      taskDir,
      `${report}\nNo repair proposed: nothing to execute.\n`,
      {
        pipelineStatus: 'STAGED',
        agentStatus: output.status,
        artifactSha256,
        classification: diagnosis.classification,
        repairProposed: false,
      },
      env,
    );
    return {
      exitCode: output.status === 'READY' ? 0 : 5,
      taskId,
      taskDir,
      artifactSha256,
      lines: [
        ...header,
        report,
        diagnosis.classification === 'application-defect'
          ? 'Diagnosis only: escalate the defect candidate to human triage. No defect record or ticket was created, and no workaround is proposed.'
          : 'Diagnosis only: no repair proposed. Nothing was applied or executed.',
      ],
    };
  }

  const validator = (deps.runValidator ?? runValidatorCli)(
    join(taskDir, 'artifact.json'),
    repoRoot,
    validatorEnvironment(env),
  );
  const pipelineStatus =
    validator.exitCode === 3
      ? 'EXECUTION_AUTHORIZATION_REQUIRED'
      : validator.exitCode === 0
        ? 'VALIDATED'
        : 'VALIDATION_FAILED';
  writeRecords(
    taskDir,
    validator.output,
    {
      pipelineStatus,
      agentStatus: output.status,
      artifactSha256,
      classification: diagnosis.classification,
      repairProposed: true,
      reviewGate: 'H3',
      humanReview: 'required',
      validatorExitCode: validator.exitCode,
    },
    env,
  );
  const lines = [
    ...header,
    ...output.repair.changes.map((c) => `Proposed repair (not applied) ${c.path}: ${c.rationale}`),
    ...validator.output.trimEnd().split('\n'),
    `Pipeline status: ${pipelineStatus}`,
  ];
  if (pipelineStatus !== 'EXECUTION_AUTHORIZATION_REQUIRED')
    return { exitCode: 1, taskId, taskDir, artifactSha256, lines };
  return {
    exitCode: 0,
    taskId,
    taskDir,
    artifactSha256,
    lines: [
      ...lines,
      'The repair is not applied and not executed. Its execution-capable guards need a human H7 authorization of this exact',
      'artifact; applying it needs human approval at gate H3, as an ordinary reviewed commit. The Healer does neither.',
    ],
  };
}

/** G-SCHEMA (envelope and Healer payload), G-PATHS, G-BASE and G-TRACE (with the HEA rules). */
export function runHealGuards(envelope: unknown, repoRoot: string): GuardResult[] {
  const schema = createSchemaGuard(
    join(repoRoot, ENVELOPE_SCHEMA_PATH),
    payloadSchemas(repoRoot),
  )(envelope);
  if (schema.status !== 'passed') return [schema];
  const paths = checkPaths(envelope as Artifact, repoRoot);
  const base = checkBase(envelope as Artifact, repoRoot);
  const trace = checkTrace(envelope as TraceArtifact, loadApprovedIds(repoRoot), repoRoot);
  return [schema, paths, base, trace];
}

/** The orchestrator-owned envelope around the model-owned content (Healer definition: Output). */
export function assembleHealEnvelope(
  repoRoot: string,
  evidence: FailureEvidence,
  output: HealerOutput,
  meta: {
    readonly taskId: string;
    readonly definitionVersion: string;
    readonly servedModel: string;
  },
): Record<string, unknown> {
  const number = (n: number): string => String(n + 1).padStart(3, '0');
  const traceability = {
    requirements: [...evidence.requirements],
    testCases: [...evidence.testCases],
  };
  const reqPieces = evidence.pieces.filter((p) => p.role === 'requirements');
  const planPieces = evidence.pieces.filter((p) => p.role === 'test-plan');
  const ids = (pieces: typeof reqPieces): string[] => [...new Set(pieces.flatMap((p) => p.ids))];
  const ref = (path: string, role: string, list: string[]): Record<string, unknown> =>
    list.length > 0 ? { path, role, ids: list } : { path, role };
  const sourceReferences = [
    ref('agents/standard/standard.md', 'architecture', []),
    ...(reqPieces[0] === undefined ? [] : [ref(reqPieces[0].path, 'requirements', ids(reqPieces))]),
    ...(planPieces[0] === undefined ? [] : [ref(planPieces[0].path, 'test-plan', ids(planPieces))]),
    ref(evidence.failure.testFile, evidence.testRole, [
      ...evidence.requirements,
      ...evidence.testCases,
    ]),
    ...evidence.supportFiles.map((path) => ref(path, 'support', [])),
  ];
  const changes = (output.repair?.changes ?? []).map((change) => {
    const full = join(repoRoot, change.path);
    const exists = isSafe(change.path) && existsSync(full);
    const changeKind = change.path.startsWith('tests/') ? 'test-change' : 'support-change';
    return {
      path: change.path,
      changeKind,
      operation: exists ? 'modify' : 'create',
      ...(exists ? { baseSha: gitBlobSha(readFileSync(full)) } : {}),
      content: change.content,
      rationale: change.rationale,
      traceability,
      ...(changeKind === 'support-change' && output.repair !== null
        ? { impact: output.repair.impact }
        : {}),
    };
  });
  return {
    artifactType: 'heal-proposal',
    schemaVersion: '1.0',
    standardVersion: '1.2',
    agent: { name: 'healer', definitionVersion: meta.definitionVersion },
    taskId: meta.taskId,
    status: output.status,
    summary: output.summary,
    sourceReferences,
    traceability,
    assumptions: output.assumptions.map((a, i) => ({
      id: `A-${number(i)}`,
      statement: a.statement,
      impact: a.impact,
    })),
    findings: output.findings.map((f, i) => ({
      id: `F-${number(i)}`,
      kind: f.kind,
      severity: f.severity,
      message: f.message,
    })),
    ...(output.contextRequests.length > 0 ? { contextRequests: [...output.contextRequests] } : {}),
    proposedChanges: changes,
    payload: {
      modelCall: 'offline-recorded-output',
      requestedModel: null,
      servedModel: meta.servedModel,
      effort: null,
      maxTokens: null,
      definitionVersion: meta.definitionVersion,
      failure: {
        reportName: evidence.report.name,
        reportSha256: evidence.report.sha256,
        playwrightVersion: evidence.report.playwrightVersion,
        specId: evidence.failure.specId,
        testFile: evidence.failure.testFile,
        title: evidence.failure.title,
        line: evidence.failure.line,
        project: evidence.failure.project,
        attempts: [...evidence.failure.attempts],
        startedAt: evidence.report.startedAt,
      },
      evidence: evidence.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        source: item.source,
        sha256: evidenceDigest(item),
      })),
      diagnosis: { ...output.diagnosis },
      repair:
        output.repair === null
          ? null
          : {
              expectedBehaviorPreserved: output.repair.expectedBehaviorPreserved,
              risks: [...output.repair.risks],
              validationSteps: [...output.repair.validationSteps],
              humanReview: 'required',
              reviewGate: 'H3',
            },
    },
  };
}

/** Only plain relative paths are looked up on disk; anything else is left for G-PATHS to reject. */
function isSafe(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((s) => s === '' || s === '.' || s === '..')
  );
}

function renderContext(evidence: FailureEvidence): string {
  const approved = evidence.pieces.map(
    (p) => `=== ${p.path} § ${p.section} [${p.role}] ===\n${p.text}`,
  );
  const items = evidence.items.map((i) => `=== ${i.id} [${i.kind}] ${i.source} ===\n${i.text}`);
  return `<approved-context>\n${approved.join('\n\n')}\n</approved-context>\n<failure-evidence>\n${items.join('\n\n')}\n</failure-evidence>`;
}

function renderTask(evidence: FailureEvidence): string {
  const f = evidence.failure;
  return [
    '<task>',
    `Diagnose the failure of "${f.title}" (${f.testFile}:${String(f.line)}, project ${f.project}; attempts: ${f.attempts.join(', ')}).`,
    `Traceability: ${[...evidence.requirements, ...evidence.testCases].join(', ') || '(no approved IDs tagged)'}.`,
    `The test file is ${evidence.testRole === 'canonical-test' ? 'a canonical test: it must not be modified' : 'not canonical'}.`,
    `Files a repair may modify: ${[...(evidence.testRole === 'test' ? [f.testFile] : []), ...evidence.supportFiles].join(', ') || '(none)'}.`,
    `Evidence IDs: ${evidence.items.map((i) => i.id).join(', ')}.`,
    '</task>',
  ].join('\n');
}

function writeRecords(
  taskDir: string,
  validation: string,
  status: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): void {
  const files = [
    { path: 'validation-1.txt', content: validation },
    { path: 'status.json', content: json(status) },
  ];
  const secrets = findSecrets(files, env);
  for (const file of files) {
    writeFileSync(
      join(taskDir, file.path),
      secrets.length > 0
        ? `withheld: possible secrets found (${secrets.join('; ')})\n`
        : file.content,
    );
  }
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
