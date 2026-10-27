import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { ARTIFACTS, artifactName } from './handoff';

/**
 * Structure of the three workflows (.github/workflows): triggers, permissions, pinned actions,
 * the hand-off artifacts, the publisher's steps and the GitHub Pages deployment. Offline: the files are read as text with a
 * small step reader for this repository's two-space YAML layout.
 */

const REPO = resolve('.');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const HISTORY = readFileSync(join(REPO, '.github/workflows/ci-history.yml'), 'utf8');
const PAGES = readFileSync(join(REPO, '.github/workflows/pages.yml'), 'utf8');

const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';
const DOWNLOAD = 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2';
const MAIN_PUSH_OR_DISPATCH =
  "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'";

interface Step {
  readonly name: string;
  readonly text: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly shell?: string;
  readonly run?: string;
  readonly with: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

/** Without comment lines, which explain but never configure. */
const code = (workflow: string): string =>
  workflow
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

/** The steps of the (single) job, in order. */
function steps(workflow: string): Step[] {
  const lines = workflow.split('\n');
  const result: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^ {6}- name: (.+)$/.exec(lines[i] ?? '');
    if (!head) continue;
    // A step ends at a blank line, a comment or the next step (scripts here have no blank lines).
    let end = i + 1;
    while (end < lines.length && lines[end] !== '' && !/^ {6}(- |# )/.test(lines[end] ?? '')) end++;
    const block = lines.slice(i + 1, end);
    const scalar = (key: string): string | undefined =>
      block.find((l) => l.startsWith(`        ${key}: `))?.slice(`        ${key}: `.length);
    const map = (key: string): Record<string, string> => {
      const at = block.indexOf(`        ${key}:`);
      if (at === -1) return {};
      const entries: Record<string, string> = {};
      for (const line of block.slice(at + 1)) {
        const m = /^ {10}([\w-]+): (.*)$/.exec(line);
        if (!m) break;
        entries[m[1] ?? ''] = m[2] ?? '';
      }
      return entries;
    };
    let run = scalar('run');
    if (run === '|') {
      const at = block.indexOf('        run: |');
      run = block
        .slice(at + 1)
        .filter((l) => l.startsWith('          ') || l === '')
        .map((l) => l.slice(10))
        .join('\n')
        .trim();
    }
    const step: Record<string, unknown> = {
      name: head[1],
      text: [lines[i], ...block].join('\n'),
      with: map('with'),
      env: map('env'),
    };
    for (const key of ['id', 'if', 'uses', 'shell'] as const) {
      const value = scalar(key);
      if (value !== undefined) step[key] = value;
    }
    if (run !== undefined) step['run'] = run;
    result.push(step as unknown as Step);
  }
  return result;
}

function step(workflow: string, name: string): Step {
  const found = steps(workflow).filter((s) => s.name === name);
  assert.equal(found.length, 1, `exactly one step "${name}"`);
  return found[0] as Step;
}

const indexOf = (workflow: string, name: string): number =>
  steps(workflow).findIndex((s) => s.name === name);

describe('workflows: all files', () => {
  test('there are exactly the three reviewed workflows', () => {
    assert.deepEqual(readdirSync(join(REPO, '.github/workflows')).sort(), [
      'ci-history.yml',
      'ci.yml',
      'pages.yml',
    ]);
  });

  test('every action is pinned to a full commit SHA with its version noted', () => {
    for (const workflow of [CI, HISTORY, PAGES]) {
      const uses = code(workflow)
        .split('\n')
        .filter((l) => /^\s+uses: /.test(l));
      assert.ok(uses.length >= 3);
      for (const line of uses) {
        assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line);
      }
    }
  });

  test('no run script interpolates an expression, and no secrets are used', () => {
    for (const workflow of [CI, HISTORY, PAGES]) {
      const scripts = steps(workflow).flatMap((s) => (s.run === undefined ? [] : [s.run]));
      assert.ok(scripts.length >= 8, String(scripts.length));
      for (const script of scripts) assert.ok(!script.includes('${{'), script);
      assert.doesNotMatch(code(workflow), /secrets\.|pull_request_target/);
      // The single contents: write (the publish job) is checked exactly in its own test.
      if (workflow === CI) assert.doesNotMatch(code(workflow), /:\s*write\b/);
    }
  });

  test("the step reader sees every step's script", () => {
    // Guards the reader itself: every `run:` line in the file belongs to a parsed step.
    for (const workflow of [CI, HISTORY, PAGES]) {
      const runLines = code(workflow).match(/^ {8}run: /gm)?.length ?? 0;
      assert.equal(steps(workflow).filter((s) => s.run !== undefined).length, runLines);
    }
  });
});

describe('workflows: CI artifact hand-off (ci.yml)', () => {
  test('triggers and permissions are unchanged', () => {
    const c = code(CI);
    assert.match(
      c,
      /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/m,
    );
    assert.match(c, /^permissions: \{\}$/m);
    assert.equal(c.match(/^ +permissions:/gm)?.length, 1);
    assert.match(c, /^ {4}permissions:\n {6}contents: read\n\n/m);
    assert.doesNotMatch(c, /actions: |id-token|download-artifact/);
  });

  test('exactly two uploads, by the pinned action, with attempt-specific names', () => {
    const uploads = steps(CI).filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
    assert.deepEqual(
      uploads.map((s) => s.name),
      [ARTIFACTS.snapshot.uploadStep, ARTIFACTS.suites.uploadStep],
    );
    for (const s of uploads) assert.equal(s.uses, UPLOAD);
    assert.equal(code(CI).match(/upload-artifact/g)?.length, 2);
  });

  const SNAPSHOT_IF = `always() && steps.snapshot.outcome == 'success' && ${MAIN_PUSH_OR_DISPATCH}`;
  const SUITES_IF = `always() && steps.collect.outcome == 'success' && ${MAIN_PUSH_OR_DISPATCH}`;
  const HANDOFF = [
    {
      kind: 'snapshot',
      stage: 'Stage dashboard snapshot',
      if: SNAPSHOT_IF,
      source: 'artifacts/dashboard/dashboard-data.json',
    },
    {
      kind: 'suites',
      stage: 'Stage suite results',
      if: SUITES_IF,
      source: 'artifacts/ci/suite-results.json',
    },
  ] as const;

  test('the hand-off is the last four steps, after collection: stage, then upload, per artifact', () => {
    assert.equal(step(CI, ARTIFACTS.snapshot.producerStep).id, 'snapshot');
    assert.deepEqual(
      steps(CI)
        .slice(-5)
        .map((s) => s.name),
      [
        ARTIFACTS.suites.producerStep,
        'Stage dashboard snapshot',
        ARTIFACTS.snapshot.uploadStep,
        'Stage suite results',
        ARTIFACTS.suites.uploadStep,
      ],
    );
  });

  test('each upload is one raw JSON file (archive: false) under its attempt-specific file name', () => {
    for (const h of HANDOFF) {
      const spec = ARTIFACTS[h.kind];
      assert.equal(spec.file, h.source.split('/').at(-1));
      const upload = step(CI, spec.uploadStep);
      assert.equal(upload.if, h.if, spec.uploadStep);
      // No `name`: with archive: false the artifact takes the file's name.
      assert.deepEqual(upload.with, {
        path: `artifacts/handoff/${spec.prefix}\${{ github.run_attempt }}.json`,
        archive: 'false',
        'if-no-files-found': 'error',
        'retention-days': '7',
        overwrite: 'false',
      });
      const stage = step(CI, h.stage);
      assert.equal(stage.if, h.if, h.stage);
      assert.equal(
        stage.run,
        `mkdir -p artifacts/handoff\ncp ${h.source} "artifacts/handoff/${spec.prefix}$GITHUB_RUN_ATTEMPT.json"`,
      );
    }
  });

  test('the staging scripts write exactly the attempt-specific file the upload names (executed)', () => {
    for (const attempt of ['1', '2']) {
      const dir = mkdtempSync(join(tmpdir(), 'ci-handoff-stage-'));
      try {
        mkdirSync(join(dir, 'artifacts/dashboard'), { recursive: true });
        mkdirSync(join(dir, 'artifacts/ci'), { recursive: true });
        writeFileSync(join(dir, 'artifacts/dashboard/dashboard-data.json'), '{"snapshot":1}\n');
        writeFileSync(join(dir, 'artifacts/ci/suite-results.json'), '{"suites":1}\n');
        for (const h of HANDOFF) {
          // GitHub's default shell for run steps: bash -e.
          const result = spawnSync('bash', ['-e', '-c', step(CI, h.stage).run ?? ''], {
            cwd: dir,
            encoding: 'utf8',
            env: { PATH: process.env['PATH'] ?? '', GITHUB_RUN_ATTEMPT: attempt },
          });
          assert.equal(result.status, 0, result.stderr);
        }
        assert.deepEqual(readdirSync(join(dir, 'artifacts/handoff')).sort(), [
          artifactName('snapshot', Number(attempt)),
          artifactName('suites', Number(attempt)),
        ]);
        assert.equal(
          readFileSync(
            join(dir, 'artifacts/handoff', artifactName('snapshot', Number(attempt))),
            'utf8',
          ),
          '{"snapshot":1}\n',
        );
        // A missing source fails the staging step, so the upload has nothing to send.
        rmSync(join(dir, 'artifacts/ci/suite-results.json'));
        const failed = spawnSync('bash', ['-e', '-c', step(CI, 'Stage suite results').run ?? ''], {
          cwd: dir,
          encoding: 'utf8',
          env: { PATH: process.env['PATH'] ?? '', GITHUB_RUN_ATTEMPT: attempt },
        });
        assert.notEqual(failed.status, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('an upload failure cannot stop a check: the hand-off comes after every check and collection', () => {
    const all = steps(CI);
    const firstHandoff = indexOf(CI, 'Stage dashboard snapshot');
    assert.equal(firstHandoff, all.length - 4);
    for (const name of [
      'Typecheck',
      'Lint',
      'Format check',
      'Agent validation and generator tests',
      'Dashboard data tests',
      'CI run record tests',
      'Dashboard typecheck',
      'Dashboard lint',
      'Dashboard tests',
      'Dashboard build',
      'Playwright tests',
      ARTIFACTS.suites.producerStep,
    ]) {
      assert.ok(indexOf(CI, name) >= 0 && indexOf(CI, name) < firstHandoff, name);
    }
    // Every hand-off step runs regardless of earlier failures, including a failed upload.
    for (const s of all.slice(firstHandoff)) assert.ok(s.if?.startsWith('always() && '), s.name);
  });

  test('pull request runs never upload: every upload condition requires push or dispatch on main', () => {
    for (const s of steps(CI).filter((x) => x.uses?.startsWith('actions/upload-artifact@'))) {
      assert.ok(s.if?.includes(MAIN_PUSH_OR_DISPATCH), s.name);
      assert.ok(!s.if?.includes('pull_request'), s.name);
    }
  });

  test('test reports are never uploaded; only the two staged hand-off files', () => {
    const paths = steps(CI).flatMap((s) => (s.with['path'] === undefined ? [] : [s.with['path']]));
    assert.deepEqual(paths, [
      'artifacts/handoff/ci-snapshot-attempt-${{ github.run_attempt }}.json',
      'artifacts/handoff/ci-suite-results-attempt-${{ github.run_attempt }}.json',
    ]);
    assert.doesNotMatch(code(CI), /\.tap\b[^\n]*\n[^\n]*upload|playwright-report|test-results/);
  });
});

/** One job's block of a workflow (from `  <id>:` to the next job or the end). */
function jobBlock(workflow: string, id: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${id}:`);
  assert.ok(start >= 0, `job "${id}" not found`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[\w-]+:$/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

const ELIGIBLE =
  "github.event.workflow_run.status == 'completed' && " +
  "(github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'workflow_dispatch') && " +
  "github.event.workflow_run.head_branch == 'main' && " +
  'github.event.workflow_run.repository.full_name == github.repository && ' +
  'github.event.workflow_run.head_repository.full_name == github.repository';
const condition = (job: string): string | undefined =>
  /^ {4}if: >-\n((?: {6}.+\n)+)/m.exec(`${job}\n`)?.[1]?.replace(/\s+/g, ' ').trim();

describe('workflows: CI history (ci-history.yml)', () => {
  const c = code(HISTORY);
  const COMPOSE = jobBlock(c, 'compose');
  const PUBLISH = jobBlock(c, 'publish');

  test('triggered only by completed CI runs on main, through workflow_run', () => {
    assert.match(
      c,
      /^on:\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n\n/m,
    );
    assert.doesNotMatch(
      c,
      /^ {2}(push|pull_request|pull_request_target|workflow_dispatch|schedule):/m,
    );
  });

  test('exactly two jobs: compose (read-only) and publish (the only writer)', () => {
    assert.deepEqual(
      [...c.slice(c.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]),
      ['compose', 'publish'],
    );
    assert.match(c, /^permissions: \{\}$/m);
    assert.equal(c.match(/^ +permissions:/gm)?.length, 2);
    assert.match(
      COMPOSE,
      /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n {4}outputs:/m,
    );
    assert.match(PUBLISH, /^ {4}permissions:\n {6}contents: write\n\n/m);
    // The only write anywhere is publish's contents: write.
    assert.equal(c.match(/write/g)?.length, 1);
    assert.doesNotMatch(c, /id-token|pages|upload-artifact|secrets\.|git push|git commit/);
  });

  test('both jobs refuse pull request, fork, wrong-branch and wrong-repository runs', () => {
    assert.equal(condition(COMPOSE), ELIGIBLE);
    assert.equal(condition(PUBLISH), `needs.compose.outputs.publish == 'true' && ${ELIGIBLE}`);
  });

  test('event values appear only in the job conditions and the concurrency key', () => {
    const lines = c.split('\n').filter((l) => l.includes('github.event'));
    for (const line of lines) {
      assert.match(line, /^( {6}\(?github\.event\.workflow_run| {2}group: ci-history-)/, line);
    }
    assert.match(
      c,
      /^ {2}group: ci-history-\$\{\{ github\.event\.workflow_run\.id \}\}-\$\{\{ github\.event\.workflow_run\.run_attempt \}\}$/m,
    );
  });

  // ------------------------------------------------------------ compose

  test('compose checks out trusted default-branch code without credentials', () => {
    const s = step(COMPOSE, 'Check out trusted default-branch code');
    assert.equal(indexOf(COMPOSE, s.name), 0);
    assert.deepEqual(s.with, { 'persist-credentials': 'false' });
  });

  test('compose steps run in the reviewed order; the summary always runs last', () => {
    assert.deepEqual(
      steps(COMPOSE).map((s) => s.name),
      [
        'Check out trusted default-branch code',
        'Set up Node.js (.nvmrc)',
        'Check Node.js version',
        'Install root dependencies',
        'Describe the event (field shapes only)',
        'Derive run context',
        'Resolve hand-off artifacts',
        'Download dashboard snapshot',
        'Download suite results',
        'Compose run record',
        'Check out the current ci-history branch (read-only)',
        'Verify the current history',
        'Plan history addition',
        'Publisher pre-check',
        'Prepare publication payload',
        'Job summary',
      ],
    );
    assert.equal(step(COMPOSE, 'Job summary').if, 'always()');
  });

  test('compose reads the current ci-history branch without credentials and verifies it fully', () => {
    const s = step(COMPOSE, 'Check out the current ci-history branch (read-only)');
    assert.equal(s.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1');
    assert.deepEqual(s.with, {
      ref: 'ci-history',
      path: 'ci-history-current',
      'persist-credentials': 'false',
    });
    assert.equal(
      step(COMPOSE, 'Verify the current history').run,
      './node_modules/.bin/tsx reporting/ci/history-cli.ts verify --history ci-history-current',
    );
  });

  test('compose hands over only the checked payload, through declared job outputs', () => {
    assert.match(
      COMPOSE,
      /^ {4}outputs:\n {6}publish: \$\{\{ steps\.payload\.outputs\.publish \}\}\n {6}record-b64: \$\{\{ steps\.payload\.outputs\.record-b64 \}\}\n {6}record-sha256: \$\{\{ steps\.payload\.outputs\.record-sha256 \}\}\n\n/m,
    );
    const s = step(COMPOSE, 'Prepare publication payload');
    assert.equal(s.id, 'payload');
    assert.equal(
      s.run,
      './node_modules/.bin/tsx reporting/ci/handoff-cli.ts payload --work "$RUNNER_TEMP/ci-history"',
    );
  });

  test('downloads only by the resolved artifact ID of the triggering run, digest-checked', () => {
    for (const [name, output, kind] of [
      ['Download dashboard snapshot', 'snapshot-id', 'snapshot'],
      ['Download suite results', 'suites-id', 'suites'],
    ] as const) {
      const s = step(COMPOSE, name);
      assert.equal(s.uses, DOWNLOAD);
      assert.deepEqual(s.with, {
        'artifact-ids': `\${{ steps.resolve.outputs.${output} }}`,
        'run-id': '${{ steps.resolve.outputs.run-id }}',
        repository: '${{ github.repository }}',
        'github-token': '${{ github.token }}',
        path: `\${{ runner.temp }}/ci-history/download/${kind}`,
        'digest-mismatch': 'error',
        'skip-decompress': 'true',
      });
      assert.ok(s.if?.startsWith(`steps.resolve.outputs.${output} != ''`), name);
    }
    assert.equal(c.match(/download-artifact@/g)?.length, 2);
    assert.doesNotMatch(PUBLISH, /download-artifact/);
  });

  test('no archive is ever extracted: every upload is raw and every download skips decompression', () => {
    const uploads = steps(CI).filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(uploads.length, 2);
    for (const s of uploads) assert.equal(s.with['archive'], 'false', s.name);
    const downloads = steps(COMPOSE).filter((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    );
    assert.equal(downloads.length, 2);
    for (const s of downloads) {
      assert.equal(s.with['skip-decompress'], 'true', s.name);
      assert.equal(s.with['artifact-ids']?.startsWith('${{ steps.resolve.outputs.'), true);
      assert.equal(s.with['name'], undefined, `${s.name}: never by name`);
      assert.equal(s.with['pattern'], undefined, `${s.name}: never by pattern`);
    }
  });

  test('later compose stages run only when the snapshot exists', () => {
    for (const name of [
      'Download suite results',
      'Compose run record',
      'Check out the current ci-history branch (read-only)',
      'Verify the current history',
      'Plan history addition',
      'Publisher pre-check',
      'Prepare publication payload',
    ]) {
      assert.ok(
        step(COMPOSE, name).if?.includes("steps.resolve.outputs.recordable == 'true'"),
        name,
      );
    }
  });

  test('never executes downloaded content: every command is a reviewed repository tool', () => {
    const allowed = [
      /^node --version$/,
      /^node -e "const \[a, b, c\] = process\.versions\.node/,
      /^npm ci --ignore-scripts$/,
      /^node reporting\/ci\/event-shape\.mjs "\$GITHUB_EVENT_PATH" >> "\$GITHUB_STEP_SUMMARY"$/,
      /^mkdir -p "\$RUNNER_TEMP\/ci-history"$/,
      /^npm run -s ci:collect -- context --event "\$GITHUB_EVENT_PATH" --workflow CI --out "\$RUNNER_TEMP\/ci-history\/context\.json"$/,
      /^\.\/node_modules\/\.bin\/tsx reporting\/ci\/handoff-cli\.ts (resolve|compose|payload) --work "\$RUNNER_TEMP\/ci-history"$/,
      /^\.\/node_modules\/\.bin\/tsx reporting\/ci\/history-cli\.ts verify --history ci-history-current$/,
      /^set -euo pipefail$/,
      /^work="\$RUNNER_TEMP\/ci-history"$/,
      /^\.\/node_modules\/\.bin\/tsx reporting\/ci\/history-cli\.ts plan --history ci-history-current --record "\$work\/record\.json" > "\$work\/plan\.json\.tmp"$/,
      /^mv "\$work\/(plan|check)\.json\.tmp" "\$work\/(plan|check)\.json"$/,
      /^sha="\$\(node -p "JSON\.parse\(require\('node:fs'\)\.readFileSync\(process\.argv\[1\], 'utf8'\)\)\.sha256" "\$work\/plan\.json"\)"$/,
      /^node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON reporting\/ci\/publish-check\.mjs --event "\$GITHUB_EVENT_PATH" --record "\$work\/record\.json" --sha256 "\$sha" --history ci-history-current > "\$work\/check\.json\.tmp"$/,
      /^if ! \.\/node_modules\/\.bin\/tsx reporting\/ci\/handoff-cli\.ts summary --work "\$RUNNER_TEMP\/ci-history" >> "\$GITHUB_STEP_SUMMARY"; then$/,
      /^printf '## CI history: compose \(read-only\)\\n\\nNothing was written\. [^']*' >> "\$GITHUB_STEP_SUMMARY"$/,
      /^fi$/,
      // publish job
      /^node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools\/reporting\/ci\/publish\.mjs --event "\$GITHUB_EVENT_PATH" --history history$/,
    ];
    const commands = steps(c).flatMap((s) =>
      (s.run ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== ''),
    );
    assert.ok(commands.length >= 22);
    for (const command of commands) {
      assert.ok(
        allowed.some((pattern) => pattern.test(command)),
        `not a reviewed command: ${command}`,
      );
    }
  });

  test('the token reaches only the resolver (as GITHUB_TOKEN) and the download action', () => {
    const users = steps(c).filter((s) => s.text.includes('github.token'));
    assert.deepEqual(
      users.map((s) => s.name),
      ['Resolve hand-off artifacts', 'Download dashboard snapshot', 'Download suite results'],
    );
    assert.deepEqual(step(COMPOSE, 'Resolve hand-off artifacts').env, {
      GITHUB_TOKEN: '${{ github.token }}',
    });
    assert.equal(step(COMPOSE, 'Resolve hand-off artifacts').id, 'resolve');
  });

  test('scripts that redirect output run with pipefail and replace their result only on success', () => {
    for (const name of ['Plan history addition', 'Publisher pre-check']) {
      const s = step(COMPOSE, name);
      assert.equal(s.shell, 'bash', name);
      assert.ok(s.run?.startsWith('set -euo pipefail\n'), name);
    }
  });

  // ------------------------------------------------------------ publish

  test('publish waits for compose and for approval of the ci-history environment', () => {
    assert.match(PUBLISH, /^ {4}needs: compose$/m);
    assert.match(PUBLISH, /^ {4}environment: ci-history$/m);
    assert.match(PUBLISH, /^ {4}runs-on: ubuntu-24\.04$/m);
    assert.match(PUBLISH, /^ {4}timeout-minutes: 10$/m);
  });

  test('publish runs only trusted code: no install, no artifact, credentials only for the last step', () => {
    assert.deepEqual(
      steps(PUBLISH).map((s) => [s.name, s.uses ?? 'run']),
      [
        [
          'Check out trusted publisher code',
          'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        ],
        [
          'Set up Node.js (.nvmrc)',
          'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
        ],
        ['Check Node.js version', 'run'],
        [
          'Check out the ci-history branch',
          'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        ],
        ['Publish the run record', 'run'],
      ],
    );
    assert.deepEqual(step(PUBLISH, 'Check out trusted publisher code').with, {
      path: 'tools',
      'persist-credentials': 'false',
    });
    assert.deepEqual(step(PUBLISH, 'Set up Node.js (.nvmrc)').with, {
      'node-version-file': 'tools/.nvmrc',
    });
    // The one checkout that keeps push credentials comes after every third-party action.
    assert.deepEqual(step(PUBLISH, 'Check out the ci-history branch').with, {
      ref: 'ci-history',
      path: 'history',
      'persist-credentials': 'true',
    });
    assert.doesNotMatch(
      PUBLISH,
      /npm |npx |tsx|node_modules|upload-artifact|download-artifact|github\.token|secrets/,
    );
  });

  test('publish receives the record only through env, from the declared compose outputs', () => {
    const s = step(PUBLISH, 'Publish the run record');
    assert.deepEqual(s.env, {
      CI_HISTORY_RECORD_B64: '${{ needs.compose.outputs.record-b64 }}',
      CI_HISTORY_RECORD_SHA256: '${{ needs.compose.outputs.record-sha256 }}',
    });
    assert.equal(
      s.run,
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/reporting/ci/publish.mjs --event "$GITHUB_EVENT_PATH" --history history',
    );
  });

  test('YAML is well-formed (Ruby Psych, when available)', (t) => {
    const ruby = spawnSync('ruby', ['-e', 'exit 0'], { encoding: 'utf8' });
    if (ruby.status !== 0) {
      t.skip('ruby is not installed');
      return;
    }
    for (const file of ['ci.yml', 'ci-history.yml', 'pages.yml']) {
      const result = spawnSync(
        'ruby',
        [
          '-ryaml',
          '-e',
          'YAML.safe_load(File.read(ARGV[0])); puts "ok"',
          join(REPO, '.github/workflows', file),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.stdout.trim(), 'ok', `${file}: ${result.stderr}`);
    }
  });
});

describe('workflows: Dashboard on GitHub Pages (pages.yml)', () => {
  const c = code(PAGES);
  const GATE = jobBlock(c, 'gate');
  const BUILD = jobBlock(c, 'build');
  const DEPLOY = jobBlock(c, 'deploy');
  const TRUSTED =
    "github.repository == 'LarysaK/AI-QA-AutomationFramework' && " +
    "github.ref == 'refs/heads/main' && " +
    "(github.event_name == 'workflow_dispatch' || " +
    "(github.event_name == 'workflow_run' && " +
    "github.event.workflow_run.conclusion == 'success' && " +
    "github.event.workflow_run.head_branch == 'main' && " +
    'github.event.workflow_run.repository.full_name == github.repository))';
  const GATED = `needs.gate.outputs.deploy == 'true' && ${TRUSTED}`;

  test('triggered only by CI history runs on main and manual dispatch; never by pull requests or pushes', () => {
    assert.match(
      c,
      /^on:\n {2}workflow_run:\n {4}workflows: \[CI history\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n {2}workflow_dispatch:\n\n/m,
    );
    assert.doesNotMatch(c, /^ {2}(push|pull_request|pull_request_target|schedule):/m);
    assert.doesNotMatch(c, /pull_request/);
  });

  test('three jobs: gate decides, build builds, deploy deploys; each checks repository, branch and event', () => {
    assert.deepEqual(
      [...c.slice(c.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]),
      ['gate', 'build', 'deploy'],
    );
    // Only a successful CI history run passes the job conditions; the gate then requires that it
    // composed and published a record (failed, cancelled, skipped or nothing published: no deploy).
    assert.equal(condition(GATE), TRUSTED);
    assert.equal(condition(BUILD), GATED);
    assert.equal(condition(DEPLOY), GATED);
    assert.match(BUILD, /^ {4}needs: gate$/m);
    assert.match(DEPLOY, /^ {4}needs: \[gate, build\]$/m);
  });

  test('the gate reads the trusted event and the triggering run’s jobs, and its decision is the only output', () => {
    assert.match(GATE, /^ {4}outputs:\n {6}deploy: \$\{\{ steps\.gate\.outputs\.deploy \}\}\n\n/m);
    const decide = step(GATE, 'Decide whether to deploy');
    assert.equal(decide.id, 'gate');
    assert.equal(decide.run, 'node reporting/ci/pages-gate.mjs >> "$GITHUB_OUTPUT"');
    assert.deepEqual(decide.env, { GITHUB_TOKEN: '${{ github.token }}' });
    assert.deepEqual(step(GATE, 'Check out main').with, {
      ref: 'main',
      'persist-credentials': 'false',
    });
    // No event value reaches a script or an env: the gate reads GITHUB_EVENT_PATH itself.
    for (const line of c.split('\n').filter((l) => l.includes('github.event.'))) {
      assert.match(
        line,
        /^ {6}\(?github\.event\.workflow_run\.(conclusion|head_branch|repository\.full_name)/,
        line,
      );
    }
  });

  test('least privilege: gate and build read; deploy has only pages: write and id-token: write', () => {
    assert.match(c, /^permissions: \{\}$/m);
    assert.equal(c.match(/^ +permissions:/gm)?.length, 3);
    assert.match(GATE, /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n {4}outputs:/m);
    assert.match(BUILD, /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n\n/m);
    assert.match(
      DEPLOY,
      /^ {4}permissions:\n {6}pages: write\n {6}id-token: write\n {4}environment:/m,
    );
    assert.equal(c.match(/write/g)?.length, 2, 'only pages: write and id-token: write');
    assert.doesNotMatch(c, /contents: write|git push|git commit|secrets\./);
  });

  test('deploy runs only the official deploy action, in the github-pages environment', () => {
    assert.match(
      DEPLOY,
      /^ {4}environment:\n {6}name: github-pages\n {6}url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}$/m,
    );
    assert.deepEqual(
      steps(DEPLOY).map((s) => s.uses),
      ['actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1'],
    );
  });

  test('runs are serialized and a running deployment is never cancelled', () => {
    assert.match(c, /^concurrency:\n {2}group: pages\n {2}cancel-in-progress: false$/m);
    assert.equal(c.match(/^ *concurrency:/gm)?.length, 1, 'no job-level concurrency overrides');
  });

  test('build checks out the current main and stops unless it is still this run’s commit', () => {
    const main = step(BUILD, 'Check out main');
    assert.equal(indexOf(BUILD, main.name), 0);
    assert.deepEqual(main.with, { ref: 'main', 'persist-credentials': 'false' });
    const moved = step(BUILD, 'Confirm main has not moved on');
    assert.equal(indexOf(BUILD, moved.name), 1);
    assert.equal(
      moved.run,
      [
        'head="$(git rev-parse HEAD)"',
        'if [ "$head" != "$GITHUB_SHA" ]; then',
        '  echo "::error::main is at $head, but this run is for $GITHUB_SHA; nothing is deployed"',
        '  exit 1',
        'fi',
      ].join('\n'),
    );
  });

  test('the HEAD check passes on the current commit and refuses an older run (executed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pages-head-'));
    try {
      const git = (...args: string[]) =>
        spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
          cwd: dir,
          encoding: 'utf8',
        });
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'old');
      const old = git('rev-parse', 'HEAD').stdout.trim();
      git('commit', '-q', '--allow-empty', '-m', 'new');
      const head = git('rev-parse', 'HEAD').stdout.trim();
      const script = step(BUILD, 'Confirm main has not moved on').run ?? '';
      const run = (sha: string) =>
        spawnSync('bash', ['-e', '-c', script], {
          cwd: dir,
          encoding: 'utf8',
          env: { PATH: process.env['PATH'] ?? '', GITHUB_SHA: sha },
        });
      assert.equal(run(head).status, 0);
      const stale = run(old);
      assert.equal(stale.status, 1);
      assert.match(stale.stdout, new RegExp(`main is at ${head}, but this run is for ${old}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('main and ci-history are checked out separately, without credentials; ci-history in full', () => {
    assert.deepEqual(step(BUILD, 'Check out ci-history (read-only)').with, {
      ref: 'ci-history',
      path: 'ci-history',
      'fetch-depth': '0',
      'persist-credentials': 'false',
    });
    assert.equal(c.match(/persist-credentials: true/g), null);
  });

  test('the build steps run in the reviewed order', () => {
    assert.deepEqual(
      steps(BUILD).map((s) => s.name),
      [
        'Check out main',
        'Confirm main has not moved on',
        'Check out ci-history (read-only)',
        'Set up Node.js (.nvmrc)',
        'Check Node.js version',
        'Guard (no model credentials, no staged proposals)',
        'Install root dependencies',
        'Install dashboard dependencies',
        'Generate dashboard snapshot',
        'Reconcile CI history (read-only, optional coverage)',
        'Export CI history',
        'Dashboard typecheck',
        'Dashboard lint',
        'Dashboard tests',
        'Build dashboard for GitHub Pages',
        'Verify built site',
        'Upload Pages artifact',
      ],
    );
  });

  test('the same guard as CI: no model credentials and no staged proposals', () => {
    assert.equal(
      step(BUILD, 'Guard (no model credentials, no staged proposals)').run,
      step(CI, 'Guard (no model credentials, no staged proposals)').run,
    );
  });

  test('reconciliation is read-only and optional; the export decides, and coverage is never estimated', () => {
    const reconcile = step(BUILD, 'Reconcile CI history (read-only, optional coverage)');
    assert.deepEqual(reconcile.env, { GITHUB_TOKEN: '${{ github.token }}' });
    assert.match(
      reconcile.run ?? '',
      /reporting\/ci\/reconcile-cli\.ts --history ci-history > "\$RUNNER_TEMP\/reconciliation\.json"/,
    );
    assert.equal(
      step(BUILD, 'Export CI history').run,
      'npm run -s dashboard:history -- --history ci-history --repository "$GITHUB_REPOSITORY" --coverage-if-verified "$RUNNER_TEMP/reconciliation.json"',
    );
    // The token reaches only the gate and the reconciliation (GET requests), and the official
    // actions' defaults.
    assert.equal(c.match(/github\.token/g)?.length, 2);
  });

  test('the build requires the CI history, uses the repository subpath and is verified before upload', () => {
    const build = step(BUILD, 'Build dashboard for GitHub Pages');
    assert.deepEqual(build.env, { DASHBOARD_REQUIRE_CI_HISTORY: "'1'" });
    assert.equal(
      build.run,
      'export DASHBOARD_BASE="/${GITHUB_REPOSITORY#*/}/"\nnpm --prefix reporting/dashboard run build',
    );
    assert.equal(
      step(BUILD, 'Verify built site').run,
      './node_modules/.bin/tsx reporting/dashboard/build/verify-site.ts artifacts/dashboard-site "/${GITHUB_REPOSITORY#*/}/" --require-history',
    );
    const upload = step(BUILD, 'Upload Pages artifact');
    assert.equal(
      upload.uses,
      'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0',
    );
    assert.deepEqual(upload.with, { path: 'artifacts/dashboard-site' });
    // deploy-pages deploys the artifact of this run, uploaded once by build.
    assert.equal(c.match(/upload-pages-artifact|upload-artifact/g)?.length, 1);
  });

  test('only official actions are used', () => {
    const uses = [...c.matchAll(/uses: ([\w-]+)\//g)].map((m) => m[1]);
    assert.ok(uses.length >= 7);
    assert.deepEqual([...new Set(uses)], ['actions']);
  });

  test('the CI history publisher is not touched: no shared jobs, no writes to ci-history', () => {
    assert.doesNotMatch(c, /publish\.mjs|history-cli\.ts plan|environment:\n {6}name: ci-history/);
    assert.doesNotMatch(code(HISTORY), /pages|deploy/i);
  });

  test('the gate names the CI history jobs exactly as ci-history.yml does', async () => {
    const gateModule = await import('./pages-gate.mjs');
    const names = [...code(HISTORY).matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(names, [...gateModule.REQUIRED_JOBS]);
    assert.match(HISTORY, new RegExp(`^name: ${gateModule.HISTORY_WORKFLOW}$`, 'm'));
  });
});
