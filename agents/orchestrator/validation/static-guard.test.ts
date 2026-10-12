import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { checkStatic, runNpmScript, type ScriptRunner } from './static-guard';
import type { Artifact, GuardResult } from './types';
import { ENVELOPE_SCHEMA_PATH, validateArtifact } from './validate';

/**
 * G-STATIC tests. "Real" tests run the approved scripts on a temporary copy of this
 * repository, which is only read. Stub-runner tests inspect the temporary copy from inside
 * the runner; symlink tests use a small throwaway Git repository.
 */

const REPO = resolve('.');

type Change = Artifact['proposedChanges'][number] & { readonly content: string };

const proposal = (...changes: Change[]) => ({
  agent: { name: 'generator' as const },
  proposedChanges: changes,
});

const create = (
  path: string,
  content: string,
  changeKind: Change['changeKind'] = 'support-change',
): Change => ({
  path,
  changeKind,
  operation: 'create',
  content,
});

const modify = (path: string, content: string): Change => ({
  path,
  changeKind: 'support-change',
  operation: 'modify',
  content,
});

const VALID_TEST = [
  "import { expect, test } from '@playwright/test';",
  '',
  "test('static guard fixture', () => {",
  '  expect(1 + 1).toBe(2);',
  '});',
  '',
].join('\n');

const SUPPORT_FIXTURE = 'apps/requestflow/data/static-guard-fixture.ts';

/** A fingerprint of everything Git can see in the working tree, plus Git's own view of it. */
function fingerprint(root: string): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const hash = createHash('sha256');
  hash.update(git('status', '--porcelain=v1', '-uall'));
  hash.update(git('ls-files', '-s'));
  for (const path of git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(
    '\0',
  )) {
    if (path !== '' && existsSync(join(root, path)))
      hash.update(path).update(readFileSync(join(root, path)));
  }
  return hash.digest('hex');
}

/** The real npm runner, recording each temporary copy it is run in. */
const realCopies = new Set<string>();
const real: ScriptRunner = (script, cwd) => {
  realCopies.add(cwd);
  return runNpmScript(script, cwd);
};

function firstReason(result: GuardResult): string {
  return result.failures[0]?.reason ?? '';
}

function failedScripts(result: GuardResult): string[] {
  return result.failures.map(
    (failure) => /^npm run (\S+)/.exec(failure.reason)?.[1] ?? failure.reason,
  );
}

// ---------------------------------------------------------------- real static checks

describe('G-STATIC: real checks on a copy of this repository', () => {
  let before_: string;

  before(() => {
    before_ = fingerprint(REPO);
  });

  test('a valid new test passes', () => {
    const result = checkStatic(
      proposal(
        create('tests/requestflow/api/static-guard-fixture.spec.ts', VALID_TEST, 'test-change'),
      ),
      REPO,
      real,
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
  });

  test('several valid changes pass together (create a test, modify support code)', () => {
    const path = 'apps/requestflow/data/demo-users.ts';
    const extended = `${readFileSync(join(REPO, path), 'utf8')}\nexport const STATIC_GUARD_MARKER = 'marker';\n`;
    const result = checkStatic(
      proposal(
        create('tests/requestflow/api/static-guard-fixture.spec.ts', VALID_TEST, 'test-change'),
        modify(path, extended),
      ),
      REPO,
      real,
    );
    assert.equal(result.status, 'passed', JSON.stringify(result.failures, null, 2));
  });

  test('a TypeScript error fails typecheck only', () => {
    const result = checkStatic(
      proposal(create(SUPPORT_FIXTURE, "export const total: number = 'not a number';\n")),
      REPO,
      real,
    );
    assert.deepEqual(failedScripts(result), ['typecheck']);
    assert.deepEqual(result.failures[0]?.ruleIds, ['STD-TST-001']);
    assert.match(firstReason(result), /apps\/requestflow\/data\/static-guard-fixture\.ts.*TS2322/);
    assert.doesNotMatch(firstReason(result), /agents-static-/);
  });

  test('an ESLint error fails lint only', () => {
    const content = 'export function parse(value: string): any {\n  return JSON.parse(value);\n}\n';
    const result = checkStatic(proposal(create(SUPPORT_FIXTURE, content)), REPO, real);
    assert.deepEqual(failedScripts(result), ['lint']);
    assert.deepEqual(result.failures[0]?.ruleIds, ['STD-TST-001', 'STD-TST-002']);
    assert.match(firstReason(result), /no-explicit-any/);
  });

  test('a formatting error fails format:check only', () => {
    const result = checkStatic(
      proposal(create(SUPPORT_FIXTURE, 'export const greeting = "hello";\n')),
      REPO,
      real,
    );
    assert.deepEqual(failedScripts(result), ['format:check']);
    assert.match(firstReason(result), /static-guard-fixture\.ts/);
  });

  test('a support change that breaks an unchanged canonical test fails typecheck', () => {
    const path = 'apps/requestflow/pages/request-details.page.ts';
    const original = readFileSync(join(REPO, path), 'utf8');
    const approveMethod =
      '\n  async approve(): Promise<void> {\n    await this.approveButton.click();\n  }\n';
    assert.ok(original.includes(approveMethod), 'fixture precondition: approve() exists');
    const result = checkStatic(
      proposal(modify(path, original.replace(approveMethod, ''))),
      REPO,
      real,
    );
    // Type-aware lint rules fail too once the canonical test no longer type-checks.
    assert.ok(failedScripts(result).includes('typecheck'), JSON.stringify(failedScripts(result)));
    assert.doesNotMatch(failedScripts(result).join(), /format:check/);
    assert.match(firstReason(result), /tests\/requestflow\/e2e\/approve-request\.spec\.ts.*TS2339/);
  });

  test('the approved repository is unchanged and every temporary copy is removed', () => {
    assert.equal(fingerprint(REPO), before_);
    assert.ok(
      existsSync(join(REPO, 'node_modules', 'typescript')),
      'shared node_modules must survive cleanup',
    );
    assert.ok(realCopies.size >= 6, 'every real test ran in a temporary copy');
    for (const copy of realCopies)
      assert.equal(existsSync(copy), false, `${copy} should be removed`);
  });
});

// ---------------------------------------------------------------- materialization and cleanup

describe('G-STATIC: materialization and cleanup (stub runner)', () => {
  test('proposed content is written into the copy exactly; ignored files and .git are not copied', () => {
    const nested = 'apps/requestflow/data/nested/deep/new.ts';
    const modified = 'apps/requestflow/data/demo-users.ts';
    const seen: Record<string, unknown> = {};
    const inspect: ScriptRunner = (script, cwd) => {
      if (script === 'typecheck') {
        seen['nested'] = readFileSync(join(cwd, nested), 'utf8');
        seen['modified'] = readFileSync(join(cwd, modified), 'utf8');
        seen['untouched'] = readFileSync(join(cwd, 'package.json'), 'utf8');
        seen['modulesIsLink'] = lstatSync(join(cwd, 'node_modules')).isSymbolicLink();
        seen['modulesTarget'] = realpathSync(join(cwd, 'node_modules'));
        seen['git'] = existsSync(join(cwd, '.git'));
        seen['artifacts'] = existsSync(join(cwd, 'artifacts', 'results'));
        seen['inside'] = !cwd.startsWith(realpathSync(REPO));
      }
      return { exitCode: 0, output: '', timedOut: false };
    };
    const result = checkStatic(
      proposal(create(nested, 'export const a = 1;\n'), modify(modified, '// replaced\n')),
      REPO,
      inspect,
    );
    assert.equal(result.status, 'passed');
    assert.deepEqual(seen, {
      nested: 'export const a = 1;\n',
      modified: '// replaced\n',
      untouched: readFileSync(join(REPO, 'package.json'), 'utf8'),
      modulesIsLink: true,
      modulesTarget: realpathSync(join(REPO, 'node_modules')),
      git: false,
      artifacts: false,
      inside: true,
    });
  });

  test('all three scripts run even after a failure, each reported once', () => {
    const scripts: string[] = [];
    const failing: ScriptRunner = (script) => {
      scripts.push(script);
      return { exitCode: 1, output: `${script} problem`, timedOut: false };
    };
    const result = checkStatic(proposal(), REPO, failing);
    assert.deepEqual(scripts, ['typecheck', 'lint', 'format:check']);
    assert.deepEqual(failedScripts(result), ['typecheck', 'lint', 'format:check']);
  });

  test('a timeout is a failure, never a pass', () => {
    const result = checkStatic(proposal(), REPO, () => ({
      exitCode: null,
      output: '',
      timedOut: true,
    }));
    assert.equal(result.status, 'failed');
    assert.match(firstReason(result), /timed out after 120 s/);
  });

  test('the copy is removed on success, on failure and when the runner throws', () => {
    const copies: string[] = [];
    const record =
      (outcome: 'pass' | 'fail' | 'throw'): ScriptRunner =>
      (_script, cwd) => {
        copies.push(cwd);
        if (outcome === 'throw') throw new Error('runner crashed');
        return { exitCode: outcome === 'pass' ? 0 : 1, output: '', timedOut: false };
      };
    checkStatic(proposal(), REPO, record('pass'));
    checkStatic(proposal(), REPO, record('fail'));
    assert.throws(() => checkStatic(proposal(), REPO, record('throw')), /runner crashed/);
    assert.ok(copies.length > 0);
    for (const copy of copies) assert.equal(existsSync(copy), false, `${copy} should be removed`);
  });
});

// ---------------------------------------------------------------- symlink safety

describe('G-STATIC: symlink safety', () => {
  let root: string;
  let outside: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'agents-static-src-'));
    outside = mkdtempSync(join(tmpdir(), 'agents-static-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside the repository\n');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'src', 'real.ts'), 'export const real = 1;\n');
    symlinkSync('real.ts', join(root, 'src', 'inside-link.ts'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'escaping-link.txt'));
    symlinkSync(outside, join(root, 'src', 'escaping-dir'));
    execFileSync('git', ['init', '-q'], { cwd: root });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('links escaping the repository are not copied; in-repository links stay inside the copy', () => {
    const seen: Record<string, unknown> = {};
    checkStatic(proposal(), root, (script, cwd) => {
      if (script === 'typecheck') {
        seen['escapingFile'] = existsSync(join(cwd, 'src', 'escaping-link.txt'));
        seen['escapingDir'] = existsSync(join(cwd, 'src', 'escaping-dir'));
        seen['insideLink'] = lstatSync(join(cwd, 'src', 'inside-link.ts')).isSymbolicLink();
        seen['insideTarget'] =
          realpathSync(join(cwd, 'src', 'inside-link.ts')) === join(cwd, 'src', 'real.ts');
      }
      return { exitCode: 0, output: '', timedOut: false };
    });
    assert.deepEqual(seen, {
      escapingFile: false,
      escapingDir: false,
      insideLink: true,
      insideTarget: true,
    });
  });

  test('a proposed change cannot write outside the copy', () => {
    const runner: ScriptRunner = () => ({ exitCode: 0, output: '', timedOut: false });
    const outsideName = `agents-static-escape-${String(process.pid)}.ts`;
    const traversal = checkStatic(proposal(create(`../${outsideName}`, 'x')), root, runner);
    assert.equal(traversal.status, 'failed');
    assert.match(firstReason(traversal), /outside the temporary copy/);
    assert.equal(existsSync(join(tmpdir(), outsideName)), false);

    const throughLink = checkStatic(proposal(modify('src/inside-link.ts', 'x')), root, runner);
    assert.equal(throughLink.status, 'failed');
    assert.match(firstReason(throughLink), /target is a symlink/);
    assert.equal(readFileSync(join(root, 'src', 'real.ts'), 'utf8'), 'export const real = 1;\n');
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside the repository\n');
  });
});

// ---------------------------------------------------------------- pipeline

describe('G-STATIC in the guard pipeline', () => {
  test('is skipped, and runs no script, when an earlier guard fails', () => {
    let calls = 0;
    const results = validateArtifact(
      { artifactType: 'test-proposal' },
      {
        repoRoot: REPO,
        schemaPath: resolve(ENVELOPE_SCHEMA_PATH),
        runScript: () => ((calls += 1), { exitCode: 0, output: '', timedOut: false }),
      },
    );
    assert.equal(results.find((result) => result.guard === 'G-STATIC')?.status, 'skipped');
    assert.equal(calls, 0);
  });
});
