import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import { buildContext, chooseCanonicals, section } from './context';
import {
  generate,
  type GenerateResult,
  runValidatorCli,
  type ValidatorRunner,
  validatorEnvironment,
} from './generate';
import {
  ANTHROPIC_CLIENT_OPTIONS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  toMessageParams,
} from './model-client';
import { GeneratorStop, selectTestCase, type SelectedTestCase } from './select';
import { findSecrets } from './stage';

/**
 * Generator tests. The model is always a fake; no provider is contacted. The approved repository
 * is only read; every proposal is staged in a temporary proposals root.
 */

const REPO = resolve('.');
const FIXTURE = readFileSync(
  join(REPO, 'agents/orchestrator/generator/fixtures/tc-003-07.spec.ts.txt'),
  'utf8',
);
const PROPOSED_PATH = 'tests/requestflow/api/submit-already-submitted.spec.ts';
const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function proposalsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agents-generator-'));
  roots.push(root);
  return root;
}

const readyOutput = (overrides: Record<string, unknown> = {}) => ({
  status: 'READY',
  summary: 'Adds TC-003-07: a second submit returns 409 and leaves the request unchanged.',
  testFile: { path: PROPOSED_PATH, content: FIXTURE, rationale: 'Follows CAN-003.' },
  canonicalPatterns: ['CAN-003'],
  assumptions: [{ statement: 'A fresh request is used.', impact: 'No shared state.' }],
  findings: [{ kind: 'risk', severity: 'info', message: 'None.' }],
  contextRequests: [],
  ...overrides,
});

const blockedOutput = {
  status: 'BLOCKED',
  summary: 'A needed API client method is missing.',
  testFile: null,
  canonicalPatterns: [],
  assumptions: [],
  findings: [{ kind: 'missing-context', severity: 'blocking', message: 'No helper available.' }],
  contextRequests: ['Add the missing helper.'],
};

const needsDecisionOutput = {
  ...blockedOutput,
  status: 'NEEDS_HUMAN_DECISION',
  summary: 'Expected behaviour is not defined.',
  findings: [{ kind: 'ambiguity', severity: 'blocking', message: 'Undefined behaviour.' }],
  contextRequests: [],
};

interface Spy {
  readonly requests: ModelRequest[];
}

function fakeClient(response: Partial<ModelResponse> | Error, spy?: Spy): ModelClient {
  return {
    generate(request) {
      spy?.requests.push(request);
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve({
        text: '',
        stopReason: 'end_turn',
        servedModel: 'fake-model',
        usage: { inputTokens: 1, outputTokens: 1 },
        ...response,
      });
    },
  };
}

const replying = (output: unknown, spy?: Spy): ModelClient =>
  fakeClient({ text: JSON.stringify(output) }, spy);

interface ValidatorSpy {
  calls: { artifactPath: string; env: NodeJS.ProcessEnv }[];
}

/** A stub validator that answers like the real one would for a valid READY proposal. */
function stubValidator(spy: ValidatorSpy, exitCode = 3): ValidatorRunner {
  return (artifactPath, _repoRoot, env) => {
    spy.calls.push({ artifactPath, env });
    return {
      exitCode,
      output: 'G-SCHEMA     passed\nResult: INCOMPLETE (execution authorization required)\n',
    };
  };
}

async function run(
  modelClient: ModelClient,
  options: {
    testCase?: string;
    allowReferenced?: boolean;
    model?: string;
    instruction?: string;
  } = {},
  deps: { runValidator?: ValidatorRunner; env?: NodeJS.ProcessEnv; root?: string } = {},
): Promise<GenerateResult & { root: string }> {
  const root = deps.root ?? proposalsRoot();
  const result = await generate(
    {
      repoRoot: REPO,
      app: 'requestflow',
      testCase: options.testCase ?? 'TC-003-07',
      allowReferenced: options.allowReferenced ?? false,
      proposalsRoot: root,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.instruction === undefined ? {} : { instruction: options.instruction }),
    },
    {
      modelClient,
      runValidator: deps.runValidator ?? stubValidator({ calls: [] }),
      env: deps.env ?? {},
      now: () => new Date('2026-10-13T09:00:00Z'),
    },
  );
  return { ...result, root };
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

function fingerprint(): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
  const hash = createHash('sha256');
  hash.update(git('status', '--porcelain=v1', '-uall'));
  hash.update(git('ls-files', '-s'));
  for (const path of git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(
    '\0',
  )) {
    if (path !== '' && existsSync(join(REPO, path)))
      hash.update(path).update(readFileSync(join(REPO, path)));
  }
  return hash.digest('hex');
}
const repoBefore = fingerprint();

// ---------------------------------------------------------------- selection

describe('test-case selection (before any model call)', () => {
  const stops = async (testCase: string, reason: RegExp): Promise<void> => {
    const spy: Spy = { requests: [] };
    const result = await run(replying(readyOutput(), spy), { testCase });
    assert.equal(result.exitCode, 2, result.lines.join('\n'));
    assert.match(result.lines.join('\n'), reason);
    assert.equal(spy.requests.length, 0, 'the model must not be called');
  };

  test('an unknown test case stops the run', () => stops('TC-003-99', /not an approved test case/));
  test('a test case marked "Automation: No" stops the run', () =>
    stops('TC-004-07', /Automation: No/));
  test('a malformed test-case ID stops the run', () => stops('TC-3-7', /not a test-case ID/));

  test('a statically referenced test case stops, without claiming coverage', async () => {
    await stops(
      'TC-001-17',
      /referenced by tests\/requestflow\/ui\/create-request\.spec\.ts\. This is a static reference, not verified coverage\..*--allow-referenced-tc/,
    );
  });

  test('--allow-referenced-tc proceeds and is recorded', async () => {
    const spy: Spy = { requests: [] };
    const result = await run(replying(readyOutput(), spy), {
      testCase: 'TC-001-17',
      allowReferenced: true,
    });
    assert.equal(spy.requests.length, 1);
    const request = readJson(join(result.taskDir ?? '', 'request.json'));
    assert.equal(request['allowReferencedTestCase'], true);
    assert.deepEqual(request['staticReferences'], ['tests/requestflow/ui/create-request.spec.ts']);
    const artifact = readJson(join(result.taskDir ?? '', 'artifact.json'));
    assert.equal((artifact['payload'] as Record<string, unknown>)['allowReferencedTestCase'], true);
  });

  test('an over-long instruction stops the run', async () => {
    const result = await run(replying(readyOutput()), { instruction: 'x'.repeat(1001) });
    assert.equal(result.exitCode, 2);
  });
});

// ---------------------------------------------------------------- context

describe('context selection', () => {
  const selected = (): SelectedTestCase => selectTestCase(REPO, 'requestflow', 'TC-003-07', false);

  test('TC-003-07: exact pieces, order, sizes and blob SHAs; nothing excluded leaks in', () => {
    const pack = buildContext(REPO, selected());
    assert.deepEqual(
      pack.pieces.map((piece) => `${piece.role} ${piece.path} § ${piece.section}`),
      [
        'architecture agents/standard/standard.md § ## 5. (up to ### 5.1)',
        'architecture agents/standard/standard.md § ### 6.2',
        'architecture agents/standard/standard.md § ## 10.',
        'architecture agents/standard/standard.md § ## 11.',
        'architecture agents/standard/standard.md § ## 13.',
        'requirements specs/requestflow/requirements.md § before "# Requirements"',
        'requirements specs/requestflow/requirements.md § ## REQ-003',
        'requirements specs/requestflow/requirements.md § # API',
        'test-plan specs/requestflow/test-plan.md § ## 1.',
        'test-plan specs/requestflow/test-plan.md § ### REQ-003',
        'canonical-test tests/requestflow/api/create-request-validation.spec.ts § whole file',
        'canonical-test tests/requestflow/api/edit-draft-request.spec.ts § whole file',
        'support apps/requestflow/api/requestflow-api.client.ts § whole file',
        'support apps/requestflow/data/demo-users.ts § whole file',
      ],
    );
    assert.deepEqual(pack.canonicals, ['CAN-002', 'CAN-003']);
    assert.ok(pack.totalBytes > 30_000 && pack.totalBytes < 40_000, String(pack.totalBytes));
    for (const piece of pack.pieces) {
      assert.match(piece.blobSha, /^[0-9a-f]{40}$/);
      assert.equal(piece.bytes, Buffer.byteLength(piece.text));
      assert.doesNotMatch(piece.path, /\.env|^artifacts\/|node_modules|^apps\/[^/]+\/app\//);
    }
    assert.ok(pack.pieces.some((piece) => piece.text.includes('| TC-003-07 |')));
    assert.ok(
      !pack.pieces.some((piece) => piece.text.includes('## REQ-005 —')),
      'other requirements excluded',
    );
  });

  test('canonical priority with more than two candidates: same requirement first, then CAN ID', () => {
    const plan = [
      '| ID      | Title | Level | Covers    |',
      '| ------- | ----- | ----- | --------- |',
      '| CAN-001 | a     | API   | TC-001-01 |',
      '| CAN-002 | b     | API   | TC-002-01 |',
      '| CAN-003 | c     | API   | TC-003-02 |',
      '| CAN-004 | d     | UI    | TC-003-01 |',
      '',
    ].join('\n');
    const chosen = chooseCanonicals(plan, { ...selected(), level: 'API', requirement: 'REQ-003' });
    assert.deepEqual(chosen, ['CAN-003', 'CAN-001']);
  });

  test('an exceeded size limit stops without truncating', () => {
    assert.throws(
      () => buildContext(REPO, selected(), 10_000),
      (error: unknown) => {
        return (
          error instanceof GeneratorStop &&
          /over the 10000-byte limit; nothing was truncated/.test(error.message)
        );
      },
    );
  });

  test('missing required context stops', () => {
    assert.throws(() => section('# Title\n', /^## 5\. /, 'standard.md'), GeneratorStop);
    const empty = mkdtempSync(join(tmpdir(), 'agents-generator-empty-'));
    roots.push(empty);
    assert.throws(
      () => buildContext(empty, selected()),
      /required context file agents\/standard\/standard\.md not found/,
    );
  });

  test('malformed approved documents stop before any model call', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agents-generator-broken-'));
    roots.push(repo);
    mkdirSync(join(repo, 'specs/requestflow'), { recursive: true });
    writeFileSync(join(repo, 'specs/requestflow/requirements.md'), '## REQ-003 — Submit\n');
    writeFileSync(
      join(repo, 'specs/requestflow/test-plan.md'),
      '### REQ-003 — Submit\n| TC-001-01 | misplaced |\n',
    );
    assert.throws(
      () => selectTestCase(repo, 'requestflow', 'TC-003-07', false),
      /approved documents cannot be parsed/,
    );
  });
});

// ---------------------------------------------------------------- READY

describe('READY proposals', () => {
  test('a valid READY proposal is assembled, staged and handed to the validator without H7', async () => {
    const validator: ValidatorSpy = { calls: [] };
    const spy: Spy = { requests: [] };
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
      PATH: process.env['PATH'] ?? '',
      SECRET_TOKEN: 'x',
    };
    const result = await run(
      replying(readyOutput(), spy),
      {},
      { runValidator: stubValidator(validator), env },
    );
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const taskDir = result.taskDir ?? '';

    // Staged files, all inside the task directory.
    assert.deepEqual(filesUnder(result.root), [
      `${result.taskId ?? ''}/artifact.json`,
      `${result.taskId ?? ''}/preview/${PROPOSED_PATH}.proposed`,
      `${result.taskId ?? ''}/request.json`,
      `${result.taskId ?? ''}/response.json`,
      `${result.taskId ?? ''}/status.json`,
      `${result.taskId ?? ''}/validation-1.txt`,
    ]);

    // Orchestrator-owned envelope fields.
    const artifact = readJson(join(taskDir, 'artifact.json'));
    assert.equal(artifact['artifactType'], 'test-proposal');
    assert.equal(artifact['standardVersion'], '2.0');
    assert.deepEqual(artifact['agent'], { name: 'generator', definitionVersion: '1.1' });
    assert.equal(artifact['taskId'], 'gen-tc-003-07-20261013T090000Z');
    assert.deepEqual(artifact['traceability'], {
      requirements: ['REQ-003'],
      testCases: ['TC-003-07'],
      canonicalPatterns: ['CAN-003'],
    });
    const [change] = artifact['proposedChanges'] as Record<string, unknown>[];
    assert.ok(change);
    assert.equal(change['changeKind'], 'test-change');
    assert.equal(change['operation'], 'create');
    assert.equal(change['baseSha'], undefined);
    assert.deepEqual(change['traceability'], {
      requirements: ['REQ-003'],
      testCases: ['TC-003-07'],
    });
    assert.deepEqual(artifact['assumptions'], [
      { id: 'A-001', statement: 'A fresh request is used.', impact: 'No shared state.' },
    ]);
    assert.equal((artifact['findings'] as { id: string }[])[0]?.id, 'F-001');
    assert.deepEqual(artifact['payload'], {
      modelCall: 'anthropic-api',
      requestedModel: DEFAULT_MODEL,
      servedModel: 'fake-model',
      effort: 'medium',
      maxTokens: DEFAULT_MAX_TOKENS,
      definitionVersion: '1.1',
      requestedTestCase: 'TC-003-07',
      allowReferencedTestCase: false,
    });

    // Model content preserved byte for byte, in the artifact and the preview.
    assert.equal(change['content'], FIXTURE);
    assert.equal(
      readFileSync(join(taskDir, 'preview', `${PROPOSED_PATH}.proposed`), 'utf8'),
      FIXTURE,
    );

    // Status record and digest.
    const status = readJson(join(taskDir, 'status.json'));
    assert.equal(status['pipelineStatus'], 'EXECUTION_AUTHORIZATION_REQUIRED');
    assert.equal(
      status['artifactSha256'],
      createHash('sha256')
        .update(readFileSync(join(taskDir, 'artifact.json')))
        .digest('hex'),
    );

    // Validator child: allowlisted environment only, artifact path only (no H7).
    assert.equal(validator.calls.length, 1);
    const call = validator.calls[0];
    assert.ok(call);
    assert.equal(call.artifactPath, join(taskDir, 'artifact.json'));
    assert.equal(call.env['ANTHROPIC_API_KEY'], undefined);
    assert.equal(call.env['SECRET_TOKEN'], undefined);
    assert.equal(call.env['PATH'], env.PATH);

    // The request record holds a manifest, not the context text, and no credentials.
    const requestText = readFileSync(join(taskDir, 'request.json'), 'utf8');
    assert.doesNotMatch(requestText, /sk-ant-test/);
    assert.doesNotMatch(
      requestText,
      /Agent Standard v2\.0/,
      'context text is not copied into request.json',
    );
    assert.equal(spy.requests[0]?.model, DEFAULT_MODEL);
  });

  test('model override by option and by AGENTS_GENERATOR_MODEL; effort only for supported models', async () => {
    const spy: Spy = { requests: [] };
    await run(replying(readyOutput(), spy), { model: 'claude-opus-5-5' });
    await run(
      replying(readyOutput(), spy),
      {},
      { env: { AGENTS_GENERATOR_MODEL: 'claude-sonnet-4-6' } },
    );
    const [first, second] = spy.requests;
    assert.ok(first && second);
    assert.equal(first.model, 'claude-opus-5-5');
    assert.equal(first.effort, 'medium');
    assert.equal(second.model, 'claude-sonnet-4-6');
    assert.equal(second.effort, undefined);
    assert.equal(second.maxTokens, 12_000);
  });

  test('the provider request: JSON-schema output, effort only when set, no fallbacks, no retries', () => {
    const base: ModelRequest = {
      model: 'm',
      maxTokens: 12_000,
      system: 's',
      context: 'c',
      task: 't',
      schema: { type: 'object' },
    };
    const withoutEffort = toMessageParams(base);
    assert.deepEqual(withoutEffort.output_config, {
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
    assert.equal(toMessageParams({ ...base, effort: 'medium' }).output_config?.effort, 'medium');
    assert.equal('fallbacks' in withoutEffort, false);
    assert.equal(withoutEffort.max_tokens, 12_000);
    assert.deepEqual(ANTHROPIC_CLIENT_OPTIONS, { maxRetries: 0 });
  });

  test('a READY proposal with an extra TC, @CAN or a non-test path is staged unchanged and fails validation', async () => {
    const variants: [string, Record<string, unknown>][] = [
      [
        'extra TC tag',
        {
          testFile: {
            path: PROPOSED_PATH,
            content: FIXTURE.replace("'@TC-003-07'", "['@TC-003-07', '@TC-003-06']"),
            rationale: 'r',
          },
        },
      ],
      [
        '@CAN tag',
        {
          testFile: {
            path: PROPOSED_PATH,
            content: FIXTURE.replace("'@TC-003-07'", "['@TC-003-07', '@CAN-006']"),
            rationale: 'r',
          },
        },
      ],
      [
        'non-test path',
        {
          testFile: {
            path: 'apps/requestflow/data/submit-check.ts',
            content: FIXTURE,
            rationale: 'r',
          },
        },
      ],
    ];
    for (const [name, overrides] of variants) {
      const output = readyOutput(overrides);
      const result = await run(replying(output), {}, { runValidator: runValidatorCli });
      assert.equal(result.exitCode, 1, `${name}: ${result.lines.join('\n')}`);
      const artifact = readJson(join(result.taskDir ?? '', 'artifact.json'));
      const [change] = artifact['proposedChanges'] as Record<string, unknown>[];
      assert.ok(change);
      assert.equal(
        change['content'],
        (output.testFile as { content: string }).content,
        `${name}: content unchanged`,
      );
      assert.equal(
        change['path'],
        (output.testFile as { path: string }).path,
        `${name}: path unchanged`,
      );
      assert.equal(
        readJson(join(result.taskDir ?? '', 'status.json'))['pipelineStatus'],
        'VALIDATION_FAILED',
      );
    }
  });

  test('the real validator child returns INCOMPLETE for a valid READY proposal', async () => {
    const result = await run(
      replying(readyOutput()),
      {},
      {
        runValidator: runValidatorCli,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test-1111111111111111' },
      },
    );
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const validation = readFileSync(join(result.taskDir ?? '', 'validation-1.txt'), 'utf8');
    for (const guard of ['G-SCHEMA', 'G-PATHS', 'G-BASE', 'G-TRACE', 'G-STATIC']) {
      assert.match(validation, new RegExp(`${guard}\\s+passed`));
    }
    assert.match(validation, /G-DISCOVERY\s+not-authorized/);
    assert.match(validation, /G-RUN\s+not-authorized/);
    assert.match(validation, /Result: INCOMPLETE/);
    assert.equal(
      readJson(join(result.taskDir ?? '', 'status.json'))['pipelineStatus'],
      'EXECUTION_AUTHORIZATION_REQUIRED',
    );
    assert.doesNotMatch(validation, /sk-ant-test/);
  });
});

// ---------------------------------------------------------------- provenance

describe('model-call provenance', () => {
  const offline = { source: 'fixtures/recorded-output.json', sha256: 'a'.repeat(64) };

  async function runOffline(model?: string) {
    const root = proposalsRoot();
    const spy: Spy = { requests: [] };
    const result = await generate(
      {
        repoRoot: REPO,
        app: 'requestflow',
        testCase: 'TC-003-07',
        allowReferenced: false,
        proposalsRoot: root,
        offline,
        ...(model === undefined ? {} : { model }),
      },
      {
        modelClient: fakeClient(
          { text: JSON.stringify(readyOutput()), servedModel: 'fake-model-output' },
          spy,
        ),
        runValidator: stubValidator({ calls: [] }),
        env: { AGENTS_GENERATOR_MODEL: 'claude-opus-5-5' },
        now: () => new Date('2026-10-13T09:00:00Z'),
      },
    );
    return { result, spy };
  }

  test('offline: no requested model, effort or token budget; recorded source and SHA-256; notice printed', async () => {
    const { result, spy } = await runOffline('claude-sonnet-5-5');
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const payload = readJson(join(result.taskDir ?? '', 'artifact.json'))['payload'];
    assert.deepEqual(payload, {
      modelCall: 'offline-recorded-output',
      requestedModel: null,
      servedModel: 'fake-model-output',
      effort: null,
      maxTokens: null,
      definitionVersion: '1.1',
      requestedTestCase: 'TC-003-07',
      allowReferencedTestCase: false,
    });
    const request = readJson(join(result.taskDir ?? '', 'request.json'));
    assert.equal(request['offline'], true);
    assert.deepEqual(request['recordedOutput'], { path: offline.source, sha256: offline.sha256 });
    assert.equal(request['model'], null);
    assert.equal(request['effort'], null);
    assert.equal(request['maxTokens'], null);
    assert.equal(result.lines.at(-1), 'OFFLINE — no LLM was called');
    // The fake client is never told a provider model; overrides are ignored offline.
    const [sent] = spy.requests;
    assert.ok(sent);
    assert.equal(sent.model, 'offline-recorded-output');
    assert.equal(sent.effort, undefined);
  });

  test('offline output goes through the same checks: invalid output is still rejected', async () => {
    const root = proposalsRoot();
    const result = await generate(
      {
        repoRoot: REPO,
        app: 'requestflow',
        testCase: 'TC-003-07',
        allowReferenced: false,
        proposalsRoot: root,
        offline,
      },
      {
        modelClient: fakeClient({ text: 'not json', servedModel: 'fake-model-output' }),
        env: {},
        now: () => new Date(),
      },
    );
    assert.equal(result.exitCode, 4);
    assert.equal(result.lines.at(-1), 'OFFLINE — no LLM was called');
  });

  test('live: requested model, effort, token budget and the served model are recorded; no offline marker', async () => {
    const result = await run(
      fakeClient({ text: JSON.stringify(readyOutput()), servedModel: 'claude-sonnet-5-5' }),
      {
        model: 'claude-opus-5-5',
      },
    );
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    const payload = readJson(join(result.taskDir ?? '', 'artifact.json'))['payload'] as Record<
      string,
      unknown
    >;
    assert.equal(payload['modelCall'], 'anthropic-api');
    assert.equal(payload['requestedModel'], 'claude-opus-5-5');
    assert.equal(
      payload['servedModel'],
      'claude-sonnet-5-5',
      'served model comes from the response',
    );
    assert.equal(payload['effort'], 'medium');
    assert.equal(payload['maxTokens'], 12_000);
    const request = readJson(join(result.taskDir ?? '', 'request.json'));
    assert.equal(request['offline'], false);
    assert.equal(request['recordedOutput'], null);
    assert.equal(request['model'], 'claude-opus-5-5');
    assert.ok(!result.lines.includes('OFFLINE — no LLM was called'));
  });
});

// ---------------------------------------------------------------- non-READY

describe('BLOCKED and NEEDS_HUMAN_DECISION', () => {
  for (const [name, output] of [
    ['BLOCKED', blockedOutput],
    ['NEEDS_HUMAN_DECISION', needsDecisionOutput],
  ] as const) {
    test(`${name} is staged with no changes, checked in process, and never offered H7`, async () => {
      const validator: ValidatorSpy = { calls: [] };
      const result = await run(replying(output), {}, { runValidator: stubValidator(validator) });
      assert.equal(result.exitCode, 5, result.lines.join('\n'));
      assert.equal(validator.calls.length, 0, 'the validator CLI is not invoked');
      const artifact = readJson(join(result.taskDir ?? '', 'artifact.json'));
      assert.equal(artifact['status'], name);
      assert.deepEqual(artifact['proposedChanges'], []);
      assert.equal(existsSync(join(result.taskDir ?? '', 'preview')), false);
      const status = readJson(join(result.taskDir ?? '', 'status.json'));
      assert.equal(status['pipelineStatus'], 'STAGED');
      assert.equal(status['agentStatus'], name);
      const validation = readFileSync(join(result.taskDir ?? '', 'validation-1.txt'), 'utf8');
      assert.match(validation, /G-SCHEMA\s+passed/);
      assert.match(validation, /G-TRACE\s+passed/);
      assert.doesNotMatch(result.lines.join('\n'), /authorize|H7/i);
    });
  }
});

// ---------------------------------------------------------------- rejected output

describe('rejected model output (no artifact, nothing repaired)', () => {
  const cases: [string, ModelClient, RegExp][] = [
    ['refusal', fakeClient({ stopReason: 'refusal', text: '{}' }), /refused/],
    ['max_tokens', fakeClient({ stopReason: 'max_tokens', text: '{"status":"REA' }), /max_tokens/],
    ['invalid JSON', fakeClient({ text: 'Here is your test: ...' }), /not valid JSON/],
    ['schema violation', replying({ ...readyOutput(), status: 'DONE' }), /status/],
    ['missing field', replying({ status: 'READY', summary: 's' }), /must have required property/],
    [
      'READY without a test file',
      replying(readyOutput({ testFile: null })),
      /READY requires exactly one test file/,
    ],
    [
      'BLOCKED with a test file',
      replying({ ...blockedOutput, testFile: readyOutput().testFile }),
      /must not propose a test file/,
    ],
    [
      'envelope rule (summary over 500 characters)',
      replying(readyOutput({ summary: 's'.repeat(501) })),
      /envelope \/summary/,
    ],
    [
      'unsafe path (rejected by the envelope schema)',
      replying(
        readyOutput({ testFile: { path: '../outside.spec.ts', content: FIXTURE, rationale: 'r' } }),
      ),
      /envelope \/proposedChanges\/0\/path/,
    ],
    [
      'provider error',
      fakeClient(new Error('connection refused')),
      /the model call failed: Error: connection refused/,
    ],
  ];
  for (const [name, client, reason] of cases) {
    test(name, async () => {
      const validator: ValidatorSpy = { calls: [] };
      const result = await run(client, {}, { runValidator: stubValidator(validator) });
      assert.equal(result.exitCode, 4, result.lines.join('\n'));
      assert.match(result.lines.join('\n'), reason);
      assert.equal(existsSync(join(result.taskDir ?? '', 'artifact.json')), false);
      assert.ok(existsSync(join(result.taskDir ?? '', 'response.json')));
      assert.ok(existsSync(join(result.taskDir ?? '', 'rejection.json')));
      assert.equal(validator.calls.length, 0);
    });
  }
});

// ---------------------------------------------------------------- secrets and confinement

describe('credentials and staging confinement', () => {
  test('output containing a credential value or key pattern stages nothing', async () => {
    const env = { ANTHROPIC_API_KEY: 'super-secret-value-123' };
    for (const leak of ['super-secret-value-123', 'sk-ant-abcdefghijklmnop']) {
      const result = await run(replying(readyOutput({ summary: `contains ${leak}` })), {}, { env });
      assert.equal(result.exitCode, 4, result.lines.join('\n'));
      assert.match(result.lines.join('\n'), /possible secrets found/);
      assert.deepEqual(filesUnder(result.root), [], 'nothing written');
    }
  });

  test('findSecrets ignores short or missing values', () => {
    assert.deepEqual(
      findSecrets([{ path: 'a', content: 'abc' }], { ANTHROPIC_API_KEY: 'abc' }),
      [],
    );
  });

  test('the validator environment is an allowlist without provider credentials', () => {
    const env = validatorEnvironment({
      PATH: '/bin',
      HOME: '/h',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      CI: '1',
      AGENTS_GENERATOR_MODEL: 'm',
    });
    assert.deepEqual(env, { FORCE_COLOR: '0', PATH: '/bin', HOME: '/h' });
  });

  test('an existing task directory is never overwritten', async () => {
    const root = proposalsRoot();
    await run(replying(readyOutput()), {}, { root });
    const second = await run(replying(readyOutput()), {}, { root });
    assert.equal(second.exitCode, 4);
    assert.match(second.lines.join('\n'), /task directory already exists/);
  });

  test('the approved repository is unchanged by every Generator run', () => {
    assert.equal(fingerprint(), repoBefore);
  });
});
