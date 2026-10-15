import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';

/**
 * Snapshot schema validation, on its own so consumers (such as the dashboard's build) can
 * validate a snapshot without loading the builder, git or Playwright discovery.
 */

export const SCHEMA_PATH = join(__dirname, 'snapshot.schema.json');
export const SCHEMA_VERSION = '1.1';

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
