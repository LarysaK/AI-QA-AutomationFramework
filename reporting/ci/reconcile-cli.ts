import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { defaultSafetyContext } from '../dashboard-data/sanitize';
import { type Fetch, MAX_API_RESPONSE_BYTES } from './handoff';
import { canonicalJson, HistoryError } from './history';
import { loadTree, verifyHistory } from './history-cli';
import { auditHistoryLog, exitCode, fetchApiData, markdown, reconcile } from './reconcile';

/**
 * Read-only CI history reconciliation (Phase 5.3 M3e).
 *
 *   npx tsx reporting/ci/reconcile-cli.ts --history <checkout of ci-history>
 *        [--repository owner/name] [--api <dir>] [--format json|markdown]
 *
 * Verifies the history (layout, index, full schema and public safety of every record, via
 * history-cli), audits its git log for the immutability contract (when <dir> is a git checkout),
 * and compares it with the CI workflow's runs on main from the Actions API (GET only; uses
 * GITHUB_TOKEN when set, else unauthenticated, which public repositories allow), or offline from
 * <dir> files named like the API paths: runs-page-<n>.json and artifacts-<runId>.json. Prints a
 * deterministic report; nothing is written, repaired or published.
 *
 * Two verdicts drive the exit status (see reconcile.ts for the full contract):
 *   integrity  verified | failed | unverified   (history validity, git audit, record identity)
 *   coverage   complete | gaps | undetermined   (every eligible run attempt published?)
 *
 * Exit 0: integrity verified and coverage complete.
 * Exit 1: integrity failed: invalid history, immutability violated, or a record inconsistent
 *         with the API. An integrity or security failure; it wins over everything else.
 * Exit 2: integrity not failed, but unverified (no git audit) or coverage not complete: known
 *         gaps (eligible attempts without a record) or undetermined (incomplete runs listing).
 *         A diagnostic finding, not damage.
 */

const repoRoot = resolve(__dirname, '..', '..');
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--'))
    throw new HistoryError([`usage: --${name} needs a value`]);
  return value;
}

/** A Fetch over saved responses: the same parsing and completeness rules as the live API. */
export function directoryFetch(dir: string): Fetch {
  return (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const page = /\/actions\/workflows\/[^/]+\/runs\?.*[?&]page=(\d+)/.exec(path)?.[1];
    const run = /\/actions\/runs\/(\d+)\/artifacts/.exec(path)?.[1];
    const file =
      page !== undefined
        ? `runs-page-${page}.json`
        : run !== undefined
          ? `artifacts-${run}.json`
          : undefined;
    const target = file === undefined ? undefined : join(dir, file);
    if (
      target === undefined ||
      !existsSync(target) ||
      lstatSync(target).size > MAX_API_RESPONSE_BYTES
    ) {
      return Promise.resolve({ status: 404, text: () => Promise.resolve('{}') });
    }
    return Promise.resolve({
      status: 200,
      text: () => Promise.resolve(readFileSync(target, 'utf8')),
    });
  };
}

/** HEAD commit and the immutability audit, from read-only git commands; null when not a checkout. */
export function gitAudit(history: string): { commit: string | null; problems: string[] | null } {
  const git = (...args: string[]) =>
    spawnSync('git', args, {
      cwd: history,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    });
  const top = git('rev-parse', '--show-toplevel');
  // Real paths: an aliased path (a symlink, /tmp vs /private/tmp) must not skip the audit silently.
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(history)) {
    return { commit: null, problems: null };
  }
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  const log = git(
    'log',
    '--reverse',
    '--format=%x00%H%x09%P%x09%an <%ae>',
    '--name-status',
    '--no-renames',
    'HEAD',
  );
  if (log.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return { commit: null, problems: null };
  const problems = auditHistoryLog(log.stdout);
  if (git('status', '--porcelain', '--untracked-files=all').stdout !== '') {
    problems.push(
      'the checkout has local changes, so the files checked are not the audited commit',
    );
  }
  return { commit, problems };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const history = option(args, 'history');
  if (history === undefined) throw new HistoryError(['usage: --history <dir> is required']);
  const repository =
    option(args, 'repository') ??
    process.env['GITHUB_REPOSITORY'] ??
    'LarysaK/AI-QA-AutomationFramework';
  if (!REPOSITORY.test(repository))
    throw new HistoryError(['usage: --repository must be owner/name']);
  const format = option(args, 'format') ?? 'json';
  if (format !== 'json' && format !== 'markdown')
    throw new HistoryError(['usage: --format json|markdown']);
  const apiDir = option(args, 'api');
  const root = resolve(history);

  let tree = new Map<string, string>();
  let historyProblems: string[];
  try {
    tree = loadTree(root);
    historyProblems = verifyHistory(tree, defaultSafetyContext(repoRoot));
  } catch (error) {
    if (!(error instanceof HistoryError)) throw error;
    historyProblems = [...error.problems];
  }
  const audit = gitAudit(root);
  const api = await fetchApiData(
    repository,
    apiDir === undefined ? (process.env['GITHUB_TOKEN'] ?? '') : '',
    apiDir === undefined ? (url, init) => fetch(url, init) : directoryFetch(resolve(apiDir)),
  );
  const report = reconcile({
    repository,
    tree,
    historyProblems,
    historyCommit: audit.commit,
    immutabilityProblems: audit.problems,
    api,
  });
  process.stdout.write(format === 'json' ? canonicalJson(report) : markdown(report));
  return exitCode(report);
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof HistoryError) console.error(error.message);
      else
        console.error(
          `CI history reconciliation failed: unexpected ${error instanceof Error ? error.name : 'error'}`,
        );
      process.exit(1);
    });
}
