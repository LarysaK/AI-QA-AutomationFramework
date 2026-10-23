import type { Snapshot } from './types';

/**
 * The contract for a future, verified defect data source (for example an export from an issue
 * tracker). No such source exists yet: this build is not connected, and the Defects page says so.
 * A source is shown only if every record passes validateDefectSource(), so a connected source
 * can never show an unidentified record or a test case or requirement that is not approved.
 *
 * Defects are never derived from anything else: not from failing CI results, not from
 * unpublished runs, and not from agents' defect-candidate findings (which await human triage).
 */

export interface DefectRecord {
  /** The source system's own key, for example "RF-42". */
  readonly id: string;
  readonly title: string;
  /** As reported by the source system; no status is invented or normalized. */
  readonly status: string;
  /** As reported by the source system, or null if it has none. */
  readonly severity: string | null;
  readonly requirementIds: readonly string[];
  readonly testCaseIds: readonly string[];
  /** The record in the source system (https only), or null. */
  readonly url: string | null;
  /** When the source system last changed the record (ISO 8601). */
  readonly updatedAt: string;
}

export type DefectSource =
  | { readonly status: 'not-connected' }
  | {
      readonly status: 'connected';
      /** The source system's name, for example "Jira". */
      readonly system: string;
      /** When the records were exported (ISO 8601). */
      readonly retrievedAt: string;
      readonly records: readonly DefectRecord[];
    };

export const NOT_CONNECTED: DefectSource = { status: 'not-connected' };

const ID = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;
const keys = (value: object): string => Object.keys(value).sort().join(',');
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Problems with a defect source; empty means it can be shown. */
export function validateDefectSource(value: unknown, snapshot: Snapshot): string[] {
  if (!isObject(value)) return ['defect source: not an object'];
  if (value['status'] === 'not-connected') {
    return keys(value) === 'status' ? [] : ['defect source: unexpected fields'];
  }
  if (value['status'] !== 'connected') return ['defect source: unknown status'];
  const problems: string[] = [];
  if (keys(value) !== 'records,retrievedAt,status,system') {
    problems.push('defect source: unexpected or missing fields');
  }
  if (!text(value['system'], 60)) problems.push('defect source: system is missing');
  if (typeof value['retrievedAt'] !== 'string' || !ISO.test(value['retrievedAt'])) {
    problems.push('defect source: retrievedAt is not an ISO 8601 UTC instant');
  }
  const records = value['records'];
  if (!Array.isArray(records)) return [...problems, 'defect source: records is not a list'];

  const requirements = new Set(snapshot.requirements.map((r) => r.id));
  const testCases = new Set(snapshot.testCases.map((tc) => tc.id));
  const seen = new Set<string>();
  records.forEach((record: unknown, index) => {
    const at = `defect source: records[${String(index)}]`;
    if (!isObject(record)) {
      problems.push(`${at} is not an object`);
      return;
    }
    if (keys(record) !== 'id,requirementIds,severity,status,testCaseIds,title,updatedAt,url') {
      problems.push(`${at} has unexpected or missing fields`);
    }
    const id = record['id'];
    if (typeof id !== 'string' || !ID.test(id)) problems.push(`${at}.id is not a tracker key`);
    else if (seen.has(id)) problems.push(`${at}.id is a duplicate`);
    else seen.add(id);
    if (!text(record['title'], 200)) problems.push(`${at}.title is missing`);
    if (!text(record['status'], 40)) problems.push(`${at}.status is missing`);
    if (record['severity'] !== null && !text(record['severity'], 40)) {
      problems.push(`${at}.severity is not text or null`);
    }
    const url = record['url'];
    if (url !== null && (typeof url !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(url))) {
      problems.push(`${at}.url is not an https URL or null`);
    }
    if (typeof record['updatedAt'] !== 'string' || !ISO.test(record['updatedAt'])) {
      problems.push(`${at}.updatedAt is not an ISO 8601 UTC instant`);
    }
    const reqs = record['requirementIds'];
    const tcs = record['testCaseIds'];
    if (!Array.isArray(reqs) || reqs.some((r) => typeof r !== 'string' || !requirements.has(r))) {
      problems.push(`${at}.requirementIds names a requirement that is not approved`);
    }
    if (!Array.isArray(tcs) || tcs.some((t) => typeof t !== 'string' || !testCases.has(t))) {
      problems.push(`${at}.testCaseIds names a test case that is not approved`);
    }
  });
  return problems;
}
