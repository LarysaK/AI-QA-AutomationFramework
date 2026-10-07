import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Approved traceability IDs, read from the approved source documents (no second registry):
 *
 * - `specs/<aut>/requirements.md` — a requirement is a level-2 heading `## REQ-NNN — <title>`.
 * - `specs/<aut>/test-plan.md` — a test case is a table row whose first cell is `TC-NNN-NN`,
 *   inside a level-3 section `### REQ-NNN — <title>` that owns it; a canonical test is a table
 *   row whose first cell is `CAN-NNN`.
 *
 * The parser reads structure (headings and first table cells), never prose. Anything that does
 * not fit the structure is reported as an error, and callers must fail closed.
 */
export interface ApprovedIds {
  readonly requirements: ReadonlySet<string>;
  /** Approved TC ID → the REQ ID that owns it. */
  readonly testCases: ReadonlyMap<string, string>;
  readonly canonicals: ReadonlySet<string>;
}

export interface ApprovedIdsResult {
  readonly ids: ApprovedIds;
  /** Structural problems, as "<file>: <problem>". Non-empty means the IDs must not be trusted. */
  readonly errors: readonly string[];
}

const REQ_HEADING = /^##\s+(REQ-\d{3})\s+—\s+\S/;
const REQ_SECTION = /^###\s+(REQ-\d{3})\s+—\s+\S/;
const TABLE_ROW = /^\|(.*)\|\s*$/;
const TABLE_SEPARATOR = /^\|[\s|:-]+\|\s*$/;
const TC_ID = /^TC-(\d{3})-\d{2}$/;
const CAN_ID = /^CAN-\d{3}$/;

export function loadApprovedIds(repoRoot: string): ApprovedIdsResult {
  const requirements = new Map<string, string>(); // REQ → file
  const testCases = new Map<string, string>(); // TC → REQ
  const tcFiles = new Map<string, string>(); // TC → file
  const canonicals = new Map<string, string>(); // CAN → file
  const errors: string[] = [];

  const specDirs = findSpecDirs(repoRoot);
  if (specDirs.length === 0) errors.push('specs/: no requirements.md found');

  for (const dir of specDirs) {
    const requirementsFile = join(dir, 'requirements.md');
    const testPlanFile = join(dir, 'test-plan.md');
    const rel = (file: string): string => relative(repoRoot, file).split('\\').join('/');

    const reqs = parseRequirements(readFileSync(requirementsFile, 'utf8'));
    errors.push(...reqs.errors.map((error) => `${rel(requirementsFile)}: ${error}`));
    for (const id of reqs.ids) {
      const other = requirements.get(id);
      if (other === undefined) requirements.set(id, rel(requirementsFile));
      else
        errors.push(
          `${rel(requirementsFile)}: ${id} is also defined in ${other} (IDs are not namespaced per AUT)`,
        );
    }

    let plan: ParsedTestPlan;
    try {
      plan = parseTestPlan(readFileSync(testPlanFile, 'utf8'));
    } catch {
      errors.push(
        `${rel(testPlanFile)}: missing (every requirements.md needs a test-plan.md next to it)`,
      );
      continue;
    }
    errors.push(...plan.errors.map((error) => `${rel(testPlanFile)}: ${error}`));
    for (const [tc, req] of plan.testCases) {
      if (!reqs.ids.includes(req)) {
        errors.push(
          `${rel(testPlanFile)}: ${tc} is listed under ${req}, which ${rel(requirementsFile)} does not define`,
        );
      }
      const other = tcFiles.get(tc);
      if (other === undefined) {
        testCases.set(tc, req);
        tcFiles.set(tc, rel(testPlanFile));
      } else {
        errors.push(`${rel(testPlanFile)}: ${tc} is also defined in ${other}`);
      }
    }
    for (const can of plan.canonicals) {
      const other = canonicals.get(can);
      if (other === undefined) canonicals.set(can, rel(testPlanFile));
      else errors.push(`${rel(testPlanFile)}: ${can} is also defined in ${other}`);
    }
  }

  return {
    ids: {
      requirements: new Set(requirements.keys()),
      testCases,
      canonicals: new Set(canonicals.keys()),
    },
    errors,
  };
}

export function parseRequirements(markdown: string): { ids: string[]; errors: string[] } {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const [index, line] of markdown.split('\n').entries()) {
    const match = REQ_HEADING.exec(line);
    if (!match?.[1]) {
      if (/^##\s+REQ-/.test(line))
        errors.push(`line ${String(index + 1)}: malformed requirement heading`);
      continue;
    }
    if (ids.includes(match[1])) errors.push(`line ${String(index + 1)}: duplicate ${match[1]}`);
    else ids.push(match[1]);
  }
  if (ids.length === 0 && errors.length === 0)
    errors.push('no "## REQ-NNN — <title>" headings found');
  return { ids, errors };
}

export interface ParsedTestPlan {
  readonly testCases: Map<string, string>;
  readonly canonicals: string[];
  readonly errors: string[];
}

export function parseTestPlan(markdown: string): ParsedTestPlan {
  const testCases = new Map<string, string>();
  const canonicals: string[] = [];
  const errors: string[] = [];
  let section: string | undefined; // REQ owning the current inventory section

  for (const [index, line] of markdown.split('\n').entries()) {
    const at = `line ${String(index + 1)}`;

    if (/^#{1,3}\s/.test(line)) {
      section = REQ_SECTION.exec(line)?.[1];
      if (section === undefined && /^###\s+REQ-/.test(line))
        errors.push(`${at}: malformed REQ section heading`);
      continue;
    }

    const row = TABLE_ROW.exec(line);
    if (!row?.[1] || TABLE_SEPARATOR.test(line)) continue;
    const firstCell = (row[1].split('|')[0] ?? '').trim();

    if (CAN_ID.test(firstCell)) {
      if (canonicals.includes(firstCell)) errors.push(`${at}: duplicate ${firstCell}`);
      else canonicals.push(firstCell);
      continue;
    }

    const tc = TC_ID.exec(firstCell);
    if (section === undefined) {
      if (tc) errors.push(`${at}: ${firstCell} is outside any "### REQ-NNN" section`);
      continue;
    }

    // Inside an inventory section, every row other than the header must be a test case.
    if (firstCell === 'ID') continue;
    if (!tc) {
      errors.push(`${at}: row in ${section} section does not start with a TC ID ("${firstCell}")`);
      continue;
    }
    if (`REQ-${tc[1] ?? ''}` !== section) {
      errors.push(
        `${at}: ${firstCell} is listed under ${section}, but its ID belongs to REQ-${tc[1] ?? ''}`,
      );
      continue;
    }
    if (testCases.has(firstCell)) errors.push(`${at}: duplicate ${firstCell}`);
    else testCases.set(firstCell, section);
  }

  if (testCases.size === 0 && errors.length === 0) errors.push('no test case rows found');
  return { testCases, canonicals, errors };
}

/** Directories under specs/ that contain a requirements.md, in a stable order. */
function findSpecDirs(repoRoot: string): string[] {
  const specs = join(repoRoot, 'specs');
  let entries;
  try {
    entries = readdirSync(specs, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name === 'requirements.md')
    .map((entry) => entry.parentPath)
    .sort();
}
