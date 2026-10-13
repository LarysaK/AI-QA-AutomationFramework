import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { isInside } from '../validation/proposed-state';
import { GeneratorStop } from './select';

/**
 * Staging under `artifacts/proposals/<taskId>/`. Every file is written only after the whole set
 * passed the secret scan, and never outside the task directory.
 *
 * The staged files can contain raw model output and approved repository content; treat them as
 * potentially sensitive local files even when the scan passes. `artifacts/` is gitignored and
 * ignored by TypeScript, ESLint, Prettier and Playwright.
 */

export interface StagedFile {
  /** Relative to the task directory. */
  readonly path: string;
  readonly content: string;
}

/** Credential values from the environment, plus generic key patterns (defense in depth). */
export function findSecrets(
  files: readonly StagedFile[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
    .map((name) => [name, env[name]] as const)
    .filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1].length >= 8,
    );
  const patterns: readonly (readonly [string, RegExp])[] = [
    ['an Anthropic key pattern (sk-ant-…)', /sk-ant-[A-Za-z0-9_-]{10,}/],
    ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  const problems: string[] = [];
  for (const file of files) {
    for (const [name, value] of values) {
      if (file.content.includes(value)) problems.push(`${file.path} contains the value of ${name}`);
    }
    for (const [label, pattern] of patterns) {
      if (pattern.test(file.content)) problems.push(`${file.path} contains ${label}`);
    }
  }
  return problems;
}

/** Writes the files into a new task directory under `proposalsRoot`. Returns the directory. */
export function stage(
  proposalsRoot: string,
  taskId: string,
  files: readonly StagedFile[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secrets = findSecrets(files, env);
  if (secrets.length > 0)
    throw new GeneratorStop(`nothing staged; possible secrets found: ${secrets.join('; ')}`);

  const taskDir = resolve(proposalsRoot, taskId);
  if (!isInside(resolve(proposalsRoot), taskDir) || taskDir === resolve(proposalsRoot)) {
    throw new GeneratorStop(`task directory escapes the proposals root: ${taskId}`);
  }
  for (const file of files) {
    const target = resolve(taskDir, file.path);
    if (!isInside(taskDir, target) || target === taskDir) {
      throw new GeneratorStop(`refusing to stage ${file.path}: it resolves outside ${taskDir}`);
    }
  }

  mkdirSync(proposalsRoot, { recursive: true });
  try {
    mkdirSync(taskDir); // exclusive: an existing task directory is never overwritten
  } catch {
    throw new GeneratorStop(`task directory already exists: ${taskDir}`);
  }
  for (const file of files) {
    const target = join(taskDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  return taskDir;
}

/** Whether a model-proposed path can safely name a preview file (no repair if not). */
export function isSafeRelativePath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}
