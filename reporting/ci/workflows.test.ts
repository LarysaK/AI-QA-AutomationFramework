import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { ARTIFACTS } from './handoff';

/**
 * Structure of the two workflows (.github/workflows): triggers, permissions, pinned actions,
 * the hand-off artifacts and the dry run's steps. Offline: the files are read as text with a
 * small step reader for this repository's two-space YAML layout.
 */

const REPO = resolve('.');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const HISTORY = readFileSync(join(REPO, '.github/workflows/ci-history.yml'), 'utf8');

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

describe('workflows: both files', () => {
  test('there are exactly the two reviewed workflows', () => {
    assert.deepEqual(readdirSync(join(REPO, '.github/workflows')).sort(), [
      'ci-history.yml',
      'ci.yml',
    ]);
  });

  test('every action is pinned to a full commit SHA with its version noted', () => {
    for (const workflow of [CI, HISTORY]) {
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
    for (const workflow of [CI, HISTORY]) {
      const scripts = steps(workflow).flatMap((s) => (s.run === undefined ? [] : [s.run]));
      assert.ok(scripts.length >= 8, String(scripts.length));
      for (const script of scripts) assert.ok(!script.includes('${{'), script);
      assert.doesNotMatch(code(workflow), /secrets\.|pull_request_target|:\s*write\b/);
    }
  });

  test("the step reader sees every step's script", () => {
    // Guards the reader itself: every `run:` line in the file belongs to a parsed step.
    for (const workflow of [CI, HISTORY]) {
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

  test('the snapshot upload: after collection, only if the snapshot was generated, main push/dispatch only', () => {
    assert.equal(step(CI, ARTIFACTS.snapshot.producerStep).id, 'snapshot');
    const s = step(CI, ARTIFACTS.snapshot.uploadStep);
    assert.equal(indexOf(CI, s.name), indexOf(CI, ARTIFACTS.suites.producerStep) + 1);
    assert.equal(
      s.if,
      `always() && steps.snapshot.outcome == 'success' && ${MAIN_PUSH_OR_DISPATCH}`,
    );
    assert.deepEqual(s.with, {
      name: `${ARTIFACTS.snapshot.prefix}\${{ github.run_attempt }}`,
      path: `artifacts/dashboard/${ARTIFACTS.snapshot.file}`,
      'if-no-files-found': 'error',
      'retention-days': '7',
      overwrite: 'false',
    });
  });

  test('the suite-results upload: last, only after a successful collection, main push/dispatch only', () => {
    const s = step(CI, ARTIFACTS.suites.uploadStep);
    const all = steps(CI);
    assert.equal(all.at(-1)?.name, s.name);
    assert.equal(indexOf(CI, s.name), indexOf(CI, ARTIFACTS.snapshot.uploadStep) + 1);
    assert.equal(
      s.if,
      `always() && steps.collect.outcome == 'success' && ${MAIN_PUSH_OR_DISPATCH}`,
    );
    assert.deepEqual(s.with, {
      name: `${ARTIFACTS.suites.prefix}\${{ github.run_attempt }}`,
      path: `artifacts/ci/${ARTIFACTS.suites.file}`,
      'if-no-files-found': 'error',
      'retention-days': '7',
      overwrite: 'false',
    });
  });

  test('an upload failure cannot stop a check: uploads come after every check and collection', () => {
    const all = steps(CI);
    const firstUpload = all.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(firstUpload, all.length - 2);
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
      assert.ok(indexOf(CI, name) >= 0 && indexOf(CI, name) < firstUpload, name);
    }
    // Every step from the first upload on runs regardless of earlier failures.
    for (const s of all.slice(firstUpload)) assert.ok(s.if?.startsWith('always() && '), s.name);
  });

  test('pull request runs never upload: every upload condition requires push or dispatch on main', () => {
    for (const s of steps(CI).filter((x) => x.uses?.startsWith('actions/upload-artifact@'))) {
      assert.ok(s.if?.includes(MAIN_PUSH_OR_DISPATCH), s.name);
      assert.ok(!s.if?.includes('pull_request'), s.name);
    }
  });

  test('raw reports are never uploaded', () => {
    const paths = steps(CI).flatMap((s) => (s.with['path'] === undefined ? [] : [s.with['path']]));
    assert.deepEqual(paths, [
      'artifacts/dashboard/dashboard-data.json',
      'artifacts/ci/suite-results.json',
    ]);
    assert.doesNotMatch(code(CI), /\.tap\b[^\n]*\n[^\n]*upload|playwright-report|test-results/);
  });
});

describe('workflows: CI history dry run (ci-history.yml)', () => {
  const c = code(HISTORY);

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

  test('read-only: nothing by default, contents and actions read for the one job', () => {
    assert.match(c, /^permissions: \{\}$/m);
    assert.equal(c.match(/^ +permissions:/gm)?.length, 1);
    assert.match(c, /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n\n/m);
    assert.doesNotMatch(c, /write|id-token|pages|upload-artifact|git push|git commit/);
  });

  test('refuses pull request, fork, wrong-branch and wrong-repository runs in the job condition', () => {
    const condition = /^ {4}if: >-\n((?: {6}.+\n)+)/m.exec(c)?.[1]?.replace(/\s+/g, ' ').trim();
    assert.equal(
      condition,
      "github.event.workflow_run.status == 'completed' && " +
        "(github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'workflow_dispatch') && " +
        "github.event.workflow_run.head_branch == 'main' && " +
        'github.event.workflow_run.repository.full_name == github.repository && ' +
        'github.event.workflow_run.head_repository.full_name == github.repository',
    );
  });

  test('event values appear only in the job condition and the concurrency key', () => {
    const lines = c.split('\n').filter((l) => l.includes('github.event'));
    for (const line of lines) {
      assert.match(line, /^( {6}\(?github\.event\.workflow_run| {2}group: ci-history-)/, line);
    }
    assert.match(
      c,
      /^ {2}group: ci-history-\$\{\{ github\.event\.workflow_run\.id \}\}-\$\{\{ github\.event\.workflow_run\.run_attempt \}\}$/m,
    );
  });

  test('checks out trusted default-branch code without credentials', () => {
    const s = step(HISTORY, 'Check out trusted default-branch code');
    assert.equal(indexOf(HISTORY, s.name), 0);
    assert.deepEqual(s.with, { 'persist-credentials': 'false' });
  });

  test('steps run in the reviewed order; the summary always runs last', () => {
    assert.deepEqual(
      steps(HISTORY).map((s) => s.name),
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
        'Plan history addition (dry run)',
        'Publisher pre-check (dry run)',
        'Job summary',
      ],
    );
    assert.equal(step(HISTORY, 'Job summary').if, 'always()');
  });

  test('downloads only by the resolved artifact ID of the triggering run, digest-checked', () => {
    for (const [name, output, kind] of [
      ['Download dashboard snapshot', 'snapshot-id', 'snapshot'],
      ['Download suite results', 'suites-id', 'suites'],
    ] as const) {
      const s = step(HISTORY, name);
      assert.equal(s.uses, DOWNLOAD);
      assert.deepEqual(s.with, {
        'artifact-ids': `\${{ steps.resolve.outputs.${output} }}`,
        'run-id': '${{ steps.resolve.outputs.run-id }}',
        repository: '${{ github.repository }}',
        'github-token': '${{ github.token }}',
        path: `\${{ runner.temp }}/ci-history/download/${kind}`,
        'digest-mismatch': 'error',
      });
      assert.ok(s.if?.startsWith(`steps.resolve.outputs.${output} != ''`), name);
    }
    assert.equal(c.match(/download-artifact@/g)?.length, 2);
  });

  test('later stages run only when the snapshot exists', () => {
    for (const name of [
      'Download suite results',
      'Compose run record',
      'Plan history addition (dry run)',
      'Publisher pre-check (dry run)',
    ]) {
      assert.ok(
        step(HISTORY, name).if?.includes("steps.resolve.outputs.recordable == 'true'"),
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
      /^mkdir -p "\$(RUNNER_TEMP|work)\/[\w/-]+"$/,
      /^npm run -s ci:collect -- context --event "\$GITHUB_EVENT_PATH" --workflow CI --out "\$RUNNER_TEMP\/ci-history\/context\.json"$/,
      /^\.\/node_modules\/\.bin\/tsx reporting\/ci\/handoff-cli\.ts (resolve|compose) --work "\$RUNNER_TEMP\/ci-history"$/,
      /^set -euo pipefail$/,
      /^work="\$RUNNER_TEMP\/ci-history"$/,
      /^\.\/node_modules\/\.bin\/tsx reporting\/ci\/history-cli\.ts plan --history "\$work\/empty-history" --record "\$work\/record\.json" > "\$work\/plan\.json\.tmp"$/,
      /^mv "\$work\/(plan|check)\.json\.tmp" "\$work\/(plan|check)\.json"$/,
      /^sha="\$\(node -p "JSON\.parse\(require\('node:fs'\)\.readFileSync\(process\.argv\[1\], 'utf8'\)\)\.sha256" "\$work\/plan\.json"\)"$/,
      /^node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON reporting\/ci\/publish-check\.mjs --event "\$GITHUB_EVENT_PATH" --record "\$work\/record\.json" --sha256 "\$sha" --history "\$work\/empty-history" > "\$work\/check\.json\.tmp"$/,
      /^if ! \.\/node_modules\/\.bin\/tsx reporting\/ci\/handoff-cli\.ts summary --work "\$RUNNER_TEMP\/ci-history" >> "\$GITHUB_STEP_SUMMARY"; then$/,
      /^printf '## CI history: DRY RUN\\n\\nNothing was published\. [^']*' >> "\$GITHUB_STEP_SUMMARY"$/,
      /^fi$/,
    ];
    const commands = steps(HISTORY).flatMap((s) =>
      (s.run ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== ''),
    );
    assert.ok(commands.length >= 18);
    for (const command of commands) {
      assert.ok(
        allowed.some((pattern) => pattern.test(command)),
        `not a reviewed command: ${command}`,
      );
    }
  });

  test('the token reaches only the resolver (as GITHUB_TOKEN) and the download action', () => {
    const users = steps(HISTORY).filter((s) => s.text.includes('github.token'));
    assert.deepEqual(
      users.map((s) => s.name),
      ['Resolve hand-off artifacts', 'Download dashboard snapshot', 'Download suite results'],
    );
    assert.deepEqual(step(HISTORY, 'Resolve hand-off artifacts').env, {
      GITHUB_TOKEN: '${{ github.token }}',
    });
    assert.equal(step(HISTORY, 'Resolve hand-off artifacts').id, 'resolve');
  });

  test('scripts that redirect output run with pipefail and replace their result only on success', () => {
    for (const name of ['Plan history addition (dry run)', 'Publisher pre-check (dry run)']) {
      const s = step(HISTORY, name);
      assert.equal(s.shell, 'bash', name);
      assert.ok(s.run?.startsWith('set -euo pipefail\n'), name);
    }
  });

  test('YAML is well-formed (Ruby Psych, when available)', (t) => {
    const ruby = spawnSync('ruby', ['-e', 'exit 0'], { encoding: 'utf8' });
    if (ruby.status !== 0) {
      t.skip('ruby is not installed');
      return;
    }
    for (const file of ['ci.yml', 'ci-history.yml']) {
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
