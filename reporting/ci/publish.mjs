// CI history publisher (Phase 5.3 M3d-2). Dependency-free: plain Node.js (22.18 or later, which
// strips TypeScript types) and the dependency-free modules of this repository, so the
// write-capable job installs no packages and runs no code but this repository's.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON reporting/ci/publish.mjs \
//     --event <workflow_run event.json> --history <checkout of ci-history>
//
//   CI_HISTORY_RECORD_B64     the canonical record, base64 (from the read-only compose job)
//   CI_HISTORY_RECORD_SHA256  its SHA-256 (hex)
//
// Before any write, everything is checked again, independently of the compose job:
//   - the run context, derived here from the trusted workflow_run event (completed push or
//     workflow_dispatch run on main of this repository; pull requests and forks refused);
//   - the payload: strict canonical base64, at most MAX_PAYLOAD_BYTES, strict UTF-8, then
//     publish-check (identity bound to the event, canonical bytes, SHA-256, public safety);
//   - the destination: a clean git checkout of exactly refs/heads/ci-history whose only remote
//     is this repository on github.com, and GITHUB_REPOSITORY (when set) is the same repository;
//   - the existing history: layout, canonical bytes, index determinism (history.ts) and the
//     public-safety scan of every record and of README.md.
// Then exactly the new record and the rebuilt index are written, committed by the Actions bot
// and pushed with the explicit refspec refs/heads/ci-history:refs/heads/ci-history. There is no
// force push and no other ref. A non-fast-forward rejection (another publisher won a race) is
// retried a bounded number of times from the new remote state, recomputing the index instead of
// merging; any other rejection fails at once. The same record already present is a no-op; a
// different record for the same run attempt is a hard failure. The branch is never created.
//
// Full ci-run schema validation is done by the read-only compose job (with its dependencies);
// this job checks provenance, integrity, safety and immutability, not that test results are true.
// Prints {"result":"published"|"unchanged","path","sha256","commit","attempts"}; exit 0 or 1.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { defaultSafetyContext, publicSafetyFindings } from '../dashboard-data/sanitize.ts';
import { ContextError, contextFromWorkflowRunEvent } from './context.ts';
import {
  HistoryError,
  INDEX_PATH,
  MAX_INDEX_BYTES,
  MAX_PAYLOAD_BYTES,
  planAddition,
  README_PATH,
  verifyTree,
} from './history.ts';
import { MAX_EVENT_BYTES, PublishCheckError, publishCheck, WORKFLOW } from './publish-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const BRANCH_REF = 'refs/heads/ci-history';
export const PUSH_REFSPEC = `${BRANCH_REF}:${BRANCH_REF}`;
export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
export const DEFAULT_ATTEMPTS = 3;
export const MAX_ATTEMPTS = 5;
const RUN_PATH = /^v1\/runs\/[1-9][0-9]*-[1-9][0-9]*\.json$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class PublishError extends Error {
  constructor(problems) {
    super(`CI history publication refused:\n  ${problems.join('\n  ')}`);
    this.name = 'PublishError';
    this.problems = problems;
  }
}

const decodeUtf8 = (bytes, label) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PublishError([`${label} is not valid UTF-8`]);
  }
};

/** The trusted workflow_run event: a regular file within MAX_EVENT_BYTES, strict UTF-8 JSON. */
export function readEvent(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    throw new PublishError(['the event is missing or not a regular file']);
  }
  if (stat.size > MAX_EVENT_BYTES) {
    throw new PublishError([`the event is larger than ${String(MAX_EVENT_BYTES)} bytes`]);
  }
  try {
    return JSON.parse(decodeUtf8(readFileSync(path), 'the event'));
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError(['the event is not JSON']);
  }
}

/** The record text from its base64 hand-off: canonical base64, bounded, strict UTF-8. */
export function decodePayload(base64) {
  if (typeof base64 !== 'string' || base64 === '') {
    throw new PublishError(['the record payload is missing']);
  }
  if (base64.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4) {
    throw new PublishError([
      `the record payload is larger than ${String(MAX_PAYLOAD_BYTES)} bytes`,
    ]);
  }
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) {
    throw new PublishError(['the record payload is not base64']);
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) {
    throw new PublishError(['the record payload is not canonical base64']);
  }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new PublishError([
      `the record payload is larger than ${String(MAX_PAYLOAD_BYTES)} bytes`,
    ]);
  }
  return decodeUtf8(bytes, 'the record payload');
}

/** Lines of git's error output, with anything that looks like a credential removed. */
const gitMessage = (stderr) =>
  stderr
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-3)
    .map((line) =>
      /authorization|bearer|basic |x-access-token|password/i.test(line) ? '[redacted]' : line,
    )
    .join(' / ');

function git(cwd, args, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', ...env },
  });
  if (result.error !== undefined) throw new PublishError([`git ${args[0]} could not run`]);
  if (!allowFailure && result.status !== 0) {
    throw new PublishError([`git ${args[0]} failed: ${gitMessage(result.stderr)}`]);
  }
  return result;
}

/** The checkout must be exactly refs/heads/ci-history of this repository, clean. */
export function checkDestination(history, context, environment = process.env) {
  const problems = [];
  const stat = lstatSync(history, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new PublishError(['the history checkout must be a directory, not a link or a file']);
  }
  const top = git(history, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(history)) {
    throw new PublishError(['the history directory is not the top of a git checkout']);
  }
  const head = git(history, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }).stdout.trim();
  if (head !== BRANCH_REF) problems.push(`the checkout is on "${head}", not ${BRANCH_REF}`);
  const remotes = git(history, ['remote'])
    .stdout.split('\n')
    .filter((r) => r !== '');
  if (remotes.length !== 1 || remotes[0] !== 'origin') {
    problems.push('the checkout must have exactly one remote, origin');
  }
  const url = git(history, ['config', '--get', 'remote.origin.url'], { allowFailure: true });
  const expected = `https://github.com/${context.repository}`;
  if (url.stdout.trim() !== expected && url.stdout.trim() !== `${expected}.git`) {
    problems.push(`origin is not ${expected}`);
  }
  const pushUrl = git(history, ['config', '--get-all', 'remote.origin.pushurl'], {
    allowFailure: true,
  });
  if (pushUrl.stdout.trim() !== '') problems.push('origin has a separate push URL');
  const repository = environment['GITHUB_REPOSITORY'];
  if (repository !== undefined && repository !== '' && repository !== context.repository) {
    problems.push('GITHUB_REPOSITORY differs from the event repository');
  }
  if (git(history, ['status', '--porcelain', '--untracked-files=all']).stdout !== '') {
    problems.push('the checkout has local changes');
  }
  if (problems.length > 0) throw new PublishError(problems);
}

/** Every file of the checkout except .git: no links, no special files, bounded, strict UTF-8. */
export function loadTree(root) {
  const tree = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (path === '.git') continue;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new PublishError([`${path}: symbolic links are not allowed`]);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        if (stat.size > MAX_INDEX_BYTES) {
          throw new PublishError([`${path}: larger than ${String(MAX_INDEX_BYTES)} bytes`]);
        }
        tree.set(path, decodeUtf8(readFileSync(absolute), path));
      } else throw new PublishError([`${path}: not a regular file`]);
    }
  };
  walk(root);
  return tree;
}

/** Layout, canonical bytes and index (history.ts), plus public safety of records and README. */
export function verifyExisting(tree, safety) {
  const problems = verifyTree(tree);
  for (const [path, content] of tree) {
    let value;
    if (path === README_PATH) value = { readme: content };
    else {
      try {
        value = JSON.parse(content);
      } catch {
        continue; // reported by verifyTree
      }
    }
    problems.push(
      ...publicSafetyFindings(value, safety).map((f) => `${path}: not public-safe: ${f}`),
    );
  }
  if (problems.length > 0) {
    throw new PublishError(['the existing ci-history branch is not valid:', ...problems]);
  }
}

/** Writes exactly the planned files: the record created exclusively, the index replaced. */
function writeAddition(history, addition) {
  for (const path of addition.changed) {
    if (path !== INDEX_PATH && !RUN_PATH.test(path)) {
      throw new PublishError([`${path}: not a history path`]);
    }
    const target = join(history, path);
    mkdirSync(dirname(target), { recursive: true });
    const content = addition.tree.get(path) ?? '';
    if (path === addition.path) writeFileSync(target, content, { flag: 'wx' });
    else {
      const temporary = `${target}.tmp-${String(process.pid)}`;
      writeFileSync(temporary, content, { flag: 'wx' });
      renameSync(temporary, target);
    }
  }
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** One commit with exactly the planned paths, whose tree is exactly the planned tree. */
function commitAddition(history, addition, base, context) {
  git(history, ['add', '--', ...addition.changed]);
  const staged = git(history, ['diff', '--cached', '--name-only', '-z'])
    .stdout.split('\0')
    .filter(Boolean);
  if (!sameSet(staged, addition.changed)) {
    throw new PublishError(['the staged files differ from the planned addition']);
  }
  const message = `ci-history: add run ${String(context.runId)} attempt ${String(context.runAttempt)}\n\nRecord ${addition.path}, sha256 ${addition.sha256}.\n`;
  git(
    history,
    [
      '-c',
      `user.name=${BOT_NAME}`,
      '-c',
      `user.email=${BOT_EMAIL}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    {
      // Environment identity variables take precedence over -c user.*; both are the bot's.
      env: {
        GIT_AUTHOR_NAME: BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_NAME: BOT_NAME,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
      },
    },
  );
  const commit = git(history, ['rev-parse', 'HEAD']).stdout.trim();
  const identity = git(history, ['show', '-s', '--format=%an <%ae>%n%cn <%ce>', 'HEAD']).stdout;
  if (identity !== `${BOT_NAME} <${BOT_EMAIL}>\n${BOT_NAME} <${BOT_EMAIL}>\n`) {
    throw new PublishError(['the new commit is not authored and committed by the Actions bot']);
  }
  const parent = git(history, ['rev-parse', 'HEAD^']).stdout.trim();
  const files = git(history, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
    .stdout.split('\0')
    .filter(Boolean);
  if (parent !== base || !sameSet(files, [...addition.tree.keys()])) {
    throw new PublishError([
      'the new commit is not exactly the planned addition on the current branch',
    ]);
  }
  if (git(history, ['status', '--porcelain', '--untracked-files=all']).stdout !== '') {
    throw new PublishError(['files outside the planned addition remain in the checkout']);
  }
  return commit;
}

/** Rejections that mean another writer moved the branch first; anything else is final. */
const RACE_REJECTIONS = [
  /\[rejected\] \((fetch first|non-fast-forward)\)/,
  /\[remote rejected\] \((cannot lock ref|failed to update ref|incorrect old value)/,
];

/** "pushed", or "behind" (another writer moved the branch; retryable); any other result throws. */
function push(history) {
  const result = git(history, ['push', '--porcelain', 'origin', PUSH_REFSPEC], {
    allowFailure: true,
  });
  if (result.status === 0) return 'pushed';
  const line = result.stdout.split('\n').find((l) => l.includes(`\t${PUSH_REFSPEC}\t`)) ?? '';
  if (line.startsWith('!') && RACE_REJECTIONS.some((pattern) => pattern.test(line)))
    return 'behind';
  throw new PublishError([`the push was rejected: ${gitMessage(`${line}\n${result.stderr}`)}`]);
}

/** Fetches the current branch tip into the checkout; the branch is never created. */
function syncToRemote(history) {
  const fetched = git(history, ['fetch', '--no-tags', '--quiet', 'origin', BRANCH_REF], {
    allowFailure: true,
  });
  if (fetched.status !== 0) {
    throw new PublishError([
      /couldn't find remote ref/i.test(fetched.stderr)
        ? `${BRANCH_REF} does not exist; it is created once, by hand, never by the publisher`
        : `git fetch failed: ${gitMessage(fetched.stderr)}`,
    ]);
  }
  const base = git(history, ['rev-parse', 'FETCH_HEAD']).stdout.trim();
  if (!SHA1.test(base)) throw new PublishError(['the fetched branch tip is not a commit']);
  git(history, ['reset', '--hard', '--quiet', base]);
  git(history, ['clean', '-fdq']);
  return base;
}

/**
 * Publishes one record. `env` supplies the payload variables and GITHUB_REPOSITORY; `delayMs`
 * is the base wait between attempts (it grows per attempt, with jitter).
 */
export async function publish({
  eventPath,
  history,
  env = process.env,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = 2000,
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new PublishError([`attempts must be between 1 and ${String(MAX_ATTEMPTS)}`]);
  }
  const event = readEvent(eventPath);
  const context = contextFromWorkflowRunEvent(event, WORKFLOW);
  const expectedSha256 = env['CI_HISTORY_RECORD_SHA256'] ?? '';
  if (!SHA256.test(expectedSha256))
    throw new PublishError(['CI_HISTORY_RECORD_SHA256 is missing or malformed']);
  const text = decodePayload(env['CI_HISTORY_RECORD_B64']);
  const safety = defaultSafetyContext(repoRoot);
  // Payload checks that do not depend on the branch, before the destination is touched.
  publishCheck({ event, text, expectedSha256, readExisting: () => null, safety });
  checkDestination(history, context, env);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const base = syncToRemote(history);
    const tree = loadTree(history);
    verifyExisting(tree, safety);
    const checked = publishCheck({
      event,
      text,
      expectedSha256,
      readExisting: (path) => tree.get(path) ?? null,
      safety,
    });
    if (checked.action === 'unchanged') {
      return {
        result: 'unchanged',
        path: checked.path,
        sha256: checked.sha256,
        commit: base,
        attempts: attempt,
      };
    }
    const addition = planAddition(tree, text);
    if (addition.action !== 'add' || addition.path !== checked.path) {
      throw new PublishError(['the plan does not match the publish check']);
    }
    writeAddition(history, addition);
    const commit = commitAddition(history, addition, base, context);
    const outcome = push(history);
    if (outcome === 'pushed') {
      const remote = git(history, ['ls-remote', '--heads', 'origin', BRANCH_REF]).stdout.split(
        '\t',
      )[0];
      if (remote !== commit)
        throw new PublishError(['the remote branch is not at the pushed commit']);
      return {
        result: 'published',
        path: addition.path,
        sha256: addition.sha256,
        commit,
        attempts: attempt,
      };
    }
    if (attempt === attempts) {
      throw new PublishError([
        `the branch kept moving; gave up after ${String(attempts)} attempts`,
      ]);
    }
    await sleep(delayMs * attempt + Math.floor(Math.random() * delayMs));
  }
  throw new PublishError(['unreachable']);
}

/** A job summary of fixed text and re-validated values only. */
export function summary(outcome) {
  const path = RUN_PATH.test(outcome.path) ? outcome.path : '?';
  const sha = SHA256.test(outcome.sha256) ? outcome.sha256 : '?';
  const commit = SHA1.test(outcome.commit) ? outcome.commit : '?';
  return [
    '## CI history: publish',
    '',
    outcome.result === 'published'
      ? `Published \`${path}\` (sha256 \`${sha}\`) in commit \`${commit}\` on ci-history, attempt ${String(outcome.attempts)}.`
      : `Already published: \`${path}\` (sha256 \`${sha}\`) is on ci-history at \`${commit}\`; nothing was written.`,
    '',
  ].join('\n');
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith('--'))
    throw new PublishError([`usage: --${name} is required`]);
  return value;
}

// The entry point, compared by real path: a symlinked or aliased path must not skip the program
// (which would exit 0 having done nothing).
if (
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    const attemptsArg = args.includes('--attempts')
      ? Number(option(args, 'attempts'))
      : DEFAULT_ATTEMPTS;
    const delayArg = process.env['CI_HISTORY_RETRY_DELAY_MS'];
    const outcome = await publish({
      eventPath: resolve(option(args, 'event')),
      history: resolve(option(args, 'history')),
      attempts: attemptsArg,
      delayMs: delayArg !== undefined && /^[0-9]{1,5}$/.test(delayArg) ? Number(delayArg) : 2000,
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
    if (summaryFile !== undefined && summaryFile !== '')
      appendFileSync(summaryFile, summary(outcome));
  } catch (error) {
    if (
      error instanceof PublishError ||
      error instanceof PublishCheckError ||
      error instanceof ContextError ||
      error instanceof HistoryError
    ) {
      console.error(error.message);
    } else {
      console.error(
        `CI history publication failed: unexpected ${error instanceof Error ? error.name : 'error'}`,
      );
    }
    process.exit(1);
  }
}
