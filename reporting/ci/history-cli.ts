import { randomBytes } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

import {
  defaultSafetyContext,
  type PublicSafetyContext,
  publicSafetyFindings,
} from '../dashboard-data/sanitize';
import { validateRecord } from './collect';
import {
  type Addition,
  HistoryError,
  type HistoryTree,
  INDEX_PATH,
  MAX_INDEX_BYTES,
  MAX_RECORD_BYTES,
  planAddition,
  README_PATH,
  verifyTree,
} from './history';

/**
 * Offline CI history tool over a local directory (not a git checkout operation; no network).
 *
 *   npx tsx reporting/ci/history-cli.ts add --history <dir> --record <file>
 *   npx tsx reporting/ci/history-cli.ts verify --history <dir>
 *
 * Both modes first verify the whole history: the layout, every record against the ci-run 1.0
 * schema and the public-safety scan, canonical bytes and paths, and the index against its schema
 * and against the records. `add` then adds one validated record (a no-op if identical, an error
 * if a different record exists for the same run attempt) and rewrites the index. It prints
 * `{"action", "path", "sha256"}`. Exit 0 on success, 1 otherwise.
 *
 * Record files are created exclusively (a temporary file, then a hard link that fails if the
 * target exists), so an existing run-attempt record is never replaced, even if another process
 * created it after the history was read. The index is replaced atomically (rename). This tool is
 * not a coordinator for concurrent writers: two overlapping additions can leave a stale index,
 * which every later run detects and refuses. Publication itself is coordinated by git (one
 * commit per addition; a rejected push means start again from the latest history).
 *
 * The index's sha256 values are consistency checks, not tamper evidence; see history.ts.
 */

const repoRoot = resolve(__dirname, '..', '..');
const INDEX_SCHEMA = join(__dirname, 'history-index.schema.json');

let indexValidator: ValidateFunction | undefined;
function validateIndex(value: unknown): string[] {
  if (indexValidator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    indexValidator = ajv.compile(JSON.parse(readFileSync(INDEX_SCHEMA, 'utf8')) as object);
  }
  if (indexValidator(value)) return [];
  return (indexValidator.errors ?? []).map(
    (e) => `${INDEX_PATH}: schema ${e.instancePath || '/'} ${e.message ?? 'is invalid'}`,
  );
}

/**
 * Every file under `root` (relative POSIX paths). The root, symlinks and other special files are
 * checked without following links, and no file larger than MAX_INDEX_BYTES (the largest allowed
 * history file) is read.
 */
export function loadTree(root: string): Map<string, string> {
  const tree = new Map<string, string>();
  if (!lstatSync(root).isDirectory()) {
    throw new HistoryError([`${root}: the history must be a directory, not a link or a file`]);
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (path === '.git' || path.startsWith('.git/')) continue;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new HistoryError([`${path}: symbolic links are not allowed`]);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        if (stat.size > MAX_INDEX_BYTES) {
          throw new HistoryError([`${path}: larger than ${String(MAX_INDEX_BYTES)} bytes`]);
        }
        tree.set(path, readFileSync(absolute, 'utf8'));
      } else throw new HistoryError([`${path}: not a regular file`]);
    }
  };
  walk(root);
  return tree;
}

/** Full verification: layout and index (history.ts) plus schema and public safety of every record. */
export function verifyHistory(tree: HistoryTree, safety: PublicSafetyContext): string[] {
  const problems = verifyTree(tree);
  for (const [path, content] of tree) {
    if (!path.startsWith('v1/runs/')) continue;
    let record: unknown;
    try {
      record = JSON.parse(content);
    } catch {
      continue; // reported by verifyTree
    }
    problems.push(...validateRecord(record).map((p) => `${path}: ${p}`));
    problems.push(
      ...publicSafetyFindings(record, safety).map((f) => `${path}: not public-safe: ${f}`),
    );
  }
  const readme = tree.get(README_PATH);
  if (readme !== undefined) {
    problems.push(
      ...publicSafetyFindings({ readme }, safety).map(
        (f) => `${README_PATH}: not public-safe: ${f.replace(/^\/readme: /, '')}`,
      ),
    );
  }
  const index = tree.get(INDEX_PATH);
  if (index !== undefined && Buffer.byteLength(index, 'utf8') <= MAX_INDEX_BYTES) {
    try {
      problems.push(...validateIndex(JSON.parse(index)));
    } catch {
      problems.push(`${INDEX_PATH}: not valid JSON`);
    }
  }
  return problems;
}

export function addRecord(
  tree: HistoryTree,
  content: string,
  safety: PublicSafetyContext,
): ReturnType<typeof planAddition> {
  const existing = verifyHistory(tree, safety);
  if (existing.length > 0)
    throw new HistoryError(['the existing history is not valid:', ...existing]);
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    throw new HistoryError(['the new record is not valid JSON']);
  }
  const problems = [
    ...validateRecord(record),
    ...publicSafetyFindings(record, safety).map((f) => `not public-safe: ${f}`),
  ];
  if (problems.length > 0) throw new HistoryError(['the new record is not valid:', ...problems]);
  return planAddition(tree, content);
}

/** A temporary sibling of `path` with a unique name, created exclusively and always removed. */
function withTemporary<T>(path: string, content: string, use: (temporary: string) => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, content, { flag: 'wx' });
  try {
    return use(temporary);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Creates a file only if it does not exist (a hard link fails with EEXIST); false if it exists. */
function createExclusively(path: string, content: string): boolean {
  return withTemporary(path, content, (temporary) => {
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  });
}

/** Replaces a file atomically: a temporary sibling renamed over the target. */
function replaceAtomically(path: string, content: string): void {
  withTemporary(path, content, (temporary) => {
    renameSync(temporary, path);
  });
}

/**
 * Writes a planned addition into `root`. The record is created exclusively: if a record for the
 * same run attempt appeared since the history was read, identical bytes make the addition a
 * no-op (the index is left to that writer) and different bytes are a conflict; nothing of this
 * addition is written in either case. Only then is the index replaced.
 */
export function writeAddition(root: string, addition: Addition): Addition['action'] {
  if (addition.action === 'unchanged') return 'unchanged';
  const content = addition.tree.get(addition.path) ?? '';
  const target = join(root, addition.path);
  if (!createExclusively(target, content)) {
    if (readFileSync(target, 'utf8') === content) return 'unchanged';
    throw new HistoryError([
      `${addition.path}: a different record was created concurrently; records are never overwritten`,
    ]);
  }
  for (const path of addition.changed) {
    if (path !== addition.path) replaceAtomically(join(root, path), addition.tree.get(path) ?? '');
  }
  return 'add';
}

function option(args: readonly string[], name: string): string {
  const at = args.indexOf(`--${name}`);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith('--'))
    throw new HistoryError([`usage: --${name} is required`]);
  return resolve(value);
}

if (require.main === module) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const root = option(args, 'history');
    const safety = defaultSafetyContext(repoRoot);
    const tree = loadTree(root);
    if (mode === 'verify') {
      const problems = verifyHistory(tree, safety);
      if (problems.length > 0) throw new HistoryError(problems);
      process.stdout.write(
        `${JSON.stringify({ verified: true, records: [...tree.keys()].filter((p) => p.startsWith('v1/runs/')).length })}\n`,
      );
    } else if (mode === 'add') {
      const recordFile = option(args, 'record');
      if (lstatSync(recordFile).size > MAX_RECORD_BYTES) {
        throw new HistoryError([`the new record is larger than ${String(MAX_RECORD_BYTES)} bytes`]);
      }
      const addition = addRecord(tree, readFileSync(recordFile, 'utf8'), safety);
      const action = writeAddition(root, addition);
      process.stdout.write(
        `${JSON.stringify({ action, path: addition.path, sha256: addition.sha256 })}\n`,
      );
    } else {
      throw new HistoryError([
        'usage: history-cli.ts add|verify --history <dir> [--record <file>]',
      ]);
    }
  } catch (error) {
    if (error instanceof HistoryError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
