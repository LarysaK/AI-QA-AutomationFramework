import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { defaultSafetyContext } from '../dashboard-data/sanitize';
import {
  collectSuites,
  CollectError,
  composeRecord,
  OUTCOME_SUFFIXES,
  outcomesFrom,
  REPORT_FILES,
  type ReportInput,
  serializeRecord,
  snapshotReference,
  SUITE_IDS,
  type SuiteId,
  summarizeSuiteResults,
} from './collect';

/**
 * CI run record collector.
 *
 *   npm run ci:collect -- suites --reports <dir> --outcomes <file.json> --out <file.json>
 *   npm run ci:collect -- suites --reports <dir> --outcomes-env CI_OUTCOME_ --out <file.json>
 *   npm run ci:collect -- summary --suites <file.json>
 *   npm run ci:collect -- record --suites <file.json> --run <file.json> --jobs <file.json> \
 *                                --snapshot <file.json> --out <file.json>
 *
 * `suites` runs inside the verification job: step outcomes, either a JSON file
 * (`{ "<suite>": "success" | ... }`) or environment variables named <prefix>AGENTS,
 * <prefix>DASHBOARD_DATA, <prefix>DASHBOARD_FRONTEND and <prefix>PLAYWRIGHT, plus the reports in
 * <dir> (see REPORT_FILES). `summary` prints a counts-only Markdown summary of suite results. `record` combines those suite results (a missing
 * file means the job never wrote them) with the Actions API run and jobs responses, the runner's
 * GITHUB_* environment and the dashboard snapshot of the same commit. Output is written only when
 * every check, the schema and the public-safety scan pass. Exit 0 on success, 1 otherwise.
 */

const repoRoot = resolve(__dirname, '..', '..');

function options(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new CollectError([`usage: expected --option value pairs, got "${String(key)}"`]);
    }
    map.set(key.slice(2), value);
  }
  return map;
}

function required(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw new CollectError([`usage: --${key} is required`]);
  return resolve(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CollectError([`${path} is missing or not JSON`]);
  }
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRecord(value));
}

try {
  const [mode, ...rest] = process.argv.slice(2);
  const opts = options(rest);
  if (mode === 'suites') {
    const reports = required(opts, 'reports');
    const prefix = opts.get('outcomes-env');
    if ((prefix === undefined) === (opts.get('outcomes') === undefined)) {
      throw new CollectError([
        'usage: give exactly one of --outcomes <file> or --outcomes-env <prefix>',
      ]);
    }
    const outcomes =
      prefix !== undefined
        ? outcomesFrom(process.env, (id) => `${prefix}${OUTCOME_SUFFIXES[id]}`)
        : outcomesFrom(readJson(required(opts, 'outcomes')) as Record<string, unknown>, (id) => id);
    const inputs = {} as Record<SuiteId, ReportInput>;
    for (const id of SUITE_IDS) {
      const file = join(reports, REPORT_FILES[id]);
      inputs[id] = existsSync(file)
        ? { kind: 'present', text: readFileSync(file, 'utf8') }
        : { kind: 'missing' };
    }
    write(
      required(opts, 'out'),
      collectSuites({ outcomes, reports: inputs, node: process.versions.node }),
    );
  } else if (mode === 'summary') {
    process.stdout.write(summarizeSuiteResults(readJson(required(opts, 'suites'))));
  } else if (mode === 'record') {
    const suitesFile = required(opts, 'suites');
    const record = composeRecord({
      suiteResults: existsSync(suitesFile) ? readJson(suitesFile) : null,
      run: readJson(required(opts, 'run')),
      jobs: readJson(required(opts, 'jobs')),
      env: process.env,
      snapshot: snapshotReference(readJson(required(opts, 'snapshot'))),
      safety: defaultSafetyContext(repoRoot),
    });
    write(required(opts, 'out'), record);
  } else {
    throw new CollectError(['usage: ci:collect suites|summary|record --option value ...']);
  }
} catch (error) {
  if (error instanceof CollectError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
