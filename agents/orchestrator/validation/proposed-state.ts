import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The proposed repository state, materialized in a temporary directory for guards that check
 * it as a whole (G-STATIC, G-DISCOVERY). Each call creates its own fresh copy.
 *
 * 1. Copy the working tree as Git sees it (tracked files plus untracked, non-ignored files),
 *    without following symlinks out of the repository.
 * 2. Write every proposed create/modify change into the copy, never outside it.
 * 3. Hand the copy to the caller, then delete it, whatever happened.
 *
 * The approved repository is never written (STD-AUTH-004).
 *
 * Limitation: `node_modules` is shared with the approved repository through a symlink
 * (a junction on Windows). This is safe only because the approved tooling commands write no
 * caches or generated output into it; adding such output to them requires revisiting this.
 */

export interface ProposedFile {
  readonly path: string;
  readonly content: string;
}

/** A reason the proposed state could not be built; nothing was run. */
export interface ProposedStateProblem {
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly path?: string;
}

export type ProposedStateOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly ProposedStateProblem[] };

export function withProposedState<T>(
  repoRoot: string,
  files: readonly ProposedFile[],
  prefix: string,
  use: (copy: string) => T,
): ProposedStateOutcome<T> {
  const root = realpathSync(repoRoot);
  const copy = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    const setupError = createCopy(root, copy);
    if (setupError)
      return { ok: false, problems: [{ ruleIds: ['STD-AUTH-004'], reason: setupError }] };

    const problems: ProposedStateProblem[] = [];
    for (const file of files) {
      const refused = writeIntoCopy(copy, file.path, file.content);
      if (refused)
        problems.push({
          ruleIds: ['STD-AUTH-002', 'STD-AUTH-004'],
          reason: refused,
          path: file.path,
        });
    }
    if (problems.length > 0) return { ok: false, problems };

    return { ok: true, value: use(copy) };
  } finally {
    // Removes the node_modules link itself; the linked directory is not followed.
    rmSync(copy, { recursive: true, force: true });
  }
}

/** Copies the working tree as Git sees it into `copy` and links node_modules. Returns an error, if any. */
function createCopy(root: string, copy: string): string | undefined {
  let listing: string;
  try {
    listing = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
  } catch {
    return 'cannot list repository files with git';
  }

  for (const path of listing.split('\0').filter((entry) => entry !== '')) {
    if (path === 'node_modules' || path.startsWith('node_modules/')) continue;
    const source = join(root, path);
    const target = join(copy, path);
    let stats;
    try {
      stats = lstatSync(source);
    } catch {
      continue; // tracked but deleted in the working tree
    }

    if (stats.isSymbolicLink()) {
      // Never follow links: recreate in-repository links inside the copy; omit escaping ones.
      let real: string;
      try {
        real = realpathSync(source);
      } catch {
        continue; // dangling link
      }
      if (!isInside(root, real)) continue;
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(relative(dirname(source), real), target);
    } else if (stats.isFile()) {
      if (!isInside(root, realpathSync(source))) continue;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }

  const modules = join(root, 'node_modules');
  if (!existsSync(modules)) return 'node_modules is missing; run npm install in the repository';
  symlinkSync(modules, join(copy, 'node_modules'), 'junction');
  return undefined;
}

/** Writes one proposed file into the copy. Returns a reason when the write is refused. */
function writeIntoCopy(copy: string, path: string, content: string): string | undefined {
  const target = resolve(copy, path);
  if (isAbsolute(path) || !isInside(copy, target))
    return 'refused: target resolves outside the temporary copy';

  // The nearest existing ancestor must still be inside the copy once symlinks are resolved.
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!isInside(copy, realpathSync(existing))) {
    return 'refused: target resolves outside the temporary copy through a symlink';
  }
  if (existing === target && lstatSync(target).isSymbolicLink()) {
    return 'refused: target is a symlink';
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return undefined;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const MAX_OUTPUT_LINES = 30;

/** Trims tool output to a readable size and turns temporary-copy paths into repository paths. */
export function formatOutput(output: string, copy: string): string {
  const lines = output
    .split(copy + sep)
    .join('')
    .split(copy)
    .join('.')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  if (lines.length === 0) return '';
  const shown = lines.slice(0, MAX_OUTPUT_LINES);
  const more = lines.length - shown.length;
  return `:\n${shown.join('\n')}${more > 0 ? `\n… ${String(more)} more lines` : ''}`;
}
