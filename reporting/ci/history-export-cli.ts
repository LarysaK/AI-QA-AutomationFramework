import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { defaultSafetyContext, publicSafetyFindings } from '../dashboard-data/sanitize';
import { canonicalJson, HistoryError } from './history';
import { loadTree, verifyHistory } from './history-cli';
import { buildExport, ExportError } from './history-export';
import { gitAudit } from './reconcile-cli';

/**
 * Exports the published CI history for the dashboard (Phase 5.3 M4). Read-only towards the
 * history: it reads a git checkout of the ci-history branch and writes one file.
 *
 *   npm run dashboard:history -- --history <checkout of ci-history> \
 *        [--reconciliation <reconcile-cli JSON report>] [--repository owner/name] \
 *        [--out artifacts/dashboard/ci-history.json]
 *
 * The history must pass the full verification (layout, index, ci-run schema and public safety of
 * every record) and the immutability audit of its git log, with a clean checkout; otherwise
 * nothing is written. A reconciliation report, if given, must be for the same ci-history commit
 * with integrity verified; its coverage (published and unpublished eligible run attempts) is
 * included. The output is deterministic for a given commit and report. Exit 0 or 1.
 */

const repoRoot = resolve(__dirname, '..', '..');
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--'))
    throw new ExportError([`usage: --${name} needs a value`]);
  return value;
}

export function exportHistory(options: {
  readonly history: string;
  readonly repository: string;
  readonly reconciliation?: string;
}): string {
  const root = resolve(options.history);
  const tree = loadTree(root);
  const safety = defaultSafetyContext(repoRoot);
  const problems = verifyHistory(tree, safety);
  if (problems.length > 0)
    throw new ExportError(['the ci-history checkout is not valid:', ...problems]);
  const audit = gitAudit(root);
  if (audit.commit === null || audit.problems === null) {
    throw new ExportError([
      'the history must be a git checkout of ci-history (its commit is the provenance)',
    ]);
  }
  if (audit.problems.length > 0)
    throw new ExportError(['the immutability audit failed:', ...audit.problems]);
  const committedAt = spawnSync('git', ['log', '-1', '--format=%cI', audit.commit], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  }).stdout.trim();
  let reconciliation: unknown;
  if (options.reconciliation !== undefined) {
    const file = resolve(options.reconciliation);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > MAX_REPORT_BYTES) {
      throw new ExportError([
        'the reconciliation report is missing, not a regular file or too large',
      ]);
    }
    try {
      reconciliation = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new ExportError(['the reconciliation report is not JSON']);
    }
  }
  const result = buildExport({
    repository: options.repository,
    tree,
    commit: audit.commit,
    committedAt,
    reconciliation,
  });
  const unsafe = publicSafetyFindings(result, safety);
  if (unsafe.length > 0) throw new ExportError(unsafe.map((f) => `not public-safe: ${f}`));
  return canonicalJson(result);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const history = option(args, 'history');
    if (history === undefined) throw new ExportError(['usage: --history <dir> is required']);
    const reconciliation = option(args, 'reconciliation');
    const text = exportHistory({
      history,
      repository: option(args, 'repository') ?? 'LarysaK/AI-QA-AutomationFramework',
      ...(reconciliation === undefined ? {} : { reconciliation }),
    });
    const out = resolve(
      option(args, 'out') ?? resolve(repoRoot, 'artifacts/dashboard/ci-history.json'),
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    const parsed = JSON.parse(text) as {
      source: { commit: string; records: number };
      coverage: unknown;
    };
    process.stdout.write(
      `${JSON.stringify({ written: true, commit: parsed.source.commit, records: parsed.source.records, coverage: parsed.coverage !== null })}\n`,
    );
  } catch (error) {
    if (error instanceof ExportError || error instanceof HistoryError) {
      console.error(error.message);
      process.exit(1);
    }
    console.error(
      `CI history export failed: unexpected ${error instanceof Error ? error.name : 'error'}`,
    );
    process.exit(1);
  }
}
