import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  ContextError,
  contextFromWorkflowRunEvent,
  contextToEnvironment,
  parseRunContext,
  type RunContext,
} from './context';

/** CI run context: validation and derivation from a workflow_run event. Offline. */

const EVENT_FIXTURE = join(__dirname, 'fixtures/github/workflow-run-event-39144953322.json');
const event = (): Record<string, Record<string, unknown>> =>
  JSON.parse(readFileSync(EVENT_FIXTURE, 'utf8')) as Record<string, Record<string, unknown>>;

export const RUN_2_CONTEXT: RunContext = {
  schemaVersion: '1.0',
  kind: 'ci-run-context',
  serverUrl: 'https://github.com',
  repository: 'LarysaK/AI-QA-AutomationFramework',
  workflow: 'CI',
  runId: 39144953322,
  runAttempt: 1,
  runNumber: 2,
  headSha: '11f78cdab0e2b4a4b2e92de4bcace444502de158',
  ref: 'refs/heads/main',
  event: 'push',
};

function problemsOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ContextError, `expected a ContextError, got ${String(error)}`);
    return error.problems.join('\n');
  }
  return assert.fail('expected a ContextError');
}

describe('run context: validation', () => {
  test('a valid context is accepted unchanged', () => {
    assert.deepEqual(parseRunContext({ ...RUN_2_CONTEXT }), RUN_2_CONTEXT);
  });

  const invalid: [string, Record<string, unknown>, RegExp][] = [
    ['an unknown field', { extra: 1 }, /unknown fields: extra/],
    ['another schema version', { schemaVersion: '2.0' }, /schemaVersion/],
    ['plain http', { serverUrl: 'http://github.com' }, /serverUrl must be https:\/\/github\.com/],
    ['another server', { serverUrl: 'https://example.com' }, /serverUrl/],
    ['a malformed repository', { repository: 'not a repo' }, /repository is missing or malformed/],
    [
      'a workflow name with shell characters',
      { workflow: 'CI; rm -rf /' },
      /workflow is missing or malformed/,
    ],
    ['a short commit', { headSha: '11f78cd' }, /headSha/],
    ['an uppercase commit', { headSha: '11F78CDAB0E2B4A4B2E92DE4BCACE444502DE158' }, /headSha/],
    ['a tag ref', { ref: 'refs/tags/v1' }, /ref is missing or malformed/],
    ['an unknown event', { event: 'schedule' }, /event must be one of/],
    ['run ID zero', { runId: 0 }, /runId must be a positive integer/],
    ['a string run ID', { runId: '39144953322' }, /runId must be a positive integer/],
    ['a fractional attempt', { runAttempt: 1.5 }, /runAttempt must be a positive integer/],
    ['a missing run number', { runNumber: undefined }, /runNumber must be a positive integer/],
  ];
  for (const [name, change, reason] of invalid) {
    test(`rejects ${name}`, () => {
      const value: Record<string, unknown> = { ...RUN_2_CONTEXT, ...change };
      if ('runNumber' in change && change['runNumber'] === undefined) delete value['runNumber'];
      assert.match(
        problemsOf(() => parseRunContext(value)),
        reason,
      );
    });
  }

  test('rejects non-objects', () => {
    for (const value of [null, [], 'context', 1])
      assert.match(
        problemsOf(() => parseRunContext(value)),
        /JSON object/,
      );
  });

  test('maps to the runner variable names the record composer cross-checks', () => {
    assert.deepEqual(contextToEnvironment(RUN_2_CONTEXT), {
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'LarysaK/AI-QA-AutomationFramework',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_RUN_ID: '39144953322',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_NUMBER: '2',
      GITHUB_SHA: '11f78cdab0e2b4a4b2e92de4bcace444502de158',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'push',
    });
  });
});

describe('run context: from a workflow_run event (synthetic fixture)', () => {
  test('a completed push run on main of this repository', () => {
    assert.deepEqual(contextFromWorkflowRunEvent(event(), 'CI'), RUN_2_CONTEXT);
  });

  test('a completed workflow_dispatch run on main', () => {
    const e = event();
    (e['workflow_run'] as Record<string, unknown>)['event'] = 'workflow_dispatch';
    assert.equal(contextFromWorkflowRunEvent(e, 'CI').event, 'workflow_dispatch');
  });

  const refused: [string, (e: Record<string, Record<string, unknown>>) => void, RegExp][] = [
    [
      'a fork pull request from a branch named main',
      (e) => {
        const run = e['workflow_run'] as Record<string, unknown>;
        run['event'] = 'pull_request';
        run['head_repository'] = { full_name: 'someone/AI-QA-AutomationFramework' };
      },
      /a fork.*never recorded|"pull_request" runs are not recorded/,
    ],
    [
      'a fork whose run reports push',
      (e) => {
        (e['workflow_run'] as Record<string, unknown>)['head_repository'] = {
          full_name: 'someone/fork',
        };
      },
      /head repository differs \(a fork\)/,
    ],
    [
      'a pull request run',
      (e) => ((e['workflow_run'] as Record<string, unknown>)['event'] = 'pull_request'),
      /"pull_request" runs are not recorded/,
    ],
    [
      'another branch',
      (e) => ((e['workflow_run'] as Record<string, unknown>)['head_branch'] = 'feature'),
      /head_branch is not main/,
    ],
    [
      'an in-progress run',
      (e) => ((e['workflow_run'] as Record<string, unknown>)['status'] = 'in_progress'),
      /status is "in_progress"/,
    ],
    [
      'a queued run',
      (e) => ((e['workflow_run'] as Record<string, unknown>)['status'] = 'queued'),
      /status is "queued"/,
    ],
    [
      'another workflow',
      (e) => ((e['workflow_run'] as Record<string, unknown>)['name'] = 'Other'),
      /expected "CI"/,
    ],
    [
      'a run URL that does not match',
      (e) =>
        ((e['workflow_run'] as Record<string, unknown>)['html_url'] =
          'https://github.com/x/y/actions/runs/1'),
      /html_url does not match/,
    ],
    [
      'another repository',
      (e) => (e['repository'] = { full_name: 'someone/else' }),
      /repository differs/,
    ],
    [
      'a malformed commit',
      (e) => ((e['workflow_run'] as Record<string, unknown>)['head_sha'] = 'abc'),
      /headSha/,
    ],
    [
      'a missing attempt',
      (e) => delete (e['workflow_run'] as Record<string, unknown>)['run_attempt'],
      /runAttempt/,
    ],
  ];
  for (const [name, mutate, reason] of refused) {
    test(`refuses ${name}`, () => {
      const e = event();
      mutate(e);
      assert.match(
        problemsOf(() => contextFromWorkflowRunEvent(e, 'CI')),
        reason,
      );
    });
  }

  test('refuses payloads that are not workflow_run events', () => {
    for (const value of [null, {}, { workflow_run: 'x' }]) {
      assert.match(
        problemsOf(() => contextFromWorkflowRunEvent(value, 'CI')),
        /no workflow_run/,
      );
    }
  });
});
