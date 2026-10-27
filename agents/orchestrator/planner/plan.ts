import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { OutputRejected, parseModelOutput } from '../generator/envelope';
import {
  DEFAULT_MAX_TOKENS,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../generator/model-client';
import { GeneratorStop } from '../generator/select';
import { stage, type StagedFile } from '../generator/stage';
import { loadApprovedIds } from '../validation/approved-ids';
import { checkBase } from '../validation/base-guard';
import { checkPaths } from '../validation/path-guard';
import type { PlanProposedTestCase } from '../validation/planner-guard';
import { createSchemaGuard } from '../validation/schema-guard';
import { checkTrace, type TraceArtifact } from '../validation/trace-guard';
import type { Artifact, GuardResult } from '../validation/types';
import { ENVELOPE_SCHEMA_PATH, payloadSchemas } from '../validation/validate';
import { buildPlannerContext, type PlannerContext, PlannerStop } from './context';

/**
 * Planner Agent v1 pipeline: select → screen → context → one model call → check → envelope →
 * guards → stage. Only the model call involves AI. The Planner never writes outside its task
 * directory, never writes the test plan or the requirements, never approves its own proposal
 * (gate H1 is a human decision) and never requests or supplies execution authorization (H7):
 * a plan proposal contains no code, so nothing is executed.
 */

export const DEFINITION_DIR = 'agents/definitions/planner';
export const OUTPUT_SCHEMA_PATH = `${DEFINITION_DIR}/planner-output.schema.json`;
export const OFFLINE_NOTICE = 'OFFLINE — no LLM was called';
export const MAX_INSTRUCTION_LENGTH = 1000;
const OFFLINE_MODEL = 'offline-recorded-output';

export interface PlanOptions {
  readonly repoRoot: string;
  readonly app: string;
  readonly requirements: readonly string[];
  readonly instruction?: string;
  /** Where task directories are created; default `<repoRoot>/artifacts/proposals`. */
  readonly proposalsRoot?: string;
  /**
   * The recorded model output's source and SHA-256. Planner v1 is offline-only: the model client
   * returns this recorded output, and provenance records that no LLM was called.
   */
  readonly offline: { readonly source: string; readonly sha256: string };
}

export interface PlanDependencies {
  readonly modelClient: ModelClient;
  readonly now?: () => Date;
  /** The Planner's own environment (secret scan of staged files). */
  readonly env?: NodeJS.ProcessEnv;
}

export type PlanExitCode = 0 | 2 | 4 | 5;

export interface PlanResult {
  readonly exitCode: PlanExitCode;
  readonly lines: readonly string[];
  readonly taskId?: string;
  readonly taskDir?: string;
  readonly artifactSha256?: string;
}

export interface PlannerOutput {
  readonly status: 'READY' | 'BLOCKED' | 'NEEDS_HUMAN_DECISION';
  readonly summary: string;
  readonly proposedTestCases: readonly PlanProposedTestCase[];
  readonly automationCandidates: readonly {
    readonly testCaseId: string;
    readonly rationale: string;
  }[];
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
    throw new PlannerStop(`${DEFINITION_DIR}/definition.md declares no definitionVersion`);
  return version;
}

export function loadOutputSchema(repoRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, OUTPUT_SCHEMA_PATH), 'utf8')) as Record<
    string,
    unknown
  >;
}

export async function plan(options: PlanOptions, deps: PlanDependencies): Promise<PlanResult> {
  const result = await runPlanner(options, deps);
  return { ...result, lines: [...result.lines, OFFLINE_NOTICE] };
}

async function runPlanner(options: PlanOptions, deps: PlanDependencies): Promise<PlanResult> {
  const env = deps.env ?? process.env;
  const repoRoot = resolve(options.repoRoot);
  const stop = (message: string): PlanResult => ({
    exitCode: 2,
    lines: [`Planner stopped: ${message}`],
  });

  if (options.instruction !== undefined && options.instruction.length > MAX_INSTRUCTION_LENGTH) {
    return stop(`--instruction is longer than ${String(MAX_INSTRUCTION_LENGTH)} characters`);
  }

  // 1–3. Deterministic selection, untrusted-text screen and context; no model call on any problem.
  let context: PlannerContext;
  let version: string;
  try {
    context = buildPlannerContext(repoRoot, options.app, options.requirements);
    version = definitionVersion(repoRoot);
  } catch (error) {
    if (error instanceof PlannerStop) return stop(error.message);
    throw error;
  }

  const taskId = `plan-${context.requirements.map((r) => r.toLowerCase()).join('-')}-${timestamp((deps.now ?? (() => new Date()))())}`;
  const request: ModelRequest = {
    model: OFFLINE_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    system: readFileSync(join(repoRoot, DEFINITION_DIR, 'prompt.md'), 'utf8'),
    context: renderContext(context),
    task: renderTask(context, options.instruction),
    schema: loadOutputSchema(repoRoot),
  };
  const requestRecord = json({
    taskId,
    definitionVersion: version,
    offline: true,
    recordedOutput: { path: options.offline.source, sha256: options.offline.sha256 },
    model: null,
    effort: null,
    maxTokens: null,
    application: context.app,
    requirements: context.requirements,
    instruction: options.instruction ?? null,
    coverage: context.coverage,
    context: {
      totalBytes: context.totalBytes,
      pieces: context.pieces.map(({ path, role, section, bytes, blobSha }) => ({
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
  ): PlanResult => {
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
          'Plan proposal rejected; nothing was staged for review:',
          ...reasons.map((reason) => `  ${reason}`),
          `Recorded in ${taskDir}`,
        ],
      };
    } catch (error) {
      if (error instanceof GeneratorStop) {
        return {
          exitCode: 4,
          lines: [`Plan proposal rejected and not recorded: ${error.message}`],
        };
      }
      throw error;
    }
  };

  // 4. One model call.
  let response: ModelResponse;
  try {
    response = await deps.modelClient.generate(request);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return rejected([`the model call failed: ${message}`], { error: message });
  }

  // 5. Check the output; never repair it.
  let output: PlannerOutput;
  try {
    output = parseModelOutput(response, request.schema) as PlannerOutput;
  } catch (error) {
    if (error instanceof OutputRejected) return rejected(error.reasons, response);
    throw error;
  }

  // 6. Envelope, then the deterministic guards that apply to a plan proposal.
  const envelope = assemblePlanEnvelope(context, output, {
    taskId,
    definitionVersion: version,
    servedModel: response.servedModel,
  });
  const results = runPlanGuards(envelope, repoRoot);
  const failures = results.flatMap((r) => r.failures);
  if (failures.length > 0) {
    return rejected(
      failures.map((f) => `${f.guard} [${f.ruleIds.join(', ')}] ${f.reason}`),
      response,
    );
  }

  // 7. Stage for human review (H1). Nothing is approved, applied or executed.
  const artifact = json(envelope);
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
  const report = [
    ...results.map((r) => `${r.guard.padEnd(12)} ${r.status}`),
    'G-STATIC, G-DISCOVERY, G-RUN: not applicable — a plan proposal contains no files or code; nothing is executed and H7 is not requested',
  ].join('\n');
  // Orchestrator pipeline status (Agent Standard 7.2): staged; human review (H1) is pending.
  const pipelineStatus = 'STAGED';
  const files: StagedFile[] = [
    { path: 'artifact.json', content: artifact },
    { path: 'request.json', content: requestRecord },
    { path: 'response.json', content: json(response) },
    { path: 'validation-1.txt', content: `${report}\n` },
    {
      path: 'status.json',
      content: json({
        pipelineStatus,
        agentStatus: output.status,
        artifactSha256,
        reviewGate: 'H1',
        humanReview: 'pending',
      }),
    },
  ];
  let taskDir: string;
  try {
    taskDir = stage(proposalsRoot, taskId, files, env);
  } catch (error) {
    if (error instanceof GeneratorStop)
      return { exitCode: 4, lines: [`Nothing staged: ${error.message}`] };
    throw error;
  }

  const lines = [
    `Staged ${taskId} (${output.status}) in ${taskDir}`,
    report,
    `Summary: ${output.summary}`,
    ...output.proposedTestCases.map(
      (p) =>
        `Proposed (provisional, not approved) ${p.provisionalId} [${p.requirementId}] ${p.level} ${p.type} ${p.priority}: ${p.scenario}`,
    ),
    ...output.automationCandidates.map(
      (c) => `Automation candidate (existing approved test case) ${c.testCaseId}: ${c.rationale}`,
    ),
    ...output.findings.map((f) => `Finding (${f.severity}, ${f.kind}): ${f.message}`),
    ...output.contextRequests.map((c) => `Context request: ${c}`),
  ];
  if (output.status !== 'READY') {
    return {
      exitCode: 5,
      taskId,
      taskDir,
      artifactSha256,
      lines: [
        ...lines,
        'Nothing to review as a plan yet. Resolve the findings or context requests, then run the Planner again.',
      ],
    };
  }
  return {
    exitCode: 0,
    taskId,
    taskDir,
    artifactSha256,
    lines: [
      ...lines,
      `Pipeline status: ${pipelineStatus} — awaiting human review at gate H1.`,
      'Nothing was approved, applied or executed. An accepted proposal is transcribed into the test plan by a human, in a reviewed commit, with approved TC IDs.',
    ],
  };
}

/** G-SCHEMA (envelope and Planner payload), G-PATHS, G-BASE and G-TRACE (with the PLN rules). */
export function runPlanGuards(envelope: unknown, repoRoot: string): GuardResult[] {
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

export interface PlanEnvelopeMeta {
  readonly taskId: string;
  readonly definitionVersion: string;
  readonly servedModel: string;
}

/** The orchestrator-owned envelope around the model-owned content (Planner definition: Output). */
export function assemblePlanEnvelope(
  context: PlannerContext,
  output: PlannerOutput,
  meta: PlanEnvelopeMeta,
): Record<string, unknown> {
  const number = (n: number): string => String(n + 1).padStart(3, '0');
  const cited = [
    ...output.proposedTestCases.flatMap((p) => p.relatedTestCases),
    ...output.automationCandidates.map((c) => c.testCaseId),
  ];
  return {
    artifactType: 'test-plan-proposal',
    schemaVersion: '1.0',
    standardVersion: '1.2',
    agent: { name: 'planner', definitionVersion: meta.definitionVersion },
    taskId: meta.taskId,
    status: output.status,
    summary: output.summary,
    sourceReferences: sourceReferences(context),
    traceability: {
      requirements: [...context.requirements],
      testCases: [...new Set(cited)].sort(),
    },
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
    proposedChanges: [],
    payload: {
      modelCall: 'offline-recorded-output',
      requestedModel: null,
      servedModel: meta.servedModel,
      effort: null,
      maxTokens: null,
      definitionVersion: meta.definitionVersion,
      requestedRequirements: [...context.requirements],
      reviewGate: 'H1',
      proposedTestCases: output.proposedTestCases.map((p) => ({ ...p })),
      automationCandidates: output.automationCandidates.map((c) => ({ ...c })),
    },
  };
}

/** One reference per context file, with the approved IDs it contributed. */
function sourceReferences(
  context: PlannerContext,
): { path: string; role: string; ids?: string[] }[] {
  const byPath = new Map<string, { role: string; ids: Set<string> }>();
  for (const piece of context.pieces) {
    const entry = byPath.get(piece.path) ?? { role: piece.role, ids: new Set<string>() };
    for (const id of piece.ids) entry.ids.add(id);
    byPath.set(piece.path, entry);
  }
  return [...byPath].map(([path, { role, ids }]) =>
    ids.size > 0 ? { path, role, ids: [...ids] } : { path, role },
  );
}

function renderContext(context: PlannerContext): string {
  const blocks = context.pieces.map(
    (piece) => `=== ${piece.path} § ${piece.section} [${piece.role}] ===\n${piece.text}`,
  );
  return `<approved-context>\n${blocks.join('\n\n')}\n</approved-context>`;
}

function renderTask(context: PlannerContext, instruction: string | undefined): string {
  const coverage = context.requirements.flatMap((req) => [
    `- ${req}:`,
    ...(context.coverage[req] ?? []).map(
      (entry) =>
        `  - ${entry.testCase} (Automation: ${entry.automation}; referenced by committed tests: ${entry.referencedBy.length > 0 ? entry.referencedBy.join(', ') : 'none'})`,
    ),
  ]);
  return [
    '<task>',
    `Plan additional test cases for these approved requirements of application "${context.app}": ${context.requirements.join(', ')}.`,
    'Approved test cases (fixed: reference them by ID, never restate or renumber them). A reference by a committed test is a static fact, not proof of coverage:',
    ...coverage,
    'Provisional IDs: PTC-<requirement number>-<NN>, counting from 01 per requirement.',
    `Optional human instruction (non-authoritative): ${instruction === undefined ? '(none)' : JSON.stringify(instruction)}`,
    '</task>',
  ].join('\n');
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
