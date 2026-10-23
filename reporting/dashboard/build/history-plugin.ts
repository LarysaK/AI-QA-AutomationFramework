import { existsSync, readFileSync } from 'node:fs';

import type { Plugin } from 'vite';

import { validateExport } from '../../ci/history-export';
import { defaultSafetyContext, publicSafetyFindings } from '../../dashboard-data/sanitize';

/**
 * Provides `virtual:ci-history`: the published CI execution history exported from the ci-history
 * branch by `reporting/ci/history-export-cli.ts`, embedded only after it passes, in Node, the
 * same validation the exporter applied (every record against the ci-run 1.0 schema, repository,
 * run URLs, order, coverage) and the public-safety scan.
 *
 * - No export file: `null` is embedded and the dashboard says the history was not included in
 *   this build (never that no CI runs exist). Set DASHBOARD_REQUIRE_CI_HISTORY=1 to make a
 *   missing export fail the build instead (for published builds).
 * - An export that is not valid or not public-safe fails the dev server, the tests and the build;
 *   nothing is embedded. Findings name locations and categories, never values.
 */

export const HISTORY_VIRTUAL_ID = 'virtual:ci-history';
const RESOLVED_ID = `\0${HISTORY_VIRTUAL_ID}`;

export interface HistoryPluginOptions {
  /** Absolute path of the exported history JSON. */
  readonly historyFile: string;
  /** Absolute path of the repository root, which must never appear in the output. */
  readonly repoRoot: string;
  /** Fail when the export is missing (default: DASHBOARD_REQUIRE_CI_HISTORY=1). */
  readonly required?: boolean;
}

export function validatedHistory({
  historyFile,
  repoRoot,
  required,
}: HistoryPluginOptions): Plugin {
  const mustExist = required ?? process.env['DASHBOARD_REQUIRE_CI_HISTORY'] === '1';
  return {
    name: 'validated-ci-history',
    resolveId(id) {
      return id === HISTORY_VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      this.addWatchFile(historyFile);
      if (!existsSync(historyFile)) {
        if (mustExist) {
          this.error(
            'artifacts/dashboard/ci-history.json is missing and DASHBOARD_REQUIRE_CI_HISTORY=1; run reporting/ci/history-export-cli.ts',
          );
        }
        return 'export default null;';
      }
      let history: unknown;
      try {
        history = JSON.parse(readFileSync(historyFile, 'utf8'));
      } catch {
        this.error('artifacts/dashboard/ci-history.json is not JSON; nothing was embedded');
      }
      const errors = validateExport(history);
      if (errors.length > 0) {
        this.error(
          `CI history export is not valid; nothing was embedded:\n  ${errors.join('\n  ')}`,
        );
      }
      const unsafe = publicSafetyFindings(history, defaultSafetyContext(repoRoot));
      if (unsafe.length > 0) {
        this.error(
          `CI history export is not public-safe; nothing was embedded:\n  ${unsafe.join('\n  ')}`,
        );
      }
      return `export default ${JSON.stringify(history)};`;
    },
  };
}
