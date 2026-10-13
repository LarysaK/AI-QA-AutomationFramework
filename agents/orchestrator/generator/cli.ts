import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { generate } from './generate';
import { createAnthropicModelClient, type ModelClient } from './model-client';

/**
 * Usage: npm run agents:generate -- --tc TC-NNN-NN [--app requestflow] [--instruction "…"]
 *          [--allow-referenced-tc] [--model <id>] [--fake-model-output <file>]
 *
 * Proposes one new test for an approved test case, stages it under artifacts/proposals/<taskId>/
 * and runs the validator without execution authorization. Never authorizes execution (H7) and
 * never applies the proposal.
 *
 * --fake-model-output reads the model's JSON output from a file instead of calling a provider
 * (offline demos and tests). No LLM is called and no credential is needed; the staged records say
 * so: modelCall "offline-recorded-output", requestedModel and effort null, servedModel
 * "fake-model-output", and the file's path and SHA-256 in request.json. Offline output must never
 * be presented as model-generated.
 *
 * Exit codes: 0 READY staged and validator INCOMPLETE, 1 validation failed, 2 usage or
 * precondition stop, 4 model output rejected, 5 BLOCKED / NEEDS_HUMAN_DECISION staged.
 */

const USAGE =
  'Usage: npm run agents:generate -- --tc TC-NNN-NN [--app requestflow] [--instruction "…"] ' +
  '[--allow-referenced-tc] [--model <id>] [--fake-model-output <file>]';

interface Args {
  testCase?: string;
  app: string;
  instruction?: string;
  allowReferenced: boolean;
  model?: string;
  fakeOutput?: string;
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { app: 'requestflow', allowReferenced: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string | undefined => argv[(i += 1)];
    switch (flag) {
      case '--tc': {
        const v = value();
        if (v === undefined) return '--tc needs a value';
        args.testCase = v;
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
      case '--model': {
        const v = value();
        if (v === undefined) return '--model needs a value';
        args.model = v;
        break;
      }
      case '--fake-model-output': {
        const v = value();
        if (v === undefined) return '--fake-model-output needs a file';
        args.fakeOutput = v;
        break;
      }
      case '--allow-referenced-tc':
        args.allowReferenced = true;
        break;
      default:
        return `Unknown argument: ${String(flag)}`;
    }
  }
  if (args.testCase === undefined) return 'Missing --tc';
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
  let recorded: { text: string; sha256: string } | undefined;
  if (args.fakeOutput !== undefined) {
    try {
      const bytes = readFileSync(args.fakeOutput);
      recorded = {
        text: bytes.toString('utf8'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch {
      console.error(`Cannot read recorded model output: ${args.fakeOutput}`);
      return 2;
    }
    console.log(`Using recorded model output from ${args.fakeOutput}; no provider call.`);
  }

  const result = await generate(
    {
      repoRoot: process.cwd(),
      app: args.app,
      testCase: args.testCase ?? '',
      allowReferenced: args.allowReferenced,
      ...(args.instruction === undefined ? {} : { instruction: args.instruction }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(recorded === undefined || args.fakeOutput === undefined
        ? {}
        : { offline: { source: args.fakeOutput, sha256: recorded.sha256 } }),
    },
    {
      modelClient:
        recorded === undefined ? createAnthropicModelClient() : fakeClient(recorded.text),
    },
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
