import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import { composed } from './handoff.test';
import { buildIndex, canonicalJson, sha256 } from './history';

/**
 * The CI history publisher (publish.mjs, plain Node.js) against real local git repositories: a
 * bare repository stands in for GitHub, and the checkout's origin keeps the real
 * https://github.com/... URL, redirected to the bare repository with `url.<path>.insteadOf` (git
 * configuration of the test checkout only). The event fixture and the API data behind the record
 * are synthetic. Races are produced with client-side hooks in the test checkout; a real publish
 * checkout is a fresh actions/checkout clone, which has no hooks.
 */

const REPO = resolve('.');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const PUBLISH = join(__dirname, 'publish.mjs');
const REPOSITORY = 'LarysaK/AI-QA-AutomationFramework';
const REPO_URL = `https://github.com/${REPOSITORY}`;
const EVENT_FIXTURE = join(__dirname, 'fixtures/github/workflow-run-event-39144953322.json');
const README = '# CI history\n\nData only. Records are immutable.\n';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temporary = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Git with no user or system configuration, a fixed identity and no prompts. */
const GIT_ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

interface Remote {
  readonly bare: string;
  /** The ci-history tip and main tip right after setup. */
  readonly tip: string;
  readonly main: string;
}

/** A bare "GitHub" with a main branch and an orphan ci-history holding `files`. */
function remote(files: Record<string, string> = { 'README.md': README }): Remote {
  const root = temporary('ci-publish-remote-');
  const bare = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'source.txt'), 'application source\n');
  git(seed, 'add', '--', 'source.txt');
  git(seed, 'commit', '-q', '-m', 'main');
  git(seed, 'switch', '-q', '--orphan', 'ci-history');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(seed, path, '..'), { recursive: true });
    writeFileSync(join(seed, path), content);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'ci-history: initialize');
  git(
    seed,
    'push',
    '-q',
    bare,
    'refs/heads/main:refs/heads/main',
    'refs/heads/ci-history:refs/heads/ci-history',
  );
  return { bare, tip: branchTip(bare, 'ci-history'), main: branchTip(bare, 'main') };
}

const branchTip = (bare: string, branch: string): string =>
  git(bare, 'rev-parse', `refs/heads/${branch}`).trim();

const refs = (bare: string): string =>
  git(bare, 'for-each-ref', '--format=%(refname) %(objectname)');

/** A publish checkout: like actions/checkout of ci-history, origin is the github.com URL. */
function checkout(r: Remote): string {
  const dir = join(temporary('ci-publish-checkout-'), 'history');
  git(tmpdir(), 'clone', '-q', '-b', 'ci-history', r.bare, dir);
  git(dir, 'remote', 'set-url', 'origin', REPO_URL);
  git(dir, 'config', `url.${r.bare}.insteadOf`, REPO_URL);
  return dir;
}

/** A client-side hook in the test checkout (production checkouts have none). */
function hook(dir: string, name: string, script: string): void {
  const path = join(dir, '.git', 'hooks', name);
  writeFileSync(
    path,
    `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n${script}\n`,
  );
  chmodSync(path, 0o755);
}

function eventFile(
  change: (e: Record<string, Record<string, unknown>>) => void = () => undefined,
): string {
  const event = JSON.parse(readFileSync(EVENT_FIXTURE, 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
  change(event);
  const file = join(temporary('ci-publish-event-'), 'event.json');
  writeFileSync(file, JSON.stringify(event));
  return file;
}
const attemptEvent = (attempt: number): string =>
  eventFile((e) => {
    (e['workflow_run'] as Record<string, unknown>)['run_attempt'] = attempt;
  });

let baseRecord: string | undefined;
async function record(
  attempt = 1,
  change: (r: Record<string, unknown>) => void = () => undefined,
): Promise<string> {
  baseRecord ??= (await composed()).text;
  const value = JSON.parse(baseRecord) as Record<string, Record<string, unknown>>;
  (value['run'] as Record<string, unknown>)['attempt'] = attempt;
  change(value);
  return canonicalJson(value);
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outcome:
    { result: string; path: string; sha256: string; commit: string; attempts: number } | undefined;
}

function publish(
  history: string,
  text: string,
  options: {
    event?: string;
    env?: Record<string, string>;
    attempts?: number;
    b64?: string;
    sha?: string;
  } = {},
): Run {
  const result = spawnSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      PUBLISH,
      '--event',
      options.event ?? EVENT_FIXTURE,
      '--history',
      history,
      ...(options.attempts === undefined ? [] : ['--attempts', String(options.attempts)]),
    ],
    {
      // Plain Node.js: no tsx loader, no inherited options, run from outside the repository.
      cwd: tmpdir(),
      encoding: 'utf8',
      env: {
        ...GIT_ENV,
        CI_HISTORY_RECORD_B64: options.b64 ?? Buffer.from(text, 'utf8').toString('base64'),
        CI_HISTORY_RECORD_SHA256: options.sha ?? sha256(text),
        CI_HISTORY_RETRY_DELAY_MS: '0',
        GITHUB_REPOSITORY: REPOSITORY,
        ...options.env,
      },
    },
  );
  let outcome: Run['outcome'];
  try {
    outcome = result.status === 0 ? (JSON.parse(result.stdout) as Run['outcome']) : undefined;
  } catch {
    outcome = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outcome };
}

/** The branch as a fresh clone sees it, checked by the full-schema history-cli verify. */
function verifyRemote(bare: string): { records: number; files: string[] } {
  const dir = join(temporary('ci-publish-verify-'), 'clone');
  git(tmpdir(), 'clone', '-q', '-b', 'ci-history', bare, dir);
  const result = spawnSync(TSX, [join(__dirname, 'history-cli.ts'), 'verify', '--history', dir], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const files = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n');
  return { records: (JSON.parse(result.stdout) as { records: number }).records, files };
}

function refused(run: Run, reason: RegExp): void {
  assert.equal(run.status, 1, `expected a refusal, got ${String(run.status)}: ${run.stdout}`);
  assert.match(run.stderr, reason);
}

// ---------------------------------------------------------------- publishing

describe('publisher: publishing (local git remote, synthetic event)', () => {
  test('first publication to the README-only branch: one commit, the record and the index', async () => {
    const r = remote();
    const text = await record();
    const run = publish(checkout(r), text);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.deepEqual(run.outcome, {
      result: 'published',
      path: 'v1/runs/39144953322-1.json',
      sha256: sha256(text),
      commit: branchTip(r.bare, 'ci-history'),
      attempts: 1,
    });
    const tip = branchTip(r.bare, 'ci-history');
    assert.equal(
      git(r.bare, 'rev-parse', `${tip}^`).trim(),
      r.tip,
      'exactly one new commit on top',
    );
    assert.equal(
      git(r.bare, 'show', '-s', '--format=%an <%ae>|%cn <%ce>|%s', tip).trim(),
      'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|ci-history: add run 39144953322 attempt 1',
    );
    assert.equal(
      git(r.bare, 'show', `${tip}:v1/runs/39144953322-1.json`),
      text,
      'the exact canonical bytes',
    );
    const index = git(r.bare, 'show', `${tip}:v1/index.json`);
    assert.equal(index, canonicalJson(buildIndex(new Map([['v1/runs/39144953322-1.json', text]]))));
    assert.deepEqual(verifyRemote(r.bare), {
      records: 1,
      files: ['README.md', 'v1/index.json', 'v1/runs/39144953322-1.json'],
    });
    assert.equal(branchTip(r.bare, 'main'), r.main, 'main is never touched');
  });

  test('the same run attempt again is a no-op: no commit, from the same or a fresh checkout', async () => {
    const r = remote();
    const text = await record();
    const history = checkout(r);
    assert.equal(publish(history, text).status, 0);
    const before = refs(r.bare);
    for (const dir of [history, checkout(r)]) {
      const again = publish(dir, text);
      assert.equal(again.status, 0, again.stderr);
      assert.ok(again.outcome);
      assert.equal(again.outcome.result, 'unchanged');
      assert.equal(again.outcome.commit, branchTip(r.bare, 'ci-history'));
    }
    assert.equal(refs(r.bare), before);
  });

  test('a different record for an already published run attempt is a hard failure', async () => {
    const r = remote();
    assert.equal(publish(checkout(r), await record()).status, 0);
    const before = refs(r.bare);
    const conflicting = await record(1, (v) => {
      (v['environment'] as Record<string, unknown>)['node'] = '22.0.0';
    });
    refused(
      publish(checkout(r), conflicting),
      /a different record already exists for this run attempt; records are never overwritten/,
    );
    assert.equal(refs(r.bare), before);
  });

  test('a rerun (attempt 2) adds its own record; the index orders both deterministically', async () => {
    const r = remote();
    const first = await record(1);
    const second = await record(2);
    assert.equal(publish(checkout(r), first).status, 0);
    const run = publish(checkout(r), second, { event: attemptEvent(2) });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.outcome?.path, 'v1/runs/39144953322-2.json');
    const tip = branchTip(r.bare, 'ci-history');
    assert.equal(
      git(r.bare, 'show', `${tip}:v1/index.json`),
      canonicalJson(
        buildIndex(
          new Map([
            ['v1/runs/39144953322-1.json', first],
            ['v1/runs/39144953322-2.json', second],
          ]),
        ),
      ),
    );
    assert.equal(verifyRemote(r.bare).records, 2);
  });

  test('writes a fixed-text job summary with the published path, digest and commit', async () => {
    const r = remote();
    const text = await record();
    const file = join(temporary('ci-publish-summary-'), 'summary.md');
    writeFileSync(file, '');
    assert.equal(publish(checkout(r), text, { env: { GITHUB_STEP_SUMMARY: file } }).status, 0);
    assert.equal(
      readFileSync(file, 'utf8'),
      `## CI history: publish\n\nPublished \`v1/runs/39144953322-1.json\` (sha256 \`${sha256(text)}\`) in commit \`${branchTip(r.bare, 'ci-history')}\` on ci-history, attempt 1.\n`,
    );
  });
});

// ---------------------------------------------------------------- races and retries

describe('publisher: races and bounded retries', () => {
  /** A second writer that adds a valid (empty) commit to ci-history when its hook fires. */
  function rival(r: Remote): string {
    const dir = join(temporary('ci-publish-rival-'), 'rival');
    git(tmpdir(), 'clone', '-q', '-b', 'ci-history', r.bare, dir);
    return dir;
  }
  const rivalPush = (dir: string): string =>
    `git -C '${dir}' -c user.name=rival -c user.email=rival@example.invalid commit -q --allow-empty -m rival && git -C '${dir}' push -q origin HEAD:refs/heads/ci-history`;

  test('the branch moves after the fetch (fetch first): retried from the new tip, then published', async () => {
    const r = remote();
    const history = checkout(r);
    const marker = join(temporary('ci-publish-marker-'), 'fired');
    hook(
      history,
      'post-commit',
      `[ -e '${marker}' ] || { touch '${marker}'; ${rivalPush(rival(r))}; }`,
    );
    const run = publish(history, await record());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.outcome?.attempts, 2);
    const tip = branchTip(r.bare, 'ci-history');
    assert.equal(
      git(r.bare, 'log', '--format=%s', '-3', tip).trim().split('\n').join('|'),
      'ci-history: add run 39144953322 attempt 1|rival|ci-history: initialize',
    );
    assert.equal(verifyRemote(r.bare).records, 1);
  });

  test('the branch moves during the push (lock race): retried, then published', async () => {
    const r = remote();
    const history = checkout(r);
    const marker = join(temporary('ci-publish-marker-'), 'fired');
    hook(
      history,
      'pre-push',
      `[ -e '${marker}' ] || { touch '${marker}'; ${rivalPush(rival(r))}; }`,
    );
    const run = publish(history, await record());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.outcome?.attempts, 2);
    assert.equal(verifyRemote(r.bare).records, 1);
  });

  test('a branch that keeps moving: gives up after the bounded attempts, never forces', async () => {
    const r = remote();
    const history = checkout(r);
    hook(history, 'post-commit', rivalPush(rival(r)));
    const run = publish(history, await record(), { attempts: 3 });
    refused(run, /the branch kept moving; gave up after 3 attempts/);
    const tip = branchTip(r.bare, 'ci-history');
    assert.equal(
      git(r.bare, 'log', '--format=%s', tip).trim().split('\n').join('|'),
      'rival|rival|rival|ci-history: initialize',
      'only the rival commits, nothing overwritten',
    );
  });

  test('a rejection by a repository rule is final: no retry', async () => {
    const r = remote();
    const hookPath = join(r.bare, 'hooks', 'pre-receive');
    writeFileSync(
      hookPath,
      '#!/bin/sh\necho "push declined due to repository rule violations" >&2\nexit 1\n',
    );
    chmodSync(hookPath, 0o755);
    const before = refs(r.bare);
    refused(publish(checkout(r), await record()), /the push was rejected/);
    assert.equal(refs(r.bare), before);
  });

  test('concurrent publishers of different attempts: every record lands, the index is consistent', async () => {
    const r = remote();
    const texts = await Promise.all([1, 2, 3].map((a) => record(a)));
    const runs = await Promise.all(
      texts.map(
        (text, i) =>
          new Promise<number | null>((done) => {
            const child = spawn(
              process.execPath,
              [
                '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
                PUBLISH,
                '--event',
                attemptEvent(i + 1),
                '--history',
                checkout(r),
                '--attempts',
                '5',
              ],
              {
                cwd: tmpdir(),
                stdio: 'ignore',
                env: {
                  ...GIT_ENV,
                  CI_HISTORY_RECORD_B64: Buffer.from(text, 'utf8').toString('base64'),
                  CI_HISTORY_RECORD_SHA256: sha256(text),
                  CI_HISTORY_RETRY_DELAY_MS: '50',
                  GITHUB_REPOSITORY: REPOSITORY,
                },
              },
            );
            child.on('close', done);
          }),
      ),
    );
    assert.deepEqual(runs, [0, 0, 0]);
    const tip = branchTip(r.bare, 'ci-history');
    const expected = new Map(texts.map((t, i) => [`v1/runs/39144953322-${String(i + 1)}.json`, t]));
    assert.equal(git(r.bare, 'show', `${tip}:v1/index.json`), canonicalJson(buildIndex(expected)));
    assert.equal(verifyRemote(r.bare).records, 3);
    assert.equal(git(r.bare, 'rev-list', '--count', tip).trim(), '4');
  });
});

// ---------------------------------------------------------------- destination

describe('publisher: destination checks before any write', () => {
  const cases: [string, (dir: string) => void, RegExp, Record<string, string>?][] = [
    [
      'an origin of another repository',
      (d) => git(d, 'remote', 'set-url', 'origin', 'https://github.com/someone/else'),
      /origin is not https:\/\/github\.com\/LarysaK\/AI-QA-AutomationFramework/,
    ],
    [
      'a checkout of another branch',
      (d) => git(d, 'switch', '-q', '-c', 'main-like'),
      /the checkout is on "refs\/heads\/main-like", not refs\/heads\/ci-history/,
    ],
    [
      'a second remote',
      (d) => git(d, 'remote', 'add', 'mirror', 'https://example.invalid/x'),
      /exactly one remote, origin/,
    ],
    [
      'a separate push URL',
      (d) => git(d, 'remote', 'set-url', '--push', 'origin', 'https://github.com/someone/else'),
      /origin has a separate push URL/,
    ],
    [
      'local changes in the checkout',
      (d) => {
        writeFileSync(join(d, 'stray.txt'), 'x');
      },
      /the checkout has local changes/,
    ],
    [
      'another GITHUB_REPOSITORY',
      () => undefined,
      /GITHUB_REPOSITORY differs from the event repository/,
      { GITHUB_REPOSITORY: 'someone/else' },
    ],
  ];
  for (const [name, change, reason, env] of cases) {
    test(`refuses ${name}`, async () => {
      const r = remote();
      const history = checkout(r);
      change(history);
      const before = refs(r.bare);
      refused(publish(history, await record(), env === undefined ? {} : { env }), reason);
      assert.equal(refs(r.bare), before);
    });
  }

  test('refuses a commit that contains more than the planned addition (e.g. added by a hook)', async () => {
    const r = remote();
    const history = checkout(r);
    hook(history, 'pre-commit', "printf 'x\\n' > stray.txt && git add -- stray.txt");
    const before = refs(r.bare);
    refused(
      publish(history, await record()),
      /the new commit is not exactly the planned addition on the current branch/,
    );
    assert.equal(refs(r.bare), before);
  });

  test('refuses a commit that is not authored by the Actions bot (e.g. amended by a hook)', async () => {
    const r = remote();
    const history = checkout(r);
    const marker = join(temporary('ci-publish-marker-'), 'amended');
    hook(
      history,
      'post-commit',
      `[ -e '${marker}' ] || { touch '${marker}'; GIT_AUTHOR_NAME=someone GIT_AUTHOR_EMAIL=someone@example.invalid git commit -q --amend --no-edit --reset-author; }`,
    );
    const before = refs(r.bare);
    refused(
      publish(history, await record()),
      /the new commit is not authored and committed by the Actions bot/,
    );
    assert.equal(refs(r.bare), before);
  });

  test('refuses a directory that is not the top of a checkout', async () => {
    const r = remote();
    const history = checkout(r);
    mkdirSync(join(history, 'v1'), { recursive: true });
    refused(publish(join(history, 'v1'), await record()), /not the top of a git checkout/);
  });

  test('never creates the branch: a missing ci-history is a failure', async () => {
    const r = remote();
    const history = checkout(r);
    git(r.bare, 'update-ref', '-d', 'refs/heads/ci-history');
    refused(
      publish(history, await record()),
      /refs\/heads\/ci-history does not exist; it is created once, by hand, never by the publisher/,
    );
    assert.equal(
      spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/ci-history'], {
        cwd: r.bare,
        env: GIT_ENV,
      }).status,
      1,
    );
  });

  test('runs through a symlinked path: the entry-point guard never turns into a silent exit 0', async () => {
    const link = join(temporary('ci-publish-link-'), 'tools');
    symlinkSync(join(REPO, 'reporting'), link);
    const run = (script: string, args: string[]) =>
      spawnSync(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(link, 'ci', script), ...args],
        {
          cwd: tmpdir(),
          encoding: 'utf8',
          env: GIT_ENV,
        },
      );
    for (const script of ['publish.mjs', 'publish-check.mjs']) {
      const refusedRun = run(script, [
        '--event',
        join(tmpdir(), 'no-such-event.json'),
        '--record',
        'x',
        '--sha256',
        'y',
        '--history',
        'z',
      ]);
      assert.equal(refusedRun.status, 1, `${script} must refuse, not exit 0 silently`);
      assert.match(refusedRun.stderr, /event is missing/);
    }
    assert.match(
      run('event-shape.mjs', [EVENT_FIXTURE]).stdout,
      /^### workflow_run event: field shapes/,
    );
    // And a real publication through the symlinked path.
    const r = remote();
    const text = await record();
    const published = spawnSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        join(link, 'ci', 'publish.mjs'),
        '--event',
        EVENT_FIXTURE,
        '--history',
        checkout(r),
      ],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: {
          ...GIT_ENV,
          CI_HISTORY_RECORD_B64: Buffer.from(text, 'utf8').toString('base64'),
          CI_HISTORY_RECORD_SHA256: sha256(text),
          GITHUB_REPOSITORY: REPOSITORY,
        },
      },
    );
    assert.equal(published.status, 0, published.stderr);
    assert.equal((JSON.parse(published.stdout) as { result: string }).result, 'published');
    assert.notEqual(branchTip(r.bare, 'ci-history'), r.tip);
  });

  test('pushes one explicit refspec, never forced, never another ref (source check)', () => {
    const source = readFileSync(PUBLISH, 'utf8');
    assert.match(source, /export const PUSH_REFSPEC = `\$\{BRANCH_REF\}:\$\{BRANCH_REF\}`;/);
    assert.match(source, /export const BRANCH_REF = 'refs\/heads\/ci-history';/);
    assert.equal(source.match(/'push'/g)?.length, 1);
    assert.match(source, /\['push', '--porcelain', 'origin', PUSH_REFSPEC\]/);
    assert.doesNotMatch(
      source,
      /--force|force-with-lease|'-f'|\+refs|refs\/heads\/main|--mirror|--all\b|--delete/,
    );
  });

  test('is dependency-free: Node.js built-ins and dependency-free repository modules', () => {
    const imports = (file: string): string[] =>
      [...readFileSync(file, 'utf8').matchAll(/^import [^;]* from '([^']+)';$/gm)].map(
        (m) => m[1] ?? '',
      );
    assert.deepEqual(
      imports(PUBLISH).filter((s) => !s.startsWith('node:')),
      ['../dashboard-data/sanitize.ts', './context.ts', './history.ts', './publish-check.mjs'],
    );
  });
});

// ---------------------------------------------------------------- payload and event

describe('publisher: payload and event validation before any write', () => {
  const cases: [
    string,
    (text: string) => Promise<{ b64?: string; sha?: string; event?: string; text?: string }>,
    RegExp,
  ][] = [
    ['a missing payload', () => Promise.resolve({ b64: '' }), /the record payload is missing/],
    [
      'a payload that is not base64',
      () => Promise.resolve({ b64: 'not base64!' }),
      /the record payload is not base64/,
    ],
    [
      'non-canonical base64',
      () => Promise.resolve({ b64: 'QR==' }),
      /the record payload is not canonical base64/,
    ],
    [
      'an oversized payload',
      () => Promise.resolve({ b64: Buffer.alloc(64 * 1024 + 1, 0x20).toString('base64') }),
      /the record payload is larger than 65536 bytes/,
    ],
    [
      'bytes that are not UTF-8',
      () => Promise.resolve({ b64: Buffer.from([0x7b, 0xff, 0x7d]).toString('base64') }),
      /the record payload is not valid UTF-8/,
    ],
    [
      'a missing SHA-256',
      () => Promise.resolve({ sha: '' }),
      /CI_HISTORY_RECORD_SHA256 is missing or malformed/,
    ],
    [
      'a SHA-256 that does not match',
      () => Promise.resolve({ sha: 'f'.repeat(64) }),
      /sha256 does not match the value handed over/,
    ],
    [
      'a record that is not canonical',
      (t) => Promise.resolve({ text: JSON.stringify(JSON.parse(t)) }),
      /the record is not in canonical form/,
    ],
    [
      'a record of another attempt than the event',
      () => record(2).then((t) => ({ text: t })),
      /run attempt differs from the event/,
    ],
    [
      'a record that is not public-safe',
      () =>
        record(1, (v) => {
          ((v['steps'] as Record<string, unknown>[])[0] as Record<string, unknown>)['name'] =
            'see /Users/someone/x';
        }).then((t) => ({ text: t })),
      /not public-safe: \/steps\/0\/name: absolute path/,
    ],
    [
      'a pull request event',
      () =>
        Promise.resolve({
          event: eventFile((e) => {
            (e['workflow_run'] as Record<string, unknown>)['event'] = 'pull_request';
          }),
        }),
      /"pull_request" runs are not recorded/,
    ],
    [
      'a fork',
      () =>
        Promise.resolve({
          event: eventFile((e) => {
            (e['workflow_run'] as Record<string, unknown>)['head_repository'] = {
              full_name: 'someone/fork',
            };
          }),
        }),
      /a fork/,
    ],
    [
      'another branch',
      () =>
        Promise.resolve({
          event: eventFile((e) => {
            (e['workflow_run'] as Record<string, unknown>)['head_branch'] = 'feature';
          }),
        }),
      /head_branch is not main/,
    ],
  ];
  for (const [name, make, reason] of cases) {
    test(`refuses ${name}`, async () => {
      const r = remote();
      const base = await record();
      const { text = base, ...options } = await make(base);
      const before = refs(r.bare);
      refused(publish(checkout(r), text, options), reason);
      assert.equal(refs(r.bare), before);
    });
  }
});

// ---------------------------------------------------------------- existing history

describe('publisher: an invalid existing branch is never extended', () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    [
      'an unexpected file',
      { 'README.md': README, 'notes.txt': 'x\n' },
      /notes\.txt: not part of the history layout/,
    ],
    [
      'an unsafe README',
      { 'README.md': `${README}Contact someone@example.com\n` },
      /README\.md: not public-safe: \/readme: e-mail address/,
    ],
    [
      'an index without records',
      { 'README.md': README, 'v1/index.json': '{}\n' },
      /v1\/index\.json/,
    ],
    [
      'a record without an index',
      { 'README.md': README, 'v1/runs/1-1.json': '{}\n' },
      /v1\/index\.json: missing|v1\/runs\/1-1\.json/,
    ],
  ];
  for (const [name, files, reason] of cases) {
    test(`refuses ${name}`, async () => {
      const r = remote(files);
      const before = refs(r.bare);
      refused(publish(checkout(r), await record()), reason);
      assert.equal(refs(r.bare), before);
    });
  }

  test('refuses a symbolic link on the branch', async () => {
    const r = remote();
    const seed = join(temporary('ci-publish-link-'), 'seed');
    git(tmpdir(), 'clone', '-q', '-b', 'ci-history', r.bare, seed);
    symlinkSync('README.md', join(seed, 'link.md'));
    git(seed, 'add', '--', 'link.md');
    git(seed, 'commit', '-q', '-m', 'link');
    git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/ci-history');
    const before = refs(r.bare);
    refused(publish(checkout(r), await record()), /link\.md: symbolic links are not allowed/);
    assert.equal(refs(r.bare), before);
    assert.ok(existsSync(r.bare));
  });
});
