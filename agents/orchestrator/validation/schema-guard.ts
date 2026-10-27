import { readFileSync } from 'node:fs';

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';

import type { Artifact, GuardFailure, GuardResult } from './types';

/**
 * Payload schemas by artifact type (Agent Standard section 14: G-SCHEMA validates the envelope,
 * and the payload once a payload schema exists). Paths are relative to the repository root.
 * Artifact types without an entry have no payload schema yet; only their envelope is validated.
 */
export const PAYLOAD_SCHEMA_PATHS: Readonly<Record<string, string>> = {
  'test-plan-proposal': 'agents/definitions/planner/planner-payload.schema.json',
  'heal-proposal': 'agents/definitions/healer/healer-payload.schema.json',
};

/**
 * G-SCHEMA (STD-ART-001): the artifact is a schema-valid envelope, and its payload is valid
 * against its agent's payload schema when one is given for its artifact type.
 */
export function createSchemaGuard(
  schemaPath: string,
  payloadSchemaPaths: Readonly<Record<string, string>> = {},
): (document: unknown) => GuardResult {
  const compile = (path: string): ReturnType<Ajv2020['compile']> =>
    // strictRequired is off: it flags conditional `required` keywords that are valid JSON Schema.
    new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(
      JSON.parse(readFileSync(path, 'utf8')) as object,
    );
  const validate = compile(schemaPath);
  // Compiled on first use, so artifacts of other types never depend on these files. A payload
  // schema that is listed but cannot be loaded fails the artifact (fail closed).
  const payloadValidators = new Map<string, ReturnType<Ajv2020['compile']> | string>();
  const payloadValidator = (type: string): ReturnType<Ajv2020['compile']> | string | undefined => {
    const path = payloadSchemaPaths[type];
    if (path === undefined) return undefined;
    if (!payloadValidators.has(type)) {
      try {
        payloadValidators.set(type, compile(path));
      } catch {
        payloadValidators.set(type, `the payload schema for ${type} cannot be loaded`);
      }
    }
    return payloadValidators.get(type);
  };

  return (document) => {
    if (!validate(document)) {
      const failures = (validate.errors ?? [])
        // `if` errors only say "must match then schema"; the real cause is reported separately.
        .filter((error) => error.keyword !== 'if')
        .map(toFailure);
      return { guard: 'G-SCHEMA', status: 'failed', failures: dedupe(failures) };
    }
    const { artifactType, payload } = document as { artifactType: string; payload: unknown };
    const validatePayload = payloadValidator(artifactType);
    if (typeof validatePayload === 'string') {
      return {
        guard: 'G-SCHEMA',
        status: 'failed',
        failures: [
          { guard: 'G-SCHEMA', ruleIds: ['STD-ART-001'], reason: `/payload ${validatePayload}` },
        ],
      };
    }
    if (validatePayload === undefined || validatePayload(payload)) {
      return { guard: 'G-SCHEMA', status: 'passed', failures: [] };
    }
    const failures = (validatePayload.errors ?? []).map((error) =>
      toFailure({ ...error, instancePath: `/payload${error.instancePath}` }),
    );
    return { guard: 'G-SCHEMA', status: 'failed', failures: dedupe(failures) };
  };
}

/** Type guard for code that runs after G-SCHEMA has passed. */
export function isValidatedArtifact(document: unknown, result: GuardResult): document is Artifact {
  return result.status === 'passed' && typeof document === 'object' && document !== null;
}

function toFailure(error: ErrorObject): GuardFailure {
  const location = error.instancePath === '' ? '(root)' : error.instancePath;
  return { guard: 'G-SCHEMA', ruleIds: rulesFor(error), reason: `${location} ${describe(error)}` };
}

function describe(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'required') {
    return `is missing required property "${String(params['missingProperty'])}"`;
  }
  if (error.keyword === 'additionalProperties') {
    return `has unexpected property "${String(params['additionalProperty'])}"`;
  }
  if (error.keyword === 'enum') {
    const allowed = (params['allowedValues'] as unknown[]).map(String).join(', ');
    return `must be one of: ${allowed}`;
  }
  if (error.keyword === 'not' && /\/proposedChanges\/\d+$/.test(error.instancePath)) {
    return 'must not have baseSha for operation "create"';
  }
  return error.message ?? `fails "${error.keyword}"`;
}

/** Maps a schema error to the Standard rules it represents, beyond the general STD-ART-001. */
function rulesFor(error: ErrorObject): string[] {
  const path = error.instancePath;
  const missing = (error.params as { missingProperty?: string }).missingProperty;
  const rules = new Set(['STD-ART-001']);

  if (path.startsWith('/sourceReferences') || missing === 'sourceReferences') {
    rules.add('STD-CTX-002');
  }
  if (path.startsWith('/contextRequests') || missing === 'contextRequests')
    rules.add('STD-CTX-003');
  if (path === '/findings' && error.keyword === 'minItems') rules.add('STD-UNC-001');
  if (path.includes('/traceability')) rules.add('STD-TRC-001');
  if (missing === 'impact') rules.add('STD-ART-002');
  if (missing === 'baseSha' || path.endsWith('/baseSha') || error.keyword === 'not') {
    rules.add('STD-AUTH-003');
  }
  if (/\/proposedChanges\/\d+\/path$/.test(path)) rules.add('STD-AUTH-002');
  return [...rules];
}

function dedupe(failures: GuardFailure[]): GuardFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = failure.reason;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
