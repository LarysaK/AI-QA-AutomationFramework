// Field-shape diagnostic for the first real workflow_run events (Phase 5.3 M3c).
//
//   node reporting/ci/event-shape.mjs <event.json>
//
// Prints a Markdown table of the fields the history workflow relies on: whether each is
// present, its JSON type and whether it has the expected shape. It never prints a value, so the
// output contains no names, URLs, commits or tokens, and the payload itself is never copied.
// The test fixture is synthetic; this output is how a real payload is first compared with it.
// Diagnostic only: always exits 0 (an unreadable payload is reported as such), and the
// validation that gates the workflow is ci:collect context.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';

const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const positiveInteger = (v) => Number.isSafeInteger(v) && v >= 1;
const instant = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v);
const repository = (v) => typeof v === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v);

/** [path, expected shape description, predicate]. */
export const FIELDS = [
  ['action', '"completed"', (v) => v === 'completed'],
  ['repository.full_name', 'owner/name', repository],
  ['repository.default_branch', 'a string', (v) => typeof v === 'string'],
  ['workflow_run.id', 'a positive integer', positiveInteger],
  ['workflow_run.name', 'a string', (v) => typeof v === 'string'],
  ['workflow_run.run_number', 'a positive integer', positiveInteger],
  ['workflow_run.run_attempt', 'a positive integer', positiveInteger],
  [
    'workflow_run.event',
    'push or workflow_dispatch (others are refused)',
    (v) => v === 'push' || v === 'workflow_dispatch',
  ],
  ['workflow_run.status', '"completed"', (v) => v === 'completed'],
  [
    'workflow_run.conclusion',
    'a known conclusion',
    (v) =>
      [
        'success',
        'failure',
        'cancelled',
        'timed_out',
        'neutral',
        'skipped',
        'stale',
        'action_required',
        'startup_failure',
      ].includes(v),
  ],
  ['workflow_run.head_branch', 'a string', (v) => typeof v === 'string'],
  [
    'workflow_run.head_sha',
    '40 lowercase hex digits',
    (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v),
  ],
  [
    'workflow_run.html_url',
    'a https://github.com/ URL',
    (v) => typeof v === 'string' && v.startsWith('https://github.com/'),
  ],
  ['workflow_run.created_at', 'a UTC timestamp', instant],
  ['workflow_run.run_started_at', 'a UTC timestamp', instant],
  ['workflow_run.repository.full_name', 'owner/name', repository],
  ['workflow_run.head_repository.full_name', 'owner/name', repository],
];

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/** { has, value } for a dotted path through plain objects (own properties only). */
const lookup = (event, path) => {
  let node = event;
  for (const key of path.split('.')) {
    if (
      node === null ||
      typeof node !== 'object' ||
      Array.isArray(node) ||
      !Object.hasOwn(node, key)
    )
      return { has: false, value: undefined };
    node = node[key];
  }
  return { has: true, value: node };
};

/** The diagnostic table for a parsed payload (or an explanation when it could not be read). */
export function describeEventShape(event) {
  const lines = [
    '### workflow_run event: field shapes',
    '',
    'Presence, type and shape only; no values are shown.',
    '',
    '| Field | Present | Type | Expected shape | Matches |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [path, expected, predicate] of FIELDS) {
    const { has, value } = lookup(event, path);
    lines.push(
      `| \`${path}\` | ${has ? 'yes' : 'no'} | ${has ? typeOf(value) : '—'} | ${expected} | ${has && predicate(value) ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// The entry point, compared by real path (a symlinked path must not skip the program).
if (
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(import.meta.filename)
) {
  const path = process.argv[2];
  let event;
  try {
    if (path === undefined) throw new Error('usage');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) throw new Error('size');
    event = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    process.stdout.write(
      '### workflow_run event: field shapes\n\nThe event payload could not be read as JSON within the size limit.\n',
    );
    process.exit(0);
  }
  process.stdout.write(describeEventShape(event));
}
