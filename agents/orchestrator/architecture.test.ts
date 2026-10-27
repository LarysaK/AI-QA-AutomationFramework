import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { generate, type ValidatorRunner } from './generator/generate';
import type { ModelClient } from './generator/model-client';
import { heal } from './healer/heal';
import { plan } from './planner/plan';
import { createSchemaGuard, PAYLOAD_SCHEMA_PATHS } from './validation/schema-guard';
import type { ScriptRunner } from './validation/static-guard';
import type { GuardResult } from './validation/types';
import {
  ENVELOPE_SCHEMA_PATH,
  EXECUTION_CAPABLE_GUARDS,
  outcomeOf,
  validateArtifact,
} from './validation/validate';

/**
 * The three-agent architecture of Agent Standard 2.0: exactly three agents (Planner, Generator,
 * Healer), the Validator as deterministic code that is not an agent, and the retired Analyzer
 * contracts rejected rather than reinterpreted. The model is always a fake; no provider is
 * contacted. Each agent stages its proposal in a temporary proposals root, and the real validator
 * checks it without execution authorization (H7 closed); nothing is applied or executed.
 */

const REPO = resolve('.');
const AGENTS = ['generator', 'healer', 'planner'];
const NOW = new Date('2026-10-27T09:00:00Z');
const HEALER_FIXTURES = 'agents/orchestrator/healer/fixtures';
const PLANNER_FIXTURE = 'agents/orchestrator/planner/fixtures/req-009-plan.json';
const GENERATOR_FIXTURE = 'agents/orchestrator/generator/fixtures/tc-003-07.spec.ts.txt';
const HEALER_OUTPUT = `${HEALER_FIXTURES}/approve-strict-mode.output.json`;
const HEALER_REPORT = `${HEALER_FIXTURES}/synthetic-approve-strict-mode.report.json`;
const APPROVE = 'tests/requestflow/e2e/approve-request.spec.ts:17';

type Json = Record<string, unknown>;
const read = (path: string): string => readFileSync(join(REPO, path), 'utf8');
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const sha256 = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(join(REPO, path)))
    .digest('hex');
const SCHEMA = JSON.parse(read(ENVELOPE_SCHEMA_PATH)) as {
  properties: {
    artifactType: { enum: string[] };
    agent: { properties: { name: { enum: string[] } } };
  };
};
const STANDARD = read('agents/standard/standard.md');

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const temporary = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-architecture-'));
  roots.push(dir);
  return dir;
};

const replying = (value: unknown): ModelClient => ({
  generate: () =>
    Promise.resolve({
      text: JSON.stringify(value),
      stopReason: 'end_turn',
      servedModel: 'fake-model-output',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
});
/** Stands in for the validator child process; the real validator runs in each test below. */
const stubValidator: ValidatorRunner = () => ({
  exitCode: 3,
  output: 'Result: INCOMPLETE (execution authorization required)\n',
});
/** G-STATIC's real checks are covered in static-guard.test.ts; here every script passes. */
const passingScripts: ScriptRunner = () => ({ exitCode: 0, output: '', timedOut: false });
const validate = (document: unknown): GuardResult[] =>
  validateArtifact(document, { repoRoot: REPO, runScript: passingScripts });
const statusOf = (results: readonly GuardResult[], guard: string): string | undefined =>
  results.find((r) => r.guard === guard)?.status;

/** The working tree, index and untracked files of the repository. */
function fingerprint(): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return createHash('sha256')
    .update(git('status', '--porcelain=v1', '-uall'))
    .update(git('ls-files', '-s'))
    .digest('hex');
}
const repoBefore = fingerprint();
const proposalsBefore = existsSync(join(REPO, 'artifacts', 'proposals'));

/** One staged, valid artifact per agent, produced offline from the committed fixtures. */
const staged: Record<'planner' | 'generator' | 'healer-repair' | 'healer-diagnosis', Json> = {
  planner: {},
  generator: {},
  'healer-repair': {},
  'healer-diagnosis': {},
};

before(async () => {
  const planned = await plan(
    {
      repoRoot: REPO,
      app: 'requestflow',
      requirements: ['REQ-009'],
      proposalsRoot: temporary(),
      offline: { source: PLANNER_FIXTURE, sha256: sha256(PLANNER_FIXTURE) },
    },
    { modelClient: replying(JSON.parse(read(PLANNER_FIXTURE))), now: () => NOW, env: {} },
  );
  const generated = await generate(
    {
      repoRoot: REPO,
      app: 'requestflow',
      testCase: 'TC-003-07',
      allowReferenced: false,
      proposalsRoot: temporary(),
      offline: { source: GENERATOR_FIXTURE, sha256: sha256(GENERATOR_FIXTURE) },
    },
    {
      modelClient: replying({
        status: 'READY',
        summary: 'Adds TC-003-07: a second submit returns 409 and leaves the request unchanged.',
        testFile: {
          path: 'tests/requestflow/api/submit-already-submitted.spec.ts',
          content: read(GENERATOR_FIXTURE),
          rationale: 'Follows CAN-003.',
        },
        canonicalPatterns: ['CAN-003'],
        assumptions: [],
        findings: [],
        contextRequests: [],
      }),
      runValidator: stubValidator,
      now: () => NOW,
      env: {},
    },
  );
  const healerRun = (output: Json) =>
    heal(
      {
        repoRoot: REPO,
        app: 'requestflow',
        report: join(REPO, HEALER_REPORT),
        test: APPROVE,
        proposalsRoot: temporary(),
        offline: { source: HEALER_OUTPUT, sha256: sha256(HEALER_OUTPUT) },
      },
      { modelClient: replying(output), runValidator: stubValidator, now: () => NOW, env: {} },
    );
  const output = JSON.parse(read(HEALER_OUTPUT)) as Json;
  const repaired = await healerRun(output);
  const diagnosed = await healerRun({
    ...output,
    summary: 'Diagnosis only: the evidence is not enough to propose a repair.',
    diagnosis: {
      ...(output['diagnosis'] as Json),
      classification: 'insufficient-evidence',
      alternatives: [],
      missingEvidence: ['A trace of the details page at the time of failure.'],
    },
    repair: null,
  });

  for (const [key, result] of [
    ['planner', planned],
    ['generator', generated],
    ['healer-repair', repaired],
    ['healer-diagnosis', diagnosed],
  ] as const) {
    assert.ok(result.taskDir, `${key}: staged (${result.lines.join(' | ')})`);
    staged[key] = readJson(join(result.taskDir, 'artifact.json'));
  }
});

// ---------------------------------------------------------------- the three agents

describe('Agent Standard 2.0: exactly three agents', () => {
  test('the envelope schema, the Standard and the definitions name the same three agents', () => {
    assert.deepEqual([...SCHEMA.properties.agent.properties.name.enum].sort(), AGENTS);
    const roles = /^\| Agent +\| An LLM-backed role \(([^)]*)\)/m.exec(STANDARD)?.[1];
    assert.equal(roles, 'Planner, Generator, Healer');
    const rows = [
      ...STANDARD.matchAll(/^\| (Planner|Generator|Healer|Analyzer) +\| `([a-z-]+)`/gm),
    ];
    assert.deepEqual(
      rows.map((m) => [m[1], m[2]]),
      [
        ['Planner', 'test-plan-proposal'],
        ['Generator', 'test-proposal'],
        ['Healer', 'heal-proposal'],
      ],
    );
    assert.deepEqual(
      readdirSync(join(REPO, 'agents/definitions'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
      AGENTS,
    );
    for (const agent of AGENTS) {
      const definition = read(`agents/definitions/${agent}/definition.md`);
      assert.match(definition, new RegExp(`^\\| Agent +\\| \`${agent}\` +\\|`, 'm'));
      assert.match(definition, /^\| Requires standard \| Agent Standard 2\.x /m);
    }
  });

  test('each of the three artifact types is bound to exactly one agent', () => {
    assert.deepEqual(SCHEMA.properties.artifactType.enum, [
      'test-plan-proposal',
      'test-proposal',
      'heal-proposal',
    ]);
    const owner: Record<string, string> = {
      'test-plan-proposal': 'planner',
      'test-proposal': 'generator',
      'heal-proposal': 'healer',
    };
    for (const [type, agent] of Object.entries(owner)) {
      for (const other of AGENTS.filter((a) => a !== agent)) {
        const results = validate({
          ...staged.generator,
          artifactType: type,
          agent: { name: other, definitionVersion: '1.1' },
        });
        assert.equal(statusOf(results, 'G-SCHEMA'), 'failed', `${type} by ${other}`);
      }
    }
  });

  test('the Validator is not an agent: it is not in the agent list and cannot author an artifact', () => {
    assert.ok(!SCHEMA.properties.agent.properties.name.enum.includes('validator'));
    assert.match(STANDARD, /The Validator is deterministic code in the orchestrator, not an agent/);
    assert.match(STANDARD, /it contains no AI and is not\s+counted among the agents/);
    const results = validate({
      ...staged.generator,
      agent: { name: 'validator', definitionVersion: '1.1' },
    });
    assert.equal(statusOf(results, 'G-SCHEMA'), 'failed');
    assert.ok(results.slice(1).every((r) => r.status === 'skipped'));
  });

  test('unsupported agent names are rejected', () => {
    for (const name of ['analyzer', 'validator', 'reviewer', 'Healer', 'orchestrator', '']) {
      const results = validate({ ...staged.generator, agent: { name, definitionVersion: '1.1' } });
      assert.equal(statusOf(results, 'G-SCHEMA'), 'failed', name);
    }
  });
});

// ---------------------------------------------------------------- valid proposals, H7 closed

describe('Agent Standard 2.0: the three agents produce valid 2.0 artifacts', () => {
  for (const key of ['planner', 'generator', 'healer-repair', 'healer-diagnosis'] as const) {
    test(`${key}: valid up to the H7 boundary; execution-capable guards are not authorized`, () => {
      const artifact = staged[key];
      assert.equal(artifact['schemaVersion'], '2.0');
      assert.equal(artifact['standardVersion'], '2.0');
      assert.equal((artifact['agent'] as Json)['definitionVersion'], '1.1');
      const results = validate(artifact);
      for (const guard of ['G-SCHEMA', 'G-PATHS', 'G-BASE', 'G-TRACE', 'G-STATIC']) {
        assert.equal(
          statusOf(results, guard),
          'passed',
          `${key} ${guard}: ${JSON.stringify(results)}`,
        );
      }
      for (const guard of EXECUTION_CAPABLE_GUARDS) {
        assert.equal(statusOf(results, guard), 'not-authorized');
      }
      assert.equal(outcomeOf(results), 'incomplete');
    });
  }

  test('a Healer diagnosis proposes no change, and a Healer repair is reviewed at H3', () => {
    const diagnosis = staged['healer-diagnosis'];
    assert.equal(diagnosis['artifactType'], 'heal-proposal');
    assert.deepEqual(diagnosis['proposedChanges'], []);
    assert.equal((diagnosis['payload'] as Json)['repair'], null);
    const repair = staged['healer-repair'];
    assert.equal((repair['proposedChanges'] as unknown[]).length, 1);
    assert.deepEqual((repair['payload'] as Json)['repair'], {
      ...((repair['payload'] as Json)['repair'] as Json),
      humanReview: 'required',
      reviewGate: 'H3',
    });
  });

  test('a mismatched execution authorization still runs no execution-capable guard', () => {
    const results = validateArtifact(staged['healer-repair'], {
      repoRoot: REPO,
      runScript: passingScripts,
      artifactSha256: 'a'.repeat(64),
      executionAuthorization: 'b'.repeat(64),
    });
    for (const guard of EXECUTION_CAPABLE_GUARDS) {
      assert.equal(statusOf(results, guard), 'not-authorized');
    }
  });
});

// ---------------------------------------------------------------- retired contracts

describe('Agent Standard 2.0: retired Analyzer contracts are rejected, never reinterpreted', () => {
  const rejected = (document: unknown, reason: RegExp): void => {
    const results = validate(document);
    const schema = results[0];
    assert.equal(schema?.guard, 'G-SCHEMA');
    assert.equal(schema.status, 'failed');
    assert.ok(
      schema.failures.some((f) => f.ruleIds.includes('STD-ART-001') && reason.test(f.reason)),
      JSON.stringify(schema.failures),
    );
    // Nothing else runs: no path, trace or Healer rule is applied to a legacy artifact.
    assert.ok(results.slice(1).every((r) => r.status === 'skipped'));
  };

  test('a legacy Analyzer failure-analysis artifact', () => {
    rejected(
      {
        ...staged['healer-diagnosis'],
        artifactType: 'failure-analysis',
        agent: { name: 'analyzer', definitionVersion: '1.0' },
      },
      /"analyzer" is retired \(Agent Standard 2\.0\)/,
    );
  });

  test('a failure-analysis artifact claimed by the Healer is not read as a heal-proposal', () => {
    rejected(
      { ...staged['healer-diagnosis'], artifactType: 'failure-analysis' },
      /"failure-analysis" is retired \(Agent Standard 2\.0\): failure diagnosis is a Healer heal-proposal/,
    );
  });

  test('a heal-proposal claimed by the Analyzer', () => {
    rejected(
      { ...staged['healer-diagnosis'], agent: { name: 'analyzer', definitionVersion: '1.1' } },
      /"analyzer" is retired/,
    );
  });

  test('an envelope of major version 1, even from a current agent', () => {
    rejected(
      { ...staged.generator, schemaVersion: '1.0', standardVersion: '1.2' },
      /\/schemaVersion "1\.0" is a retired major version 1/,
    );
    rejected({ ...staged.planner, standardVersion: '1.2' }, /\/standardVersion "1\.2"/);
  });

  test('an unknown major version is rejected by the schema', () => {
    const results = validate({ ...staged.generator, schemaVersion: '3.0' });
    assert.equal(statusOf(results, 'G-SCHEMA'), 'failed');
  });

  test('the ANA- rule prefix is retired', () => {
    const finding = {
      id: 'F-001',
      kind: 'risk',
      severity: 'info',
      message: 'x',
      ruleIds: ['ANA-001'],
    };
    const results = validate({ ...staged.planner, findings: [finding] });
    assert.equal(statusOf(results, 'G-SCHEMA'), 'failed');
  });
});

// ---------------------------------------------------------------- fail closed, no mutation

describe('Agent Standard 2.0: payload schemas fail closed', () => {
  test('every listed payload schema is committed, and a missing one rejects its artifacts', () => {
    for (const path of Object.values(PAYLOAD_SCHEMA_PATHS))
      assert.ok(existsSync(join(REPO, path)), path);
    const guard = createSchemaGuard(join(REPO, ENVELOPE_SCHEMA_PATH), {
      'heal-proposal': join(REPO, 'agents/definitions/healer/missing.schema.json'),
      'test-plan-proposal': join(REPO, 'agents/definitions/planner/missing.schema.json'),
    });
    for (const key of ['healer-repair', 'planner'] as const) {
      const result = guard(staged[key]);
      assert.equal(result.status, 'failed');
      assert.match(result.failures[0]?.reason ?? '', /payload schema for .* cannot be loaded/);
    }
  });
});

describe('Agent Standard 2.0: no autonomous execution or repair', () => {
  test('running and validating every agent left the repository unchanged', () => {
    assert.equal(fingerprint(), repoBefore);
    assert.equal(existsSync(join(REPO, 'artifacts', 'proposals')), proposalsBefore);
  });
});
