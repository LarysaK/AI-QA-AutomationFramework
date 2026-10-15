import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

import {
  discoveryEnvironment,
  type ListRunner,
  runPlaywrightList,
} from '../../agents/orchestrator/validation/discovery-guard';
import { SnapshotError } from './spec-source';

/**
 * The committed Playwright test inventory, from Playwright's own discovery
 * (`playwright test --list --reporter=json` with the approved configuration), never from
 * scanning test source text: tags can be computed at runtime.
 *
 * Discovery imports the test modules, so their top-level code runs (test bodies, global setup
 * and the AUT do not), together with the configuration and the support code they import. It is
 * therefore run only on the repository's own `tests/` directory, and only when every discovery
 * input is clean in git (DISCOVERY_INPUTS): staged proposals under `artifacts/` and uncommitted
 * test or support files are never loaded through the inventory.
 *
 * This is a git-based cleanliness gate, not a sandbox. Discovery runs with the user's
 * permissions; the gate cannot see files git is told to ignore changes to (`skip-worktree`,
 * `assume-unchanged`) or changes made between the check and discovery, and it does not stop code
 * that committed files themselves choose to run.
 */

export const TESTS_DIR = 'tests';

/** Everything `playwright test --list` can load from the repository; all must be clean. */
export const DISCOVERY_INPUTS: readonly string[] = [
  TESTS_DIR,
  'apps',
  'framework',
  'playwright.config.ts',
  'tsconfig.json',
  'package.json',
];

export interface TestInstance {
  /** Playwright's spec ID, stable between `--list` and run reports. */
  readonly id: string;
  /** Repository-relative path. */
  readonly file: string;
  readonly line: number;
  readonly title: string;
  /** Titles of the enclosing `describe` blocks, outermost first. */
  readonly describePath: readonly string[];
  readonly projects: readonly string[];
  readonly tags: {
    readonly requirements: readonly string[];
    readonly testCases: readonly string[];
    readonly canonicals: readonly string[];
  };
}

export interface Inventory {
  readonly playwrightVersion: string;
  readonly instances: readonly TestInstance[];
}

/** What the inventory needs from git. Injectable for tests. */
export interface GitProbe {
  /** Repository-relative paths of files tracked under `dir`. */
  trackedFiles(dir: string): ReadonlySet<string>;
  /**
   * Repository-relative paths under `paths` that are modified, staged, type-changed or untracked,
   * and ignored files that Node could load (scripts, JSON). Throws if git reports an entry it
   * cannot classify.
   */
  uncommittedPaths(paths: readonly string[]): readonly string[];
  head(): string;
}

export interface ApprovedIdSets {
  readonly requirements: ReadonlySet<string>;
  readonly testCases: ReadonlySet<string>;
  readonly canonicals: ReadonlySet<string>;
}

const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const LOADABLE = /\.([cm]?[jt]sx?|json|node)$/;
const ID_TAG = /^(REQ|TC|CAN)-/i;
const FORMATS: Record<string, RegExp> = {
  REQ: /^REQ-\d{3}$/,
  TC: /^TC-\d{3}-\d{2}$/,
  CAN: /^CAN-\d{3}$/,
};

interface ListedSpec {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly tags?: unknown;
  readonly tests?: readonly { readonly projectName?: unknown }[];
}

interface ListedSuite {
  readonly title?: unknown;
  readonly file?: unknown;
  readonly specs?: readonly ListedSpec[];
  readonly suites?: readonly ListedSuite[];
}

interface ListReport {
  readonly config?: { readonly rootDir?: unknown; readonly version?: unknown };
  readonly suites?: readonly ListedSuite[];
  readonly errors?: readonly unknown[];
}

export function discoverInventory(
  repoRoot: string,
  approved: ApprovedIdSets,
  git: GitProbe,
  runList: ListRunner = runPlaywrightList,
): Inventory {
  // Before discovery: an uncommitted test, support module or configuration file would be loaded.
  const uncommitted = git.uncommittedPaths(DISCOVERY_INPUTS);
  if (uncommitted.length > 0) {
    throw new SnapshotError([
      `uncommitted changes in discovery inputs ${DISCOVERY_INPUTS.join(', ')} (commit or stash them; nothing was discovered): ${uncommitted.join(', ')}`,
    ]);
  }
  const run = runList(repoRoot, discoveryEnvironment());
  if (run.timedOut) throw new SnapshotError(['playwright test --list timed out']);
  if (run.error !== undefined) {
    throw new SnapshotError([`playwright test --list could not start: ${run.error}`]);
  }
  let report: ListReport;
  try {
    report = JSON.parse(run.stdout) as ListReport;
  } catch {
    throw new SnapshotError([
      `playwright test --list did not produce a JSON report (exit ${String(run.exitCode)})`,
    ]);
  }
  // Report errors and stderr can contain local paths; only their count is reported.
  if (run.exitCode !== 0 || (report.errors?.length ?? 0) > 0) {
    throw new SnapshotError([
      `playwright test --list failed (exit ${String(run.exitCode)}, ${String(report.errors?.length ?? 0)} error(s)); run it locally for details`,
    ]);
  }
  return mapListReport(report, repoRoot, approved, git);
}

/** Maps a `--list` JSON report to inventory records, copying allowlisted fields only. */
export function mapListReport(
  report: ListReport,
  repoRoot: string,
  approved: ApprovedIdSets,
  git: GitProbe,
): Inventory {
  const problems: string[] = [];
  const rootDir = typeof report.config?.rootDir === 'string' ? report.config.rootDir : '';
  if (resolve(rootDir) !== resolve(repoRoot, TESTS_DIR)) {
    throw new SnapshotError([
      `Playwright discovered tests outside the repository's ${TESTS_DIR}/ directory`,
    ]);
  }
  const version = typeof report.config?.version === 'string' ? report.config.version : '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push('Playwright version is missing');

  const tracked = git.trackedFiles(TESTS_DIR);
  const instances: TestInstance[] = [];
  const walk = (suite: ListedSuite, describePath: readonly string[]): void => {
    for (const spec of suite.specs ?? []) {
      const instance = mapSpec(spec, describePath, rootDir, repoRoot, approved, tracked, problems);
      if (instance) instances.push(instance);
    }
    for (const child of suite.suites ?? []) {
      const title = typeof child.title === 'string' ? child.title : '';
      // Playwright nests file suites (title = file name) above describe suites.
      walk(child, isFileSuite(child) ? describePath : [...describePath, title]);
    }
  };
  for (const suite of report.suites ?? []) walk(suite, []);

  const ids = instances.map((instance) => instance.id);
  if (new Set(ids).size !== ids.length) problems.push('Playwright reported duplicate spec IDs');
  if (instances.length === 0) problems.push('Playwright discovered no tests');

  if (problems.length > 0) throw new SnapshotError(problems);

  return { playwrightVersion: version, instances: [...instances].sort(byFileLineId) };
}

function mapSpec(
  spec: ListedSpec,
  describePath: readonly string[],
  rootDir: string,
  repoRoot: string,
  approved: ApprovedIdSets,
  tracked: ReadonlySet<string>,
  problems: string[],
): TestInstance | undefined {
  if (
    typeof spec.id !== 'string' ||
    typeof spec.title !== 'string' ||
    typeof spec.file !== 'string' ||
    typeof spec.line !== 'number'
  ) {
    problems.push('Playwright reported a spec without id, title, file or line');
    return undefined;
  }
  const file = relative(repoRoot, resolve(rootDir, spec.file)).split(sep).join('/');
  const where = `${file}:${String(spec.line)}`;
  if (!file.startsWith(`${TESTS_DIR}/`) || !TEST_FILE.test(file)) {
    problems.push(`${where}: not a test file under ${TESTS_DIR}/`);
    return undefined;
  }
  if (!tracked.has(file)) {
    problems.push(`${where}: not tracked by git; only committed tests are inventoried`);
    return undefined;
  }

  const tags = {
    requirements: [] as string[],
    testCases: [] as string[],
    canonicals: [] as string[],
  };
  const rawTags = Array.isArray(spec.tags) ? (spec.tags as unknown[]) : [];
  for (const raw of rawTags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/^@/, '');
    const prefix = ID_TAG.exec(tag)?.[1];
    if (prefix === undefined) continue; // non-traceability tags are not part of the snapshot
    const kind = prefix.toUpperCase();
    const known =
      kind === 'REQ'
        ? approved.requirements
        : kind === 'TC'
          ? approved.testCases
          : approved.canonicals;
    if (!(FORMATS[kind]?.test(tag) ?? false)) {
      problems.push(`${where}: malformed ${kind} tag "@${tag}"`);
    } else if (!known.has(tag)) {
      problems.push(`${where}: unknown ${kind} tag "@${tag}" (not in the approved documents)`);
    } else {
      const list =
        kind === 'REQ' ? tags.requirements : kind === 'TC' ? tags.testCases : tags.canonicals;
      if (!list.includes(tag)) list.push(tag);
    }
  }

  const projects = [
    ...new Set(
      (spec.tests ?? []).map((test) =>
        typeof test.projectName === 'string' ? test.projectName : '',
      ),
    ),
  ].sort();
  if (projects.length === 0 || projects.includes('')) {
    problems.push(`${where}: test has no project`);
  }

  return {
    id: spec.id,
    file,
    line: spec.line,
    title: spec.title,
    describePath,
    projects,
    tags: {
      requirements: tags.requirements.sort(),
      testCases: tags.testCases.sort(),
      canonicals: tags.canonicals.sort(),
    },
  };
}

function isFileSuite(suite: ListedSuite): boolean {
  return (
    typeof suite.title === 'string' && typeof suite.file === 'string' && suite.title === suite.file
  );
}

function byFileLineId(a: TestInstance, b: TestInstance): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The real git probe, run in `repoRoot`. Any git failure stops the build. */
export function gitProbe(repoRoot: string): GitProbe {
  const git = (args: readonly string[]): string => {
    const result = spawnSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: discoveryEnvironment(),
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new SnapshotError([`git ${args[0] ?? ''} failed; is this a git checkout?`]);
    }
    return result.stdout;
  };
  return {
    trackedFiles: (dir) =>
      new Set(
        git(['ls-files', '-z', '--', dir])
          .split('\0')
          .filter((path) => path !== ''),
      ),
    uncommittedPaths: (paths) =>
      uncommittedFromStatus(
        git(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored', '--', ...paths]),
      ),
    head: () => {
      const sha = git(['rev-parse', 'HEAD']).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new SnapshotError(['git HEAD is not a commit SHA']);
      return sha;
    },
  };
}

/** Porcelain v1 status codes: index (X) and worktree (Y), or `??` untracked, `!!` ignored. */
const STATUS = /^([ MTADRCU][ MTADRCU]|\?\?|!!) (.+)$/;

/**
 * Parses `git status --porcelain -z` output into the paths that block discovery: every entry
 * except ignored files Node cannot load. Renames and copies also report their source path. An
 * entry that does not match the format fails closed.
 */
export function uncommittedFromStatus(output: string): string[] {
  const entries = output.split('\0');
  if (entries[entries.length - 1] === '') entries.pop();
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const match = STATUS.exec(entries[i] ?? '');
    if (!match?.[1] || !match[2]) {
      throw new SnapshotError(['git status reported an entry that cannot be classified']);
    }
    const [code, path] = [match[1], match[2]];
    if (code !== '!!' || LOADABLE.test(path)) paths.push(path);
    if (/[RC]/.test(code) && code !== '??' && code !== '!!') {
      const source = entries[(i += 1)];
      if (source === undefined || source === '') {
        throw new SnapshotError(['git status reported a rename without its source path']);
      }
      paths.push(source);
    }
  }
  return [...new Set(paths)].sort();
}
