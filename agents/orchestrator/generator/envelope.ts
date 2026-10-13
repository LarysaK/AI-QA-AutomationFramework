import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';

import type { ContextPack } from './context';
import type { ModelResponse } from './model-client';
import type { SelectedTestCase } from './select';

/**
 * Checks the model's output and assembles the Agent Standard envelope. Nothing is repaired:
 * output that does not meet the contract is rejected with the reasons.
 */

export const DEFINITION_DIR = 'agents/definitions/generator';
export const OUTPUT_SCHEMA_PATH = `${DEFINITION_DIR}/generator-output.schema.json`;

export interface GeneratorOutput {
  readonly status: 'READY' | 'BLOCKED' | 'NEEDS_HUMAN_DECISION';
  readonly summary: string;
  readonly testFile: {
    readonly path: string;
    readonly content: string;
    readonly rationale: string;
  } | null;
  readonly canonicalPatterns: readonly string[];
  readonly assumptions: readonly { readonly statement: string; readonly impact: string }[];
  readonly findings: readonly {
    readonly kind: string;
    readonly severity: string;
    readonly message: string;
  }[];
  readonly contextRequests: readonly string[];
}

export class OutputRejected extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`model output rejected: ${reasons.join('; ')}`);
    this.name = 'OutputRejected';
  }
}

export function loadOutputSchema(repoRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, OUTPUT_SCHEMA_PATH), 'utf8')) as Record<
    string,
    unknown
  >;
}

export function definitionVersion(repoRoot: string): string {
  const text = readFileSync(join(repoRoot, DEFINITION_DIR, 'definition.md'), 'utf8');
  const version = /^definitionVersion:\s*(\d+\.\d+)\s*$/m.exec(text)?.[1];
  if (version === undefined)
    throw new Error(`${DEFINITION_DIR}/definition.md declares no definitionVersion`);
  return version;
}

/** Stop reason, JSON syntax, output schema and status/test-file consistency. */
export function checkOutput(
  response: ModelResponse,
  schema: Record<string, unknown>,
): GeneratorOutput {
  if (response.stopReason === 'refusal')
    throw new OutputRejected(['the model refused (stop_reason "refusal")']);
  if (response.stopReason === 'max_tokens') {
    throw new OutputRejected([
      'the output hit max_tokens and may be incomplete (stop_reason "max_tokens")',
    ]);
  }
  if (response.stopReason !== 'end_turn') {
    throw new OutputRejected([`unexpected stop_reason "${String(response.stopReason)}"`]);
  }

  let output: unknown;
  try {
    output = JSON.parse(response.text);
  } catch {
    throw new OutputRejected(['the output is not valid JSON']);
  }

  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(output)) {
    throw new OutputRejected(
      (validate.errors ?? []).map(
        (error) => `${error.instancePath || '(root)'} ${error.message ?? error.keyword}`,
      ),
    );
  }
  const checked = output as GeneratorOutput;
  if (checked.status === 'READY' && checked.testFile === null) {
    throw new OutputRejected(['status READY requires exactly one test file']);
  }
  if (checked.status !== 'READY' && checked.testFile !== null) {
    throw new OutputRejected([`status ${checked.status} must not propose a test file`]);
  }
  return checked;
}

export interface EnvelopeMeta {
  readonly taskId: string;
  readonly definitionVersion: string;
  /** How the output was obtained: a provider call, or a recorded output with no LLM call. */
  readonly modelCall: 'anthropic-api' | 'offline-recorded-output';
  /** null when no provider request was made (offline). */
  readonly requestedModel: string | null;
  readonly servedModel: string;
  readonly effort: string | null;
  readonly maxTokens: number | null;
  readonly allowReferencedTestCase: boolean;
}

/** The orchestrator-owned envelope around the model-owned content (Generator definition: Output). */
export function assembleEnvelope(
  selected: SelectedTestCase,
  context: ContextPack,
  output: GeneratorOutput,
  meta: EnvelopeMeta,
): Record<string, unknown> {
  const trace = { requirements: [selected.requirement], testCases: [selected.testCase] };
  const number = (n: number): string => String(n + 1).padStart(3, '0');

  return {
    artifactType: 'test-proposal',
    schemaVersion: '1.0',
    standardVersion: '1.2',
    agent: { name: 'generator', definitionVersion: meta.definitionVersion },
    taskId: meta.taskId,
    status: output.status,
    summary: output.summary,
    sourceReferences: sourceReferences(context),
    traceability: { ...trace, canonicalPatterns: [...output.canonicalPatterns] },
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
    proposedChanges:
      output.testFile === null
        ? []
        : [
            {
              path: output.testFile.path,
              changeKind: 'test-change',
              operation: 'create',
              content: output.testFile.content,
              rationale: output.testFile.rationale,
              traceability: trace,
            },
          ],
    payload: {
      modelCall: meta.modelCall,
      requestedModel: meta.requestedModel,
      servedModel: meta.servedModel,
      effort: meta.effort,
      maxTokens: meta.maxTokens,
      definitionVersion: meta.definitionVersion,
      requestedTestCase: selected.testCase,
      allowReferencedTestCase: meta.allowReferencedTestCase,
    },
  };
}

/** One reference per context file, with the approved IDs it contributed. */
function sourceReferences(context: ContextPack): { path: string; role: string; ids?: string[] }[] {
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
