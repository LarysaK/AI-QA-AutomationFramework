import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Artifact, GuardFailure, GuardResult } from './types';

/**
 * G-BASE (STD-AUTH-003): a proposal is only valid against the files it was written for.
 *
 * - create: the target must not exist yet.
 * - modify: the target must exist and its current Git blob SHA must equal `baseSha`.
 *
 * Nothing is written; proposed content is never applied here.
 */
export function checkBase(artifact: Artifact, repoRoot: string): GuardResult {
  const failures: GuardFailure[] = [];
  const fail = (path: string, reason: string): void => {
    failures.push({ guard: 'G-BASE', ruleIds: ['STD-AUTH-003'], path, reason });
  };

  for (const { path, operation, baseSha } of artifact.proposedChanges) {
    const absolutePath = resolve(repoRoot, path);
    const exists = existsSync(absolutePath);

    if (operation === 'create') {
      if (exists) fail(path, 'operation "create" but the file already exists');
      continue;
    }

    if (!exists) {
      fail(path, 'operation "modify" but the file does not exist');
    } else if (!statSync(absolutePath).isFile()) {
      fail(path, 'operation "modify" but the path is not a file');
    } else if (baseSha === undefined) {
      fail(path, 'operation "modify" without baseSha');
    } else {
      const current = gitBlobSha(
        readFileSync(absolutePath),
        baseSha.length === 64 ? 'sha256' : 'sha1',
      );
      if (current !== baseSha) {
        fail(
          path,
          `stale proposal: baseSha ${baseSha} does not match the current file (${current})`,
        );
      }
    }
  }

  return { guard: 'G-BASE', status: failures.length === 0 ? 'passed' : 'failed', failures };
}

/**
 * Git blob object ID of the given bytes: hash of `blob <size>\0<content>`.
 * Equivalent to `git hash-object --no-filters <file>` for the working-tree content.
 */
export function gitBlobSha(content: Buffer, algorithm: 'sha1' | 'sha256' = 'sha1'): string {
  return createHash(algorithm)
    .update(`blob ${String(content.length)}\0`)
    .update(content)
    .digest('hex');
}
