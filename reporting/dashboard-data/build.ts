import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';

import type { ListRunner } from '../../agents/orchestrator/validation/discovery-guard';
import { discoverInventory, type GitProbe, gitProbe, type TestInstance } from './inventory';
import { defaultSafetyContext, type PublicSafetyContext, publicSafetyFindings } from './sanitize';
import { readSpecSources, SnapshotError } from './spec-source';

/**
 * Builds the dashboard data snapshot: approved requirements, test cases and canonical tests,
 * plus the committed test inventory and the automation linkage derived from its tags.
 *
 * Three concepts stay separate: automation intent (the plan's Automation column), automation
 * linkage (committed tests tagged with an ID) and execution results (CI only; none exist yet,
 * and local Playwright results are never read).
 *
 * The output is deterministic: no timestamps, every list sorted, keys in a fixed order. The
 * same commit and the same Playwright version produce byte-identical snapshots.
 */

export const DEFAULT_APP = 'requestflow';
export const SCHEMA_PATH = join(__dirname, 'snapshot.schema.json');

export interface BuildOptions {
  readonly app?: string;
  readonly git?: GitProbe;
  readonly runList?: ListRunner;
  readonly safety?: PublicSafetyContext;
}

interface Linkage {
  readonly status: 'linked' | 'not-linked';
  readonly testInstanceIds: readonly string[];
}

export function buildSnapshot(repoRoot: string, options: BuildOptions = {}): unknown {
  const app = options.app ?? DEFAULT_APP;
  const git = options.git ?? gitProbe(repoRoot);

  const specDir = `specs/${app}`;
  const uncommittedSpecs = git.uncommittedPaths([specDir]);
  if (uncommittedSpecs.length > 0) {
    throw new SnapshotError([
      `uncommitted changes under ${specDir}/ (only approved, committed documents are read): ${uncommittedSpecs.join(', ')}`,
    ]);
  }
  const sources = readSpecSources(repoRoot, app);
  const tracked = git.trackedFiles(specDir);
  for (const document of sources.documents) {
    if (!tracked.has(document.path)) {
      throw new SnapshotError([`${document.path} is not tracked by git`]);
    }
  }

  const inventory = discoverInventory(
    repoRoot,
    {
      requirements: new Set(sources.requirements.map((r) => r.id)),
      testCases: new Set(sources.testCases.map((tc) => tc.id)),
      canonicals: new Set(sources.canonicals.map((can) => can.id)),
    },
    git,
    ...(options.runList ? [options.runList] : []),
  );

  const linkage = (pick: (instance: TestInstance) => readonly string[], id: string): Linkage => {
    const ids = inventory.instances
      .filter((instance) => pick(instance).includes(id))
      .map((instance) => instance.id)
      .sort();
    return { status: ids.length > 0 ? 'linked' : 'not-linked', testInstanceIds: ids };
  };

  const testCases = sources.testCases.map((tc) => ({
    id: tc.id,
    requirementId: tc.requirementId,
    scenario: tc.scenario,
    level: tc.level,
    type: tc.type,
    priority: tc.priority,
    automationIntent: tc.automationIntent,
    automationLinkage: linkage((instance) => instance.tags.testCases, tc.id),
  }));
  const count = (values: readonly string[], key: string): number =>
    values.filter((value) => value === key).length;
  const linked = testCases.filter((tc) => tc.automationLinkage.status === 'linked');

  const snapshot = {
    schemaVersion: '1.0',
    app,
    source: {
      commit: git.head(),
      documents: sources.documents.map((d) => ({
        path: d.path,
        title: d.title,
        gitBlobSha: d.gitBlobSha,
      })),
      discovery: {
        method: 'playwright test --list --reporter=json',
        testDir: 'tests',
        playwrightVersion: inventory.playwrightVersion,
      },
    },
    requirements: sources.requirements.map((r) => ({
      id: r.id,
      title: r.title,
      markdown: r.markdown,
      automationLinkage: linkage((instance) => instance.tags.requirements, r.id),
    })),
    testCases,
    canonicals: sources.canonicals.map((can) => ({
      id: can.id,
      title: can.title,
      level: can.level,
      covers: can.covers,
      automationLinkage: linkage((instance) => instance.tags.canonicals, can.id),
    })),
    testInstances: inventory.instances.map((instance) => ({
      id: instance.id,
      file: instance.file,
      line: instance.line,
      title: instance.title,
      describePath: [...instance.describePath],
      projects: [...instance.projects],
      tags: {
        requirements: [...instance.tags.requirements],
        testCases: [...instance.tags.testCases],
        canonicals: [...instance.tags.canonicals],
      },
    })),
    execution: {
      ci: { status: 'no-ci-runs', runs: [] },
      localResults: 'not-used',
    },
    summary: {
      requirements: sources.requirements.length,
      testCases: testCases.length,
      testCasesByLevel: {
        API: count(
          testCases.map((tc) => tc.level),
          'API',
        ),
        UI: count(
          testCases.map((tc) => tc.level),
          'UI',
        ),
        E2E: count(
          testCases.map((tc) => tc.level),
          'E2E',
        ),
      },
      testCasesByPriority: {
        P0: count(
          testCases.map((tc) => tc.priority),
          'P0',
        ),
        P1: count(
          testCases.map((tc) => tc.priority),
          'P1',
        ),
        P2: count(
          testCases.map((tc) => tc.priority),
          'P2',
        ),
      },
      testCasesByAutomationIntent: {
        Yes: count(
          testCases.map((tc) => tc.automationIntent),
          'Yes',
        ),
        No: count(
          testCases.map((tc) => tc.automationIntent),
          'No',
        ),
      },
      canonicals: sources.canonicals.length,
      testInstances: inventory.instances.length,
      linkedTestCases: linked.length,
      linkedTestCasesWithIntentYes: linked.filter((tc) => tc.automationIntent === 'Yes').length,
    },
  };

  const schemaErrors = validateSnapshot(snapshot);
  if (schemaErrors.length > 0) throw new SnapshotError(schemaErrors);
  const unsafe = publicSafetyFindings(snapshot, options.safety ?? defaultSafetyContext(repoRoot));
  if (unsafe.length > 0) {
    throw new SnapshotError(unsafe.map((finding) => `not public-safe: ${finding}`));
  }
  return snapshot;
}

let validator: ReturnType<Ajv2020['compile']> | undefined;

/** Schema errors as "<instance path> <message>"; empty means valid. */
export function validateSnapshot(value: unknown): string[] {
  if (validator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    validator = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object);
  }
  if (validator(value)) return [];
  return (validator.errors ?? []).map(
    (error: ErrorObject) => `schema: ${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
  );
}

export function serializeSnapshot(snapshot: unknown): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
