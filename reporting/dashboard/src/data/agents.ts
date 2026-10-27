/**
 * The AI agent layer as the repository records it: which components exist, what is implemented
 * and tested, which guards and human approval gates apply, and whether a real AI model is used.
 *
 * Every statement carries evidence in a committed file. build/agent-layer-plugin.ts checks all
 * of it against the commit being built (each quote must appear in its file, each absent path must
 * have no committed file, each tracked file must be committed, each excluded text must not
 * appear), and also that every guard and gate row matches the Agent Standard's own tables. A
 * statement that no longer holds fails the build; nothing is embedded unchecked.
 *
 * Deliberately absent: agent execution history, model usage, tokens, costs, proposals, approval
 * events and success rates. The repository records none of them (see NOT_RECORDED).
 */

export type Evidence =
  /** The file at the commit contains this text (whitespace-insensitive). */
  | { readonly path: string; readonly quote: string }
  /** The file at the commit does not contain this text. */
  | { readonly path: string; readonly excludes: string }
  /** The file is committed. */
  | { readonly path: string; readonly tracked: true }
  /** No committed file is at or under this path. */
  | { readonly path: string; readonly absent: true };

export interface Fact {
  readonly text: string;
  readonly evidence: readonly Evidence[];
}

export type ComponentStatus = 'implemented' | 'specified-only';

export interface Component {
  readonly id: string;
  readonly name: string;
  readonly kind: 'AI agent' | 'Deterministic validator';
  readonly status: ComponentStatus;
  readonly purpose: Fact;
  readonly responsibilities: readonly Fact[];
  readonly code: Fact;
  readonly tests: Fact;
  readonly approval: Fact;
}

export type GuardId =
  'G-SCHEMA' | 'G-PATHS' | 'G-BASE' | 'G-TRACE' | 'G-STATIC' | 'G-DISCOVERY' | 'G-RUN';

export interface Guard {
  readonly id: GuardId;
  /** Verbatim from the Agent Standard's guard table. */
  readonly checks: string;
  readonly executionCapable: boolean;
  readonly implementation: string;
  readonly tests: Fact;
}

export type GateId = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7';

export interface Gate {
  readonly id: GateId;
  /** Verbatim from the Agent Standard's gate table. */
  readonly requires: string;
  /** How the gate stands in this repository today. */
  readonly here: Fact;
}

export interface AgentLayer {
  readonly standard: Fact;
  readonly principle: Fact;
  /** What the standard counts as an agent; the AI-agent components must be exactly these roles. */
  readonly agentRoles: Fact;
  /** The Validator: deterministic code, not an agent and not counted among them. */
  readonly validatorRole: Fact;
  /** The Analyzer of Agent Standard 1.x: retired, never implemented. */
  readonly retired: Fact;
  readonly components: readonly Component[];
  readonly guards: readonly Guard[];
  readonly gates: readonly Gate[];
  readonly modelExecution: {
    /** The current H7 status. */
    readonly h7: Fact;
    readonly liveModeInCode: Fact;
    readonly ci: Fact;
    readonly fakeModelTests: Fact;
    readonly liveRuns: Fact;
    /** A historical local demonstration; neither a live run nor a current authorization. */
    readonly offlineDemo: Fact;
  };
  readonly notRecorded: readonly Fact[];
  readonly defectCandidates: Fact;
}

/** The agent layer facts, embedded only after build/agent-layer-plugin.ts has checked them. */
export interface VerifiedAgentLayer {
  /** The commit whose committed files the evidence was checked against. */
  readonly commit: string;
  readonly layer: AgentLayer;
}

const STANDARD = 'agents/standard/standard.md';
const README = 'README.md';
const GENERATOR_DOC = 'docs/generator-agent.md';
const GENERATOR_DEF = 'agents/definitions/generator/definition.md';
const ADR = 'docs/adr/0001-ai-outside-test-runtime.md';
const CI = '.github/workflows/ci.yml';
const PACKAGE = 'package.json';
const GEN = 'agents/orchestrator/generator';
const PLAN = 'agents/orchestrator/planner';
const PLANNER_DEF = 'agents/definitions/planner/definition.md';
const HEAL = 'agents/orchestrator/healer';
const HEALER_DEF = 'agents/definitions/healer/definition.md';
const VAL = 'agents/orchestrator/validation';

export const AGENT_LAYER: AgentLayer = {
  standard: {
    text: 'Agent Standard v2.0 (frozen) is the shared contract for the three agents and for the orchestrator, including the Validator.',
    evidence: [
      { path: STANDARD, quote: '# Agent Standard v2.0' },
      { path: STANDARD, quote: '| Status | Frozen |' },
      {
        path: STANDARD,
        quote:
          '| Applies to | Planner, Generator, Healer, and the orchestrator, including the Validator |',
      },
    ],
  },
  principle: {
    text: 'AI proposes, deterministic code validates, a human approves. AI agents are outside the deterministic Playwright runtime: the product tests never import or call an agent or an LLM SDK.',
    evidence: [
      {
        path: STANDARD,
        quote: '**AI proposes, deterministic code validates, a human approves** (ADR-0001).',
      },
      { path: ADR, quote: '**AI agents are outside the deterministic Playwright runtime.**' },
      {
        path: 'eslint.config.mjs',
        quote: 'ADR-0001: runtime code must not import the agent layer (agents/**).',
      },
      {
        path: `${GEN}/eslint-boundary.test.ts`,
        quote: "describe('ADR-0001 import boundary (ESLint)'",
      },
    ],
  },
  agentRoles: {
    text: 'The Agent Standard defines exactly three AI agents, each an LLM-backed role that produces one artifact type: Planner, Generator and Healer.',
    evidence: [
      {
        path: STANDARD,
        quote:
          '| Agent | An LLM-backed role (Planner, Generator, Healer) that reads and proposes |',
      },
      { path: STANDARD, quote: 'There are exactly three agents.' },
      {
        path: README,
        quote:
          '[Agent Standard v2.0](agents/standard/standard.md) defines **three AI agents**, **Planner**, **Generator** and **Healer**, and one **deterministic Validator**, which is not an AI agent and is never counted as one.',
      },
      {
        path: 'agents/standard/envelope.schema.json',
        quote: '"enum": ["planner", "generator", "healer"]',
      },
    ],
  },
  validatorRole: {
    text: 'The Validator is not an AI agent and is not counted among them: it is deterministic code in the orchestrator that runs the guards, contains no AI and never mutates approved repository state.',
    evidence: [
      {
        path: STANDARD,
        quote:
          "| Validator | The orchestrator's deterministic validation component that runs the guards; not an agent |",
      },
      {
        path: STANDARD,
        quote:
          'The Validator is deterministic code in the orchestrator, not an agent: it contains no AI and is not counted among the agents.',
      },
    ],
  },
  retired: {
    text: 'The Analyzer agent of Agent Standard 1.x is retired: failure diagnosis is part of the Healer. It was never implemented, and the validator rejects Analyzer and failure-analysis artifacts instead of reinterpreting them.',
    evidence: [
      {
        path: STANDARD,
        quote:
          'The Analyzer agent and its `failure-analysis` artifact type are removed; failure diagnosis is part of the Healer',
      },
      { path: 'agents/definitions/analyzer', absent: true },
      { path: 'agents/orchestrator/analyzer', absent: true },
      {
        path: `${VAL}/schema-guard.ts`,
        quote: 'export function legacyContractFailures(document: unknown): GuardFailure[] {',
      },
      { path: `${VAL}/schema-guard.ts`, quote: 'They are rejected with' },
    ],
  },
  components: [
    {
      id: 'planner',
      name: 'Planner agent',
      kind: 'AI agent',
      status: 'implemented',
      purpose: {
        text: 'Proposes test-planning additions for explicitly selected, approved requirements: new test cases with provisional IDs and suggested automation candidates. It never changes the requirements or the test plan and never approves its own proposal.',
        evidence: [
          { path: PLANNER_DEF, quote: 'The Planner proposes **test-planning additions**' },
          {
            path: STANDARD,
            quote:
              'Only the Planner may propose new TC IDs; they are provisional, are carried in the Planner payload, and become approved only through gate H1.',
          },
        ],
      },
      responsibilities: [
        {
          text: 'Treats the selected requirement and test-plan text as untrusted data: instruction-like text stops the run before any model call.',
          evidence: [{ path: PLANNER_DEF, quote: '**Untrusted text screen.**' }],
        },
        {
          text: 'Builds a deterministic context pack of at most 64 KB, never truncated, with a manifest of every source.',
          evidence: [
            {
              path: PLANNER_DEF,
              quote: '## Context selection (deterministic; hard limit 64 KB; no truncation)',
            },
          ],
        },
        {
          text: 'Checks every proposal deterministically (payload schema and rules PLN-001 – PLN-006) and stages it for human review at H1; a rejected proposal is recorded with its reasons and never staged for review.',
          evidence: [
            {
              path: PLANNER_DEF,
              quote:
                'Checked deterministically by G-SCHEMA (payload schema) and G-TRACE (Planner content)',
            },
            { path: `${VAL}/planner-guard.ts`, tracked: true },
          ],
        },
        {
          text: 'Offline only in v1: it reads a recorded model output and makes no model call.',
          evidence: [
            {
              path: PLANNER_DEF,
              quote:
                'Offline only: `--fake-model-output` is required, and no live model call has been made.',
            },
            {
              path: `${PLAN}/cli.ts`,
              quote: 'Planner v1 is offline-only: --fake-model-output <file> is required',
            },
          ],
        },
      ],
      code: {
        text: 'Definition, output and payload schemas and prompt in agents/definitions/planner/; orchestrator in agents/orchestrator/planner/ (npm run agents:plan).',
        evidence: [
          { path: PLANNER_DEF, tracked: true },
          { path: 'agents/definitions/planner/planner-output.schema.json', tracked: true },
          { path: 'agents/definitions/planner/planner-payload.schema.json', tracked: true },
          { path: 'agents/definitions/planner/prompt.md', tracked: true },
          { path: `${PLAN}/plan.ts`, tracked: true },
          { path: PACKAGE, quote: '"agents:plan": "tsx agents/orchestrator/planner/cli.ts"' },
        ],
      },
      tests: {
        text: 'Automated tests with a fake model: no provider is contacted. Part of the agent suite in CI.',
        evidence: [
          {
            path: `${PLAN}/planner.test.ts`,
            quote: 'The model is always a fake; no provider is contacted',
          },
          { path: PACKAGE, quote: 'agents/orchestrator/planner/planner.test.ts' },
        ],
      },
      approval: {
        text: 'H1: a staged proposal is reviewed by a human. There is no apply workflow; an accepted proposal reaches the test plan only as an ordinary, reviewed commit by a human.',
        evidence: [
          { path: PLANNER_DEF, quote: 'A staged proposal is reviewed by a human at gate **H1**.' },
          {
            path: PLANNER_DEF,
            quote:
              'There is no apply workflow: an approved proposal reaches `specs/<app>/test-plan.md` only as an ordinary, reviewed commit by a human',
          },
        ],
      },
    },
    {
      id: 'generator',
      name: 'Generator agent',
      kind: 'AI agent',
      status: 'implemented',
      purpose: {
        text: 'Proposes exactly one new Playwright TypeScript test file for one explicitly selected, approved test case.',
        evidence: [
          {
            path: GENERATOR_DEF,
            quote:
              'The Generator proposes **exactly one new Playwright TypeScript test file** for one explicitly selected, approved test case.',
          },
          { path: GENERATOR_DEF, quote: 'definitionVersion: 1.1' },
        ],
      },
      responsibilities: [
        {
          text: 'Selects the test case deterministically before any model call: it must be in the approved test plan with Automation: Yes.',
          evidence: [
            {
              path: GENERATOR_DEF,
              quote: '## Preconditions (deterministic, before any model call)',
            },
          ],
        },
        {
          text: 'Builds a deterministic context pack of at most 64 KB, never truncated, with a manifest of every source.',
          evidence: [
            { path: GENERATOR_DOC, quote: 'a deterministic pack, at most 64 KB, never truncated' },
          ],
        },
        {
          text: 'Makes one model call, then rejects refusals, invalid JSON and schema violations; model output is never repaired.',
          evidence: [
            { path: GENERATOR_DOC, quote: 'one call through the `ModelClient` interface' },
            { path: GENERATOR_DOC, quote: 'Model output is never repaired.' },
          ],
        },
        {
          text: 'Stages the proposal under artifacts/proposals/ (gitignored) and runs the validator without execution authorization. It never edits the repository and never applies a proposal.',
          evidence: [
            {
              path: GENERATOR_DOC,
              quote:
                'The Generator never edits the repository. It stages a proposal under `artifacts/proposals/<taskId>/`, runs the validator without execution authorization, and stops.',
            },
            {
              path: `${GEN}/generate.ts`,
              quote: 'never applies a proposal and never supplies H7 execution authorization.',
            },
            { path: '.gitignore', quote: 'artifacts/*' },
          ],
        },
      ],
      code: {
        text: 'Definition, output schema and prompt in agents/definitions/generator/; orchestrator in agents/orchestrator/generator/ (npm run agents:generate).',
        evidence: [
          { path: GENERATOR_DEF, tracked: true },
          { path: 'agents/definitions/generator/generator-output.schema.json', tracked: true },
          { path: 'agents/definitions/generator/prompt.md', tracked: true },
          { path: `${GEN}/generate.ts`, tracked: true },
          { path: `${GEN}/model-client.ts`, tracked: true },
          { path: PACKAGE, quote: '"agents:generate": "tsx agents/orchestrator/generator/cli.ts"' },
        ],
      },
      tests: {
        text: 'Automated tests with a fake model: no provider is contacted. Part of the agent suite in CI.',
        evidence: [
          {
            path: `${GEN}/generator.test.ts`,
            quote: 'The model is always a fake; no provider is contacted.',
          },
          { path: PACKAGE, quote: 'agents/orchestrator/generator/generator.test.ts' },
        ],
      },
      approval: {
        text: 'Running a proposed test needs H7; applying it to tests/ needs H2. Both are separate human decisions.',
        evidence: [
          {
            path: GENERATOR_DOC,
            quote:
              'Running the proposed test (H7) and applying it to `tests/` (H2) are separate human decisions.',
          },
        ],
      },
    },
    {
      id: 'healer',
      name: 'Healer agent',
      kind: 'AI agent',
      status: 'implemented',
      purpose: {
        text: 'Diagnoses one Playwright test failure from explicitly supplied evidence and, when the evidence supports it, proposes a narrowly scoped repair for human review. It never applies a repair, never runs proposed code and never weakens or suppresses a test.',
        evidence: [
          {
            path: HEALER_DEF,
            quote:
              'The Healer **diagnoses one Playwright test failure** from explicitly supplied evidence',
          },
          { path: STANDARD, quote: '| H3 | Healing patches, after validation (Healer) |' },
        ],
      },
      responsibilities: [
        {
          text: 'Accepts only authentic failure evidence: a Playwright JSON report in which the selected, committed test failed; otherwise it stops before any model call.',
          evidence: [{ path: HEALER_DEF, quote: '**Authentic failure evidence.**' }],
        },
        {
          text: 'Treats logs and source as untrusted data: instruction-like text, credentials and personal data stop the run before any model call.',
          evidence: [{ path: HEALER_DEF, quote: '**Untrusted text screen and secret scan.**' }],
        },
        {
          text: 'Classifies the failure (test code, test data or setup, application defect, environment, insufficient evidence); an application defect is escalated as a defect candidate, never worked around.',
          evidence: [
            {
              path: HEALER_DEF,
              quote: 'An application defect is never worked around in test code',
            },
          ],
        },
        {
          text: 'Checks every proposal deterministically (payload schema and rules HEA-001 – HEA-009: evidence, repair scope, no weakened checks, no suppression, no concealing waits, no claims); a repair is then validated without execution authorization.',
          evidence: [
            {
              path: HEALER_DEF,
              quote:
                'Checked deterministically by G-SCHEMA (payload schema) and G-TRACE (Healer content)',
            },
            { path: `${VAL}/healer-guard.ts`, tracked: true },
          ],
        },
        {
          text: 'Offline only in v1: it reads a recorded model output and makes no model call.',
          evidence: [
            {
              path: HEALER_DEF,
              quote:
                'Offline only: `--fake-model-output` is required, and no live model call has been made.',
            },
            {
              path: `${HEAL}/cli.ts`,
              quote: 'Healer v1 is offline-only: --fake-model-output <file> is required',
            },
          ],
        },
      ],
      code: {
        text: 'Definition, output and payload schemas and prompt in agents/definitions/healer/; orchestrator in agents/orchestrator/healer/ (npm run agents:heal).',
        evidence: [
          { path: HEALER_DEF, tracked: true },
          { path: 'agents/definitions/healer/healer-output.schema.json', tracked: true },
          { path: 'agents/definitions/healer/healer-payload.schema.json', tracked: true },
          { path: 'agents/definitions/healer/prompt.md', tracked: true },
          { path: `${HEAL}/heal.ts`, tracked: true },
          { path: PACKAGE, quote: '"agents:heal": "tsx agents/orchestrator/healer/cli.ts"' },
        ],
      },
      tests: {
        text: 'Automated tests with a fake model and synthetic failure reports: no provider is contacted, nothing is applied. Part of the agent suite in CI.',
        evidence: [
          {
            path: `${HEAL}/healer.test.ts`,
            quote: 'The model is always a fake; no provider is contacted',
          },
          { path: PACKAGE, quote: 'agents/orchestrator/healer/healer.test.ts' },
        ],
      },
      approval: {
        text: 'A diagnosis needs no approval. A repair needs a human H7 authorization for its execution-capable guards (closed) and approval at H3 to be applied, as an ordinary reviewed commit.',
        evidence: [
          {
            path: HEALER_DEF,
            quote: 'A diagnosis is a report: no approval is needed to stage it.',
          },
          { path: HEALER_DEF, quote: 'and applying it needs gate **H3**' },
        ],
      },
    },
    {
      id: 'validator',
      name: 'Validator',
      kind: 'Deterministic validator',
      status: 'implemented',
      purpose: {
        text: 'Validates one agent artifact against the repository with seven deterministic guards. No AI is involved, and it is read-only.',
        evidence: [
          {
            path: `${VAL}/cli.ts`,
            quote:
              'Validates one agent artifact against the repository in the current directory. Read-only.',
          },
          {
            path: README,
            quote:
              '- [x] Deterministic validator with seven guards and human execution authorization (H7)',
          },
        ],
      },
      responsibilities: [
        {
          text: 'Runs the guards in order and stops at the first failing guard.',
          evidence: [
            {
              path: `${VAL}/validate.ts`,
              quote: 'Runs the implemented guards in order and stops at the first failing guard;',
            },
          ],
        },
        {
          text: 'Never runs proposed code without H7: the execution-capable guards G-DISCOVERY and G-RUN run only with a human authorization for the exact artifact SHA-256, given on the command line and never read from the artifact or the environment.',
          evidence: [
            {
              path: `${VAL}/validate.ts`,
              quote:
                "export const EXECUTION_CAPABLE_GUARDS: readonly GuardName[] = ['G-DISCOVERY', 'G-RUN'];",
            },
            {
              path: `${VAL}/validate.ts`,
              quote:
                '// Execution boundary (gate H7): nothing below runs proposed code without authorization.',
            },
            {
              path: `${VAL}/cli.ts`,
              quote: 'the SHA-256 of the exact artifact bytes, given on the',
            },
            {
              path: `${VAL}/cli.ts`,
              quote: 'It is never read from the artifact or the environment.',
            },
          ],
        },
        {
          text: 'Without H7 the result is INCOMPLETE (exit 3), never VALIDATED.',
          evidence: [
            { path: GENERATOR_DOC, quote: 'Without H7 the validator ends `INCOMPLETE` (exit 3).' },
          ],
        },
      ],
      code: {
        text: 'agents/orchestrator/validation/ (npm run agents:validate).',
        evidence: [
          { path: `${VAL}/validate.ts`, tracked: true },
          {
            path: PACKAGE,
            quote: '"agents:validate": "tsx agents/orchestrator/validation/cli.ts"',
          },
        ],
      },
      tests: {
        text: 'Automated tests of every guard and of the H7 boundary. Deterministic: no model is involved. Part of the agent suite in CI.',
        evidence: [
          {
            path: PACKAGE,
            quote: '"agents:test": "tsx --test agents/orchestrator/validation/validate.test.ts',
          },
          {
            path: `${VAL}/discovery-guard.test.ts`,
            quote: "describe('execution authorization (gate H7)'",
          },
          {
            path: `${VAL}/cli.test.ts`,
            quote: "describe('agents:validate CLI and execution authorization'",
          },
        ],
      },
      approval: {
        text: 'H7 before any execution-capable guard runs proposed code. Authorizing execution does not approve applying the change.',
        evidence: [
          {
            path: STANDARD,
            quote:
              'H7 is distinct from H2 and H3: authorizing execution lets proposed code run for validation',
          },
        ],
      },
    },
  ],
  guards: [
    {
      id: 'G-SCHEMA',
      checks: 'Envelope, and payload once a payload schema exists',
      executionCapable: false,
      implementation: `${VAL}/schema-guard.ts`,
      tests: {
        text: 'validate.test.ts',
        evidence: [{ path: `${VAL}/validate.test.ts`, quote: "describe('G-SCHEMA'" }],
      },
    },
    {
      id: 'G-PATHS',
      checks:
        'Path class and `changeKind` permitted for the agent; Protected untouched; default deny',
      executionCapable: false,
      implementation: `${VAL}/path-guard.ts`,
      tests: {
        text: 'validate.test.ts',
        evidence: [{ path: `${VAL}/validate.test.ts`, quote: "describe('G-PATHS'" }],
      },
    },
    {
      id: 'G-BASE',
      checks: '`modify` has a matching `baseSha`; `create` targets a non-existent file',
      executionCapable: false,
      implementation: `${VAL}/base-guard.ts`,
      tests: {
        text: 'validate.test.ts',
        evidence: [{ path: `${VAL}/validate.test.ts`, quote: "describe('G-BASE'" }],
      },
    },
    {
      id: 'G-TRACE',
      checks:
        "Cited IDs exist; new tests' tags match declared TCs; no `@CAN`; modified tests keep their tags",
      executionCapable: false,
      implementation: `${VAL}/trace-guard.ts`,
      tests: {
        text: 'trace-guard.test.ts',
        evidence: [{ path: `${VAL}/trace-guard.test.ts`, quote: "describe('G-TRACE: failing'" }],
      },
    },
    {
      id: 'G-STATIC',
      checks: '`typecheck`, `lint` and `format:check` on the proposed state',
      executionCapable: false,
      implementation: `${VAL}/static-guard.ts`,
      tests: {
        text: 'static-guard.test.ts',
        evidence: [
          {
            path: `${VAL}/static-guard.test.ts`,
            quote: "describe('G-STATIC: real checks on a copy of this repository'",
          },
        ],
      },
    },
    {
      id: 'G-DISCOVERY',
      checks: '`playwright test --list` contains the new tests with their declared tags',
      executionCapable: true,
      implementation: `${VAL}/discovery-guard.ts`,
      tests: {
        text: 'discovery-guard.test.ts',
        evidence: [
          {
            path: `${VAL}/discovery-guard.test.ts`,
            quote: "describe('G-DISCOVERY: real Playwright listing'",
          },
        ],
      },
    },
    {
      id: 'G-RUN',
      checks:
        'Targeted run of the proposed test files, filtered by their declared `@TC-…` tags; the full suite when any `support-change` is present; "no tests to run" when there are neither test nor support changes',
      executionCapable: true,
      implementation: `${VAL}/run-guard.ts`,
      tests: {
        text: 'run-guard.test.ts',
        evidence: [
          { path: `${VAL}/run-guard.test.ts`, quote: "describe('G-RUN: real runs with the AUT'" },
        ],
      },
    },
  ],
  gates: [
    {
      id: 'H1',
      requires: 'Test-plan changes, including provisional TC IDs (Planner)',
      here: {
        text: 'Reachable: the Planner stages test-plan proposals for a human to review. No apply workflow exists; an accepted proposal reaches the test plan only as an ordinary, reviewed commit by a human.',
        evidence: [
          { path: PLANNER_DEF, quote: 'A staged proposal is reviewed by a human at gate **H1**.' },
          { path: README, quote: '- [ ] Proposal approval and apply workflow' },
        ],
      },
    },
    {
      id: 'H2',
      requires: 'Generated test and support changes, after validation (Generator)',
      here: {
        text: 'No apply workflow exists: a proposal reaches tests/ only as an ordinary, reviewed commit by a human.',
        evidence: [
          { path: README, quote: '- [ ] Proposal approval and apply workflow' },
          {
            path: GENERATOR_DOC,
            quote: 'applying it to `tests/` remains a manual, reviewed commit.',
          },
        ],
      },
    },
    {
      id: 'H3',
      requires: 'Healing patches, after validation (Healer)',
      here: {
        text: 'Reachable: the Healer stages healing patches. Their execution-capable guards wait for a human H7 authorization (closed), and no apply workflow exists; an accepted repair reaches the repository only as an ordinary, reviewed commit by a human.',
        evidence: [
          { path: HEALER_DEF, quote: 'and applying it needs gate **H3**' },
          { path: README, quote: '- [ ] Proposal approval and apply workflow' },
        ],
      },
    },
    {
      id: 'H4',
      requires: 'Requirements changes — humans only; agents may only raise findings',
      here: {
        text: 'Humans only: requirements are a Protected path, which G-PATHS denies to every agent.',
        evidence: [
          { path: STANDARD, quote: '| Protected | `specs/**/requirements.md`;' },
          { path: STANDARD, quote: '| None. Humans only, by normal PRs. |' },
        ],
      },
    },
    {
      id: 'H5',
      requires: 'Creating, changing or promoting a canonical test — humans only',
      here: {
        text: 'Humans only: files with a canonical test are Protected, and G-TRACE rejects an agent-added @CAN tag.',
        evidence: [
          { path: STANDARD, quote: 'any file containing a `@CAN-` test;' },
          {
            path: STANDARD,
            quote:
              'Agents never add a `@CAN-…` tag; only a human makes a test canonical (gate H5).',
          },
        ],
      },
    },
    {
      id: 'H6',
      requires: 'Changes to this standard, agent definitions or ADRs — humans only',
      here: {
        text: 'Humans only: agents/** and docs/adr/** are Protected paths.',
        evidence: [{ path: STANDARD, quote: '`.env*`; `agents/**`; `docs/adr/**` |' }],
      },
    },
    {
      id: 'H7',
      requires:
        'Execution authorization: before any execution-capable guard runs proposed code for validation (STD-AUTH-005)',
      here: {
        text: 'Closed. Enforced by the validator: no authorization is stored in the repository, and CI never authorizes execution.',
        evidence: [
          {
            path: `${VAL}/validate.ts`,
            quote:
              '// Execution boundary (gate H7): nothing below runs proposed code without authorization.',
          },
          { path: CI, excludes: '--authorize-execution' },
        ],
      },
    },
  ],
  modelExecution: {
    h7: {
      text: 'No execution authorization is in effect: none is stored in this repository, and CI never grants one. Without one, the validator runs no guard that executes proposed code. An authorization is given by a human, on the command line, for one exact artifact SHA-256, and is never read from the artifact or the environment. The documented offline demonstration did not open H7 for current use.',
      evidence: [
        {
          path: STANDARD,
          quote: 'bound to the exact artifact bytes: the SHA-256 of the raw artifact file.',
        },
        {
          path: STANDARD,
          quote: 'it is never read from the artifact or from environment variables.',
        },
        {
          path: STANDARD,
          quote: 'a persistent record of execution authorizations (who authorized what, and when).',
        },
        { path: CI, excludes: '--authorize-execution' },
      ],
    },
    liveModeInCode: {
      text: 'The Generator has a live mode in code: run locally by a human, npm run agents:generate makes one Anthropic API call, with credentials from that person’s environment. It is never run in CI or by this dashboard.',
      evidence: [
        {
          path: `${GEN}/model-client.ts`,
          quote: 'export function createAnthropicModelClient(): ModelClient {',
        },
        {
          path: `${GEN}/model-client.ts`,
          quote: 'Credentials are resolved by the SDK from the environment',
        },
        {
          path: GENERATOR_DOC,
          quote: 'npm run agents:generate -- --tc TC-003-07 # live: calls the model',
        },
        { path: CI, excludes: 'agents:generate' },
      ],
    },
    ci: {
      text: 'CI forbids model credentials and staged proposals: the run fails if a model API key is set or artifacts/proposals exists.',
      evidence: [
        { path: CI, quote: '- name: Guard (no model credentials, no staged proposals)' },
        { path: CI, quote: 'must not be set in CI"' },
        { path: CI, quote: 'echo "::error::staged AI proposals must not exist in CI"' },
      ],
    },
    fakeModelTests: {
      text: 'The agent suite in CI (Agent validation and generator tests) runs the validator’s deterministic tests and the Generator’s, the Planner’s and the Healer’s tests with a fake model.',
      evidence: [
        { path: CI, quote: '- name: Agent validation and generator tests' },
        { path: CI, quote: 'npm run --silent agents:test | tee artifacts/ci/agents.tap' },
        {
          path: `${GEN}/generator.test.ts`,
          quote: 'The model is always a fake; no provider is contacted.',
        },
        {
          path: `${PLAN}/planner.test.ts`,
          quote: 'The model is always a fake; no provider is contacted',
        },
        { path: PACKAGE, quote: 'agents/orchestrator/planner/planner.test.ts' },
        {
          path: `${HEAL}/healer.test.ts`,
          quote: 'The model is always a fake; no provider is contacted',
        },
        { path: PACKAGE, quote: 'agents/orchestrator/healer/healer.test.ts' },
      ],
    },
    liveRuns: {
      text: 'No live AI model run is recorded. The repository states that no live model call has been made yet, so the quality of real model output is unverified.',
      evidence: [
        {
          path: GENERATOR_DOC,
          quote: 'No live model call has been made yet; real-model output quality is unverified.',
        },
        { path: README, quote: '- [ ] A live Generator run (real model output)' },
      ],
    },
    offlineDemo: {
      text: 'The Generator documentation records one historical offline demonstration. A hand-written test fixture, not model output, was given to the Generator as a recorded output instead of a model call. A human then authorized execution under H7 for that one exact artifact, by its SHA-256, in a local validator run, and all seven guards passed. It was not a live AI model run, and it did not open H7: an authorization is given on the command line for one validator run of one exact artifact, is never stored, and is not in effect now. Its evidence is a local, gitignored record that is not part of this dashboard.',
      evidence: [
        { path: GENERATOR_DOC, quote: 'The demo test is a **hand-written fixture**' },
        { path: GENERATOR_DOC, quote: 'It was passed to the Generator with `--fake-model-output`' },
        {
          path: GENERATOR_DOC,
          quote: 'A human authorizes execution of one exact artifact by its SHA-256:',
        },
        { path: GENERATOR_DOC, quote: 'with human H7 authorization: **all seven guards passed**' },
        { path: `${VAL}/cli.ts`, quote: 'the SHA-256 of the exact artifact bytes, given on the' },
        { path: STANDARD, quote: 'Any change to the artifact invalidates the authorization.' },
        {
          path: STANDARD,
          quote: 'a persistent record of execution authorizations (who authorized what, and when).',
        },
        { path: CI, excludes: '--authorize-execution' },
        {
          path: GENERATOR_DOC,
          quote:
            'The demo proves the pipeline and its boundaries; it says nothing about the quality of real model output.',
        },
      ],
    },
  },
  notRecorded: [
    {
      text: 'Agent execution history: no agent run is recorded in the repository or in the published CI history.',
      evidence: [
        {
          path: GENERATOR_DOC,
          quote: 'The validator CLI prints its result but writes no persistent pipeline record;',
        },
        { path: CI, excludes: 'agents:generate' },
      ],
    },
    {
      text: 'Model usage, tokens and costs: no live model call has been made, and none is measured.',
      evidence: [{ path: GENERATOR_DOC, quote: 'No live model call has been made yet' }],
    },
    {
      text: 'AI-generated proposals: proposals are staged locally under the gitignored artifacts/ folder, are not in the repository and are never shown here.',
      evidence: [
        { path: '.gitignore', quote: 'artifacts/*' },
        { path: CI, quote: 'echo "::error::staged AI proposals must not exist in CI"' },
      ],
    },
    {
      text: 'Approval events: who authorized or approved what, and when, is not recorded. The standard defers a persistent record of execution authorizations.',
      evidence: [
        {
          path: STANDARD,
          quote: 'a persistent record of execution authorizations (who authorized what, and when).',
        },
        { path: GENERATOR_DOC, quote: 'Authorizations are not audited.' },
      ],
    },
    {
      text: 'Live AI success rates: with no live runs, there is nothing to measure.',
      evidence: [{ path: README, quote: '- [ ] A live Generator run (real model output)' }],
    },
  ],
  defectCandidates: {
    text: 'When the application contradicts a requirement, an agent records a defect-candidate finding in its proposal. It is a finding for human triage, not a defect.',
    evidence: [
      {
        path: STANDARD,
        quote:
          'When the application contradicts a requirement, record a `defect-candidate` finding. Never change an expected result to match the application.',
      },
      { path: 'agents/standard/envelope.schema.json', quote: '"defect-candidate"' },
    ],
  },
};

/** Every evidence item in the layer, including the guard and gate rows of the standard's tables. */
export function allEvidence(layer: AgentLayer): Evidence[] {
  const facts: Fact[] = [
    layer.standard,
    layer.principle,
    layer.agentRoles,
    layer.validatorRole,
    layer.retired,
    ...layer.components.flatMap((c) => [
      c.purpose,
      ...c.responsibilities,
      c.code,
      c.tests,
      c.approval,
    ]),
    ...layer.guards.map((g) => g.tests),
    ...layer.gates.map((g) => g.here),
    ...Object.values(layer.modelExecution),
    ...layer.notRecorded,
    layer.defectCandidates,
  ];
  return [
    ...facts.flatMap((fact) => fact.evidence),
    ...layer.guards.flatMap((g): Evidence[] => [
      {
        path: STANDARD,
        quote: `| ${g.id} | ${g.checks} | ${g.executionCapable ? '**Yes**' : 'No'} |`,
      },
      { path: g.implementation, tracked: true },
    ]),
    ...layer.gates.map((g): Evidence => ({ path: STANDARD, quote: `| ${g.id} | ${g.requires} |` })),
  ];
}

/** The distinct committed files the evidence refers to, sorted. */
export function evidencePaths(layer: AgentLayer): string[] {
  return [
    ...new Set(
      allEvidence(layer)
        .filter((e) => !('absent' in e))
        .map((e) => e.path),
    ),
  ].sort();
}

/** The distinct paths checked to have no committed files, sorted. */
export function absentPaths(layer: AgentLayer): string[] {
  return [
    ...new Set(
      allEvidence(layer)
        .filter((e) => 'absent' in e)
        .map((e) => e.path),
    ),
  ].sort();
}
