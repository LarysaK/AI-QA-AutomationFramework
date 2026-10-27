import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ModelClient } from '../generator/model-client';
import { plan } from './plan';

/**
 * Usage: npm run agents:plan -- --req REQ-NNN [--req REQ-NNN …] [--app requestflow]
 *          [--instruction "…"] --fake-model-output <file>
 *
 * Proposes test-planning additions for approved requirements and stages them under
 * artifacts/proposals/<taskId>/ for human review at gate H1. Never writes the test plan or the
 * requirements, never approves, and never requests or supplies execution authorization (H7).
 *
 * Planner v1 is offline-only: --fake-model-output is required. The file is a recorded model
 * output; no LLM is called and no credential is needed. The staged records say so (modelCall
 * "offline-recorded-output", and the file's path and SHA-256 in request.json). Offline output
 * must never be presented as model-generated.
 *
 * Exit codes: 0 READY staged (awaiting H1), 2 usage or precondition stop, 4 model output
 * rejected, 5 BLOCKED / NEEDS_HUMAN_DECISION staged.
 */

const USAGE =
  'Usage: npm run agents:plan -- --req REQ-NNN [--req REQ-NNN …] [--app requestflow] ' +
  '[--instruction "…"] --fake-model-output <file>';

interface Args {
  requirements: string[];
  app: string;
  instruction?: string;
  fakeOutput?: string;
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { requirements: [], app: 'requestflow' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string | undefined => argv[(i += 1)];
    switch (flag) {
      case '--req': {
        const v = value();
        if (v === undefined) return '--req needs a value';
        args.requirements.push(v);
        break;
      }
      case '--app': {
        const v = value();
        if (v === undefined) return '--app needs a value';
        args.app = v;
        break;
      }
      case '--instruction': {
        const v = value();
        if (v === undefined) return '--instruction needs a value';
        args.instruction = v;
        break;
      }
      case '--fake-model-output': {
        const v = value();
        if (v === undefined) return '--fake-model-output needs a file';
        args.fakeOutput = v;
        break;
      }
      default:
        return `Unknown argument: ${String(flag)}`;
    }
  }
  if (args.requirements.length === 0) return 'Missing --req';
  if (args.fakeOutput === undefined) {
    return 'Planner v1 is offline-only: --fake-model-output <file> is required (no model is called)';
  }
  return args;
}

/** A model client that returns a recorded output; no provider is contacted. */
function fakeClient(text: string): ModelClient {
  return {
    generate: () =>
      Promise.resolve({
        text,
        stopReason: 'end_turn',
        servedModel: 'fake-model-output',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(args);
    console.error(USAGE);
    return 2;
  }
  const source = args.fakeOutput ?? '';
  let bytes: Buffer;
  try {
    bytes = readFileSync(source);
  } catch {
    console.error(`Cannot read recorded model output: ${source}`);
    return 2;
  }
  console.log(`Using recorded model output from ${source}; no provider call.`);
  const result = await plan(
    {
      repoRoot: process.cwd(),
      app: args.app,
      requirements: args.requirements,
      ...(args.instruction === undefined ? {} : { instruction: args.instruction }),
      offline: { source, sha256: createHash('sha256').update(bytes).digest('hex') },
    },
    { modelClient: fakeClient(bytes.toString('utf8')) },
  );
  for (const line of result.lines) console.log(line);
  return result.exitCode;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
