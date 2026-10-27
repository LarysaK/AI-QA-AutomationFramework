import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ModelClient } from '../generator/model-client';
import { heal } from './heal';

/**
 * Usage: npm run agents:heal -- --report <playwright-report.json> --test <tests/…spec.ts>:<line>
 *          [--app requestflow] --fake-model-output <file>
 *
 * Diagnoses one failed Playwright test from its JSON report and, when the evidence supports it,
 * proposes a narrowly scoped repair. The proposal is staged under artifacts/proposals/<taskId>/;
 * a repair is checked by the validator WITHOUT execution authorization. The Healer never applies
 * a repair, never runs proposed code and never requests or supplies H7.
 *
 * Healer v1 is offline-only: --fake-model-output is required. The file is a recorded model
 * output; no LLM is called and no credential is needed. The staged records say so.
 *
 * Exit codes: 0 staged (diagnosis, or repair awaiting H7/H3), 1 repair failed validation, 2 usage
 * or precondition stop, 4 model output rejected, 5 BLOCKED / NEEDS_HUMAN_DECISION staged.
 */

const USAGE =
  'Usage: npm run agents:heal -- --report <playwright-report.json> --test <tests/…spec.ts>:<line> ' +
  '[--app requestflow] --fake-model-output <file>';

interface Args {
  report?: string;
  test?: string;
  app: string;
  fakeOutput?: string;
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { app: 'requestflow' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string | undefined => argv[(i += 1)];
    const v = flag === undefined || !flag.startsWith('--') ? undefined : value();
    switch (flag) {
      case '--report':
        if (v === undefined) return '--report needs a file';
        args.report = v;
        break;
      case '--test':
        if (v === undefined) return '--test needs a value';
        args.test = v;
        break;
      case '--app':
        if (v === undefined) return '--app needs a value';
        args.app = v;
        break;
      case '--fake-model-output':
        if (v === undefined) return '--fake-model-output needs a file';
        args.fakeOutput = v;
        break;
      default:
        return `Unknown argument: ${String(flag)}`;
    }
  }
  if (args.report === undefined)
    return 'Missing --report: a Playwright JSON report is the only accepted failure evidence';
  if (args.test === undefined) return 'Missing --test';
  if (args.fakeOutput === undefined) {
    return 'Healer v1 is offline-only: --fake-model-output <file> is required (no model is called)';
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
  const result = await heal(
    {
      repoRoot: process.cwd(),
      app: args.app,
      report: args.report ?? '',
      test: args.test ?? '',
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
