import { readFileSync } from 'node:fs';

import type { Plugin } from 'vite';

import { defaultSafetyContext, publicSafetyFindings } from '../../dashboard-data/sanitize';
import { SCHEMA_VERSION, validateSnapshot } from '../../dashboard-data/validate';

/**
 * Provides `virtual:dashboard-snapshot`: the snapshot written by `npm run dashboard:data`, embedded
 * only after it passes, in Node, the same checks the builder applies before writing it:
 * - the JSON Schema (reporting/dashboard-data/snapshot.schema.json), and
 * - the public-safety scan (reporting/dashboard-data/sanitize.ts), with the repository's
 *   absolute path, the home directory and the temp directory as forbidden literals.
 * Anything missing, invalid or unsafe fails the dev server, the tests and the build; nothing is
 * embedded. Findings name locations and categories, never the offending values.
 */

export const VIRTUAL_ID = 'virtual:dashboard-snapshot';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export interface SnapshotPluginOptions {
  /** Absolute path of the snapshot JSON. */
  readonly snapshotFile: string;
  /** Absolute path of the repository root, which must never appear in the output. */
  readonly repoRoot: string;
}

export function validatedSnapshot({ snapshotFile, repoRoot }: SnapshotPluginOptions): Plugin {
  return {
    name: 'validated-dashboard-snapshot',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      this.addWatchFile(snapshotFile);
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
      } catch {
        this.error(
          'artifacts/dashboard/dashboard-data.json is missing or not JSON; run `npm run dashboard:data` in the repository root',
        );
      }
      const errors = validateSnapshot(snapshot);
      if (errors.length > 0) {
        this.error(
          `dashboard snapshot is not valid (schema ${SCHEMA_VERSION}):\n  ${errors.join('\n  ')}`,
        );
      }
      const unsafe = publicSafetyFindings(snapshot, defaultSafetyContext(repoRoot));
      if (unsafe.length > 0) {
        this.error(
          `dashboard snapshot is not public-safe; nothing was embedded:\n  ${unsafe.join('\n  ')}`,
        );
      }
      return `export default ${JSON.stringify(snapshot)};`;
    },
  };
}
