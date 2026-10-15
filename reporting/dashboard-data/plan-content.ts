/**
 * The approved test plan's prose, as verbatim Markdown, for the dashboard's Test Plan page.
 *
 * The plan stays the single source of truth: every level-2 section is copied as written, except
 * the content the snapshot already holds in structured form. The inventory section keeps only
 * its introduction and the notes of each requirement subsection (its test-case table is the
 * structured `testCases`); the canonical section keeps its introduction (its table is the
 * structured `canonicals`, and each `### CAN-NNN` subsection is attached to that canonical).
 * Anything that does not fit this structure is reported, never guessed.
 */

export interface PlanMetadataRow {
  readonly item: string;
  readonly value: string;
}

export type PlanSection =
  | { readonly kind: 'text'; readonly heading: string; readonly markdown: string }
  | {
      readonly kind: 'inventory';
      readonly heading: string;
      /** The section's text before its first requirement subsection. */
      readonly markdown: string;
      /** Requirement subsections' text without their test-case tables; empty ones are omitted. */
      readonly requirementNotes: readonly {
        readonly requirementId: string;
        readonly markdown: string;
      }[];
    }
  | {
      readonly kind: 'canonicals';
      readonly heading: string;
      /** The section's text before its first subsection, without the canonical table. */
      readonly markdown: string;
    };

export interface CanonicalSection {
  /** The `### CAN-NNN — …` heading text, verbatim. */
  readonly heading: string;
  readonly markdown: string;
}

export interface PlanContent {
  readonly metadata: readonly PlanMetadataRow[];
  /** Text between the metadata table and the first section. */
  readonly preamble: string;
  readonly sections: readonly PlanSection[];
  /** CAN ID → its subsection in the canonical section. */
  readonly canonicalSections: ReadonlyMap<string, CanonicalSection>;
}

const SECTION = /^##\s+(\S.*?)\s*$/;
const SUBSECTION = /^###\s+(\S.*?)\s*$/;
const REQ_SUBSECTION = /^###\s+(REQ-\d{3})\s+—\s+\S/;
const CAN_SUBSECTION = /^###\s+((CAN-\d{3})\s+—\s+\S.*?)\s*$/;
const TABLE_LINE = /^\|/;
const CAN_ROW = /^\|\s*CAN-\d{3}\s*\|/;

export function readPlanContent(markdown: string, path: string, problems: string[]): PlanContent {
  const lines = markdown.split('\n');
  const h1 = lines.findIndex((line) => /^#\s+\S/.test(line));
  const firstSection = lines.findIndex((line) => SECTION.test(line));
  if (h1 === -1 || firstSection === -1 || firstSection < h1) {
    problems.push(`${path}: expected a level-1 title followed by level-2 sections`);
    return { metadata: [], preamble: '', sections: [], canonicalSections: new Map() };
  }

  const head = lines.slice(h1 + 1, firstSection);
  const metadata = readMetadata(head, path, problems);
  const preamble = trim(head.filter((line) => !TABLE_LINE.test(line)));

  const sections: PlanSection[] = [];
  const canonicalSections = new Map<string, CanonicalSection>();
  let inventories = 0;
  for (const [start, end] of sectionRanges(lines, firstSection)) {
    const heading = SECTION.exec(lines[start] ?? '')?.[1] ?? '';
    const body = lines.slice(start + 1, end);
    const firstSub = body.findIndex((line) => SUBSECTION.test(line));
    const intro = firstSub === -1 ? body : body.slice(0, firstSub);

    if (body.some((line) => REQ_SUBSECTION.test(line))) {
      inventories += 1;
      sections.push({
        kind: 'inventory',
        heading,
        markdown: trim(intro),
        requirementNotes: subsections(body)
          .map(({ title, lines: sub }) => ({
            requirementId: /^(REQ-\d{3})/.exec(title)?.[1] ?? '',
            markdown: trim(sub.filter((line) => !TABLE_LINE.test(line))),
            title,
          }))
          .filter((note) => {
            if (note.requirementId === '') {
              problems.push(
                `${path}: "### ${note.title}" in "${heading}" is not a requirement subsection`,
              );
              return false;
            }
            return note.markdown !== '';
          })
          .map(({ requirementId, markdown: text }) => ({ requirementId, markdown: text })),
      });
    } else if (body.some((line) => CAN_ROW.test(line))) {
      for (const { title, lines: sub } of subsections(body)) {
        const match = CAN_SUBSECTION.exec(`### ${title}`);
        if (!match?.[1] || !match[2]) {
          problems.push(`${path}: "### ${title}" in "${heading}" is not a canonical subsection`);
          continue;
        }
        if (canonicalSections.has(match[2]))
          problems.push(`${path}: duplicate ${match[2]} subsection`);
        canonicalSections.set(match[2], { heading: match[1], markdown: trim(sub) });
      }
      sections.push({
        kind: 'canonicals',
        heading,
        markdown: trim(intro.filter((line) => !TABLE_LINE.test(line))),
      });
    } else {
      sections.push({ kind: 'text', heading, markdown: trim(body) });
    }
  }
  if (inventories !== 1) {
    problems.push(
      `${path}: expected exactly one test inventory section, found ${String(inventories)}`,
    );
  }
  for (const section of sections) {
    if (section.kind === 'text' && section.markdown === '') {
      problems.push(`${path}: section "${section.heading}" is empty`);
    }
  }
  return { metadata, preamble, sections, canonicalSections };
}

function readMetadata(
  head: readonly string[],
  path: string,
  problems: string[],
): PlanMetadataRow[] {
  const table = head.filter((line) => TABLE_LINE.test(line));
  if (table.length === 0) return [];
  const cells = (line: string): string[] =>
    line
      .trim()
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
  const [header, separator, ...rows] = table;
  if (
    cells(header ?? '').join('|') !== 'Item|Value' ||
    !/^\|[\s|:-]+\|\s*$/.test(separator ?? '')
  ) {
    problems.push(`${path}: the metadata table must have the columns "Item | Value"`);
    return [];
  }
  return rows.map((row) => {
    const [item = '', value = '', ...extra] = cells(row);
    if (item === '' || value === '' || extra.length > 0 || /\\\|/.test(row)) {
      problems.push(`${path}: malformed metadata row "${item}"`);
    }
    return { item, value };
  });
}

/** [start, end) line ranges of each level-2 section; a level-1 heading also ends a section. */
function sectionRanges(lines: readonly string[], first: number): [number, number][] {
  const ranges: [number, number][] = [];
  let start = first;
  for (let i = first + 1; i <= lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || /^#{1,2}\s/.test(line)) {
      ranges.push([start, i]);
      if (line === undefined || /^#\s/.test(line)) break;
      start = i;
    }
  }
  return ranges;
}

function subsections(body: readonly string[]): { title: string; lines: string[] }[] {
  const result: { title: string; lines: string[] }[] = [];
  for (const line of body) {
    const match = SUBSECTION.exec(line);
    if (match?.[1]) result.push({ title: match[1], lines: [] });
    else result[result.length - 1]?.lines.push(line);
  }
  return result;
}

/** Drops leading and trailing blank lines and trailing section separators (`---`). */
function trim(lines: readonly string[]): string {
  const copy = [...lines];
  while (copy.length > 0 && /^\s*(---)?\s*$/.test(copy[copy.length - 1] ?? '')) copy.pop();
  while (copy.length > 0 && (copy[0] ?? '').trim() === '') copy.shift();
  return copy.join('\n');
}
