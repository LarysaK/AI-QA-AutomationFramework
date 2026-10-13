import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadApprovedIds } from '../validation/approved-ids';
import { createSchemaGuard } from '../validation/schema-guard';
import { checkTrace, type TraceArtifact } from '../validation/trace-guard';
import { ENVELOPE_SCHEMA_PATH } from '../validation/validate';
import { buildContext, type ContextPack } from './context';
import {
  assembleEnvelope,
  checkOutput,
  DEFINITION_DIR,
  definitionVersion,
  type GeneratorOutput,
  loadOutputSchema,
  OutputRejected,
} from './envelope';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  EFFORT_MODELS,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from './model-client';
import { GeneratorStop, selectTestCase, type SelectedTestCase } from './select';
import { findSecrets, isSafeRelativePath, stage, type StagedFile } from './stage';

/**
 * Generator Agent v1 pipeline: select → context → one model call → check → envelope → stage →
 * validate. Only the model call involves AI. The Generator never writes outside its task
 * directory, never applies a proposal and never supplies H7 execution authorization.
 */

export interface GenerateOptions {
  readonly repoRoot: string;
  readonly app: string;
  readonly testCase: string;
  readonly instruction?: string;
  readonly allowReferenced: boolean;
  readonly model?: string;
  /** Where task directories are created; default `<repoRoot>/artifacts/proposals`. */
  readonly proposalsRoot?: string;
  /**
   * Offline mode: the model client returns a recorded output and no LLM is called. Provenance
   * then records no requested model or effort, plus the recorded file and its SHA-256.
   */
  readonly offline?: { readonly source: string; readonly sha256: string };
}

export const OFFLINE_NOTICE = 'OFFLINE — no LLM was called';
const OFFLINE_MODEL = 'offline-recorded-output';

export interface ValidatorResult {
  readonly exitCode: number | null;
  readonly output: string;
}

/** Runs `agents:validate` on a staged artifact, without execution authorization. */
export type ValidatorRunner = (
  artifactPath: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
) => ValidatorResult;

export interface GenerateDependencies {
  readonly modelClient: ModelClient;
  readonly runValidator?: ValidatorRunner;
  readonly now?: () => Date;
  /** The Generator's own environment (model override, secret scan). */
  readonly env?: NodeJS.ProcessEnv;
}

export type GenerateExitCode = 0 | 1 | 2 | 4 | 5;

export interface GenerateResult {
  readonly exitCode: GenerateExitCode;
  readonly lines: readonly string[];
  readonly taskId?: string;
  readonly taskDir?: string;
  readonly artifactSha256?: string;
}

export const MAX_INSTRUCTION_LENGTH = 1000;
const VALIDATOR_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The only variables the validator child receives: what Node, npm and the guards need to start.
 * Provider credentials (ANTHROPIC_*) and everything else are dropped. G-STATIC inherits this
 * already-filtered environment; G-DISCOVERY and G-RUN apply their own allowlists on top.
 */
const VALIDATOR_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
];

export function validatorEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: '0' };
  for (const name of VALIDATOR_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** The real validator CLI in a child process. No `--authorize-execution` is ever passed. */
export const runValidatorCli: ValidatorRunner = (artifactPath, repoRoot, env) => {
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [tsx, 'agents/orchestrator/validation/cli.ts', artifactPath],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: VALIDATOR_TIMEOUT_MS,
    },
  );
  return { exitCode: result.status, output: `${result.stdout}${result.stderr}` };
};

export async function generate(
  options: GenerateOptions,
  deps: GenerateDependencies,
): Promise<GenerateResult> {
  const result = await runGenerator(options, deps);
  return options.offline === undefined
    ? result
    : { ...result, lines: [...result.lines, OFFLINE_NOTICE] };
}

async function runGenerator(
  options: GenerateOptions,
  deps: GenerateDependencies,
): Promise<GenerateResult> {
  const env = deps.env ?? process.env;
  const repoRoot = resolve(options.repoRoot);
  const stop = (message: string): GenerateResult => ({
    exitCode: 2,
    lines: [`Generator stopped: ${message}`],
  });

  if (options.instruction !== undefined && options.instruction.length > MAX_INSTRUCTION_LENGTH) {
    return stop(`--instruction is longer than ${String(MAX_INSTRUCTION_LENGTH)} characters`);
  }

  // 1–2. Deterministic selection and context; no model call if anything is wrong.
  let selected: SelectedTestCase;
  let context: ContextPack;
  try {
    selected = selectTestCase(repoRoot, options.app, options.testCase, options.allowReferenced);
    context = buildContext(repoRoot, selected);
  } catch (error) {
    if (error instanceof GeneratorStop) return stop(error.message);
    throw error;
  }

  // 3. One model call.
  // Offline: no provider request exists, so no requested model, effort or token budget.
  const offline = options.offline;
  const model =
    offline === undefined
      ? (options.model ?? env['AGENTS_GENERATOR_MODEL'] ?? DEFAULT_MODEL)
      : null;
  const effort = model !== null && EFFORT_MODELS.includes(model) ? ('medium' as const) : undefined;
  const version = definitionVersion(repoRoot);
  const taskId = `gen-${selected.testCase.toLowerCase()}-${timestamp((deps.now ?? (() => new Date()))())}`;
  const request: ModelRequest = {
    model: model ?? OFFLINE_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    ...(effort === undefined ? {} : { effort }),
    system: readFileSync(join(repoRoot, DEFINITION_DIR, 'prompt.md'), 'utf8'),
    context: renderContext(context),
    task: renderTask(selected, context, options.instruction),
    schema: loadOutputSchema(repoRoot),
  };
  const requestRecord = json({
    taskId,
    definitionVersion: version,
    offline: offline !== undefined,
    recordedOutput: offline === undefined ? null : { path: offline.source, sha256: offline.sha256 },
    model,
    effort: effort ?? null,
    maxTokens: offline === undefined ? request.maxTokens : null,
    application: selected.app,
    testCase: selected.testCase,
    requirement: selected.requirement,
    level: selected.level,
    instruction: options.instruction ?? null,
    allowReferencedTestCase: options.allowReferenced,
    staticReferences: selected.references,
    canonicals: context.canonicals,
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
  ): GenerateResult => {
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
        lines: [`Model output rejected: ${reasons.join('; ')}`, `Recorded in ${taskDir}`],
      };
    } catch (error) {
      if (error instanceof GeneratorStop)
        return { exitCode: 4, lines: [`Model output rejected and not recorded: ${error.message}`] };
      throw error;
    }
  };

  let response: ModelResponse;
  try {
    response = await deps.modelClient.generate(request);
  } catch (error) {
    // Typed SDK errors (authentication, rate limit, server) end the run; there is no retry.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return rejected([`the model call failed: ${message}`], { error: message });
  }

  // 4. Check the output; never repair it.
  let output: GeneratorOutput;
  try {
    output = checkOutput(response, request.schema);
  } catch (error) {
    if (error instanceof OutputRejected) return rejected(error.reasons, response);
    throw error;
  }

  // 5. Envelope, checked against the real envelope schema before staging.
  const envelope = assembleEnvelope(selected, context, output, {
    taskId,
    definitionVersion: version,
    modelCall: offline === undefined ? 'anthropic-api' : 'offline-recorded-output',
    requestedModel: model,
    servedModel: response.servedModel,
    effort: effort ?? null,
    maxTokens: offline === undefined ? request.maxTokens : null,
    allowReferencedTestCase: options.allowReferenced,
  });
  const schemaGuard = createSchemaGuard(join(repoRoot, ENVELOPE_SCHEMA_PATH));
  const schemaResult = schemaGuard(envelope);
  if (schemaResult.status !== 'passed') {
    return rejected(
      schemaResult.failures.map((failure) => `envelope ${failure.reason}`),
      response,
    );
  }

  // 6. Stage.
  const artifact = json(envelope);
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
  const files: StagedFile[] = [
    { path: 'artifact.json', content: artifact },
    { path: 'request.json', content: requestRecord },
    { path: 'response.json', content: json(response) },
  ];
  const testFile = output.testFile;
  const previewNote: string[] = [];
  if (testFile !== null) {
    if (isSafeRelativePath(testFile.path)) {
      files.push({ path: `preview/${testFile.path}.proposed`, content: testFile.content });
    } else {
      previewNote.push(
        `No preview written: the proposed path "${testFile.path}" is not a safe relative path.`,
      );
    }
  }
  let taskDir: string;
  try {
    taskDir = stage(proposalsRoot, taskId, files, env);
  } catch (error) {
    if (error instanceof GeneratorStop)
      return { exitCode: 4, lines: [`Nothing staged: ${error.message}`] };
    throw error;
  }
  const artifactPath = join(taskDir, 'artifact.json');

  // 7. Validate.
  if (output.status === 'READY') {
    const validator = (deps.runValidator ?? runValidatorCli)(
      artifactPath,
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
        validatorExitCode: validator.exitCode,
      },
      env,
    );
    const lines = [
      `Staged ${taskId} (READY) in ${taskDir}`,
      ...previewNote,
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
        'Next steps (human): review artifact.json and the preview. To run the execution-capable guards,',
        'authorize this exact artifact yourself with the validator command shown above.',
        'The Generator never authorizes execution and never applies the proposal.',
      ],
    };
  }

  // Non-READY: nothing to execute. G-SCHEMA and G-TRACE in process only.
  const trace = checkTrace(
    envelope as unknown as TraceArtifact,
    loadApprovedIds(repoRoot),
    repoRoot,
  );
  const inProcess = [schemaResult, trace];
  const report = inProcess
    .map((result) =>
      [
        `${result.guard.padEnd(12)} ${result.status}`,
        ...result.failures.map((f) => `  [${f.ruleIds.join(', ')}] ${f.reason}`),
      ].join('\n'),
    )
    .join('\n');
  const failed = trace.status !== 'passed';
  writeRecords(
    taskDir,
    `${report}\n`,
    {
      pipelineStatus: failed ? 'VALIDATION_FAILED' : 'STAGED',
      agentStatus: output.status,
      artifactSha256,
      validatorExitCode: null,
    },
    env,
  );
  return {
    exitCode: failed ? 1 : 5,
    taskId,
    taskDir,
    artifactSha256,
    lines: [
      `Staged ${taskId} (${output.status}) in ${taskDir}`,
      report,
      `Summary: ${output.summary}`,
      ...output.findings.map(
        (finding) => `Finding (${finding.severity}, ${finding.kind}): ${finding.message}`,
      ),
      ...output.contextRequests.map((requestText) => `Context request: ${requestText}`),
      'Nothing to execute. Resolve the findings or context requests, then run the Generator again.',
    ],
  };
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

function renderContext(context: ContextPack): string {
  const blocks = context.pieces.map(
    (piece) => `=== ${piece.path} § ${piece.section} [${piece.role}] ===\n${piece.text}`,
  );
  return `<approved-context>\n${blocks.join('\n\n')}\n</approved-context>`;
}

function renderTask(
  selected: SelectedTestCase,
  context: ContextPack,
  instruction: string | undefined,
): string {
  const folder = selected.level.toLowerCase();
  return [
    '<task>',
    `Propose one new Playwright test for test case ${selected.testCase} of application "${selected.app}".`,
    `Requirement: ${selected.requirement}. Level: ${selected.level}.`,
    `Test plan row (verbatim): ${selected.row}`,
    `Closest canonical patterns: ${context.canonicals.join(', ')}.`,
    `Path: tests/${selected.app}/${folder}/<kebab-case-name>.spec.ts (a new file).`,
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
