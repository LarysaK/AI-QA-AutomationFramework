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
 *        [--reconciliation <report> | --coverage-if-verified <report>] \
 *        [--repository owner/name] [--out artifacts/dashboard/ci-history.json]
 *
 * The history must pass the full verification (layout, index, ci-run schema and public safety of
 * every record) and the immutability audit of its git log, with a clean checkout; otherwise
 * nothing is written. A reconciliation report, if given, must be for the same ci-history commit
 * with integrity verified; its coverage (published and unpublished eligible run attempts) is
 * included. The output is deterministic for a given commit and report. Exit 0 or 1.
 *
 * --coverage-if-verified (for unattended builds such as the GitHub Pages deployment) treats the
 * report as optional: a missing, empty or unparseable report (the API was unavailable, or the
 * reconciliation itself failed) or one whose integrity is only "unverified" is left out, so the
 * export has no coverage (the dashboard then says coverage was not checked); nothing is
 * estimated. A report whose integrity "failed" still refuses the export, and a verified report
 * must pass every check of --reconciliation.
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

/** Reads a reconciliation report file: its parsed JSON, or why it cannot be read. */
function readReport(path: string): { readonly report: unknown } | { readonly unreadable: string } {
  const file = resolve(path);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size > MAX_REPORT_BYTES) {
    return { unreadable: 'the reconciliation report is missing, not a regular file or too large' };
  }
  try {
    return { report: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch {
    return { unreadable: 'the reconciliation report is not JSON' };
  }
}

const integrityOf = (report: unknown): unknown => {
  const verdict =
    typeof report === 'object' && report !== null
      ? (report as Record<string, unknown>)['verdict']
      : undefined;
  return typeof verdict === 'object' && verdict !== null
    ? (verdict as Record<string, unknown>)['integrity']
    : undefined;
};

/**
 * The optional report for --coverage-if-verified: the report to use, or why coverage is left
 * out. Throws when the report says the history's integrity failed.
 */
export function optionalReconciliation(
  path: string,
): { readonly report: unknown } | { readonly omitted: string } {
  const read = readReport(path);
  if ('unreadable' in read) return { omitted: read.unreadable };
  const integrity = integrityOf(read.report);
  if (integrity === 'failed') {
    throw new ExportError([
      'the reconciliation found an integrity failure in the CI history; nothing was exported',
    ]);
  }
  if (integrity !== 'verified') {
    return { omitted: 'the reconciliation did not verify the history’s integrity' };
  }
  return { report: read.report };
}

export function exportHistory(options: {
  readonly history: string;
  readonly repository: string;
  /** A report that must be valid (--reconciliation). */
  readonly reconciliation?: string;
  /** An already selected report (--coverage-if-verified); validated like --reconciliation. */
  readonly reconciliationReport?: unknown;
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
  let reconciliation: unknown = options.reconciliationReport;
  if (options.reconciliation !== undefined) {
    const read = readReport(options.reconciliation);
    if ('unreadable' in read) throw new ExportError([read.unreadable]);
    reconciliation = read.report;
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
    const ifVerified = option(args, 'coverage-if-verified');
    if (reconciliation !== undefined && ifVerified !== undefined) {
      throw new ExportError([
        'usage: --reconciliation and --coverage-if-verified are mutually exclusive',
      ]);
    }
    const optional = ifVerified === undefined ? undefined : optionalReconciliation(ifVerified);
    if (optional !== undefined && 'omitted' in optional) {
      console.error(`coverage not included: ${optional.omitted}`);
    }
    const text = exportHistory({
      history,
      repository: option(args, 'repository') ?? 'LarysaK/AI-QA-AutomationFramework',
      ...(reconciliation === undefined ? {} : { reconciliation }),
      ...(optional !== undefined && 'report' in optional
        ? { reconciliationReport: optional.report }
        : {}),
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
