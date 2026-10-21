import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  collectSuites,
  CollectError,
  type ReportInput,
  type StepConclusion,
  SUITE_IDS,
  type SuiteId,
} from './collect';
import { RUN_2_CONTEXT } from './context.test';
import {
  ARTIFACT_CLOCK_TOLERANCE_MS,
  ARTIFACTS,
  type ApiInputs,
  apiRequests,
  artifactName,
  type ArtifactKind,
  fetchApiInputs,
  HandoffError,
  MAX_API_RESPONSE_BYTES,
  readArtifactFile,
  resolveHandoff,
} from './handoff';
import { composeStage, resolveStage, stepOutputs, summaryStage } from './handoff-cli';
import { canonicalJson, MAX_RECORD_BYTES, sha256 } from './history';

/**
 * CI artifact hand-off and the read-only dry run (Phase 5.3 M3c). Offline. API responses, the
 * artifact listings and the upload steps are SYNTHETIC, derived from run #2's public API data
 * (fixtures/github): no run with hand-off artifacts has been observed yet.
 */

const REPO = resolve('.');
const FIXTURES = join(__dirname, 'fixtures');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const read = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8');
const json = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;
const EVENT_FIXTURE = join(FIXTURES, 'github/workflow-run-event-39144953322.json');

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temporary = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------- synthetic API inputs

/** The job window encloses the locally generated fixture reports, as in ci.test.ts (derived). */
const JOB_STARTED = '2026-10-18T20:04:00Z';
const JOB_COMPLETED = '2026-10-18T20:10:00Z';

/** GET .../runs/{id}/attempts/1: run #2's data plus head_repository (derived). */
function attemptRun(): Record<string, unknown> {
  return {
    ...json('github/run-39144953322.json'),
    head_repository: { full_name: 'LarysaK/AI-QA-AutomationFramework' },
  };
}

type Steps = Record<string, unknown>[];
const stepsOf = (jobs: Record<string, unknown>): Steps =>
  ((jobs['jobs'] as Record<string, unknown>[])[0] as Record<string, unknown>)['steps'] as Steps;
const jobOf = (jobs: Record<string, unknown>): Record<string, unknown> =>
  (jobs['jobs'] as Record<string, unknown>[])[0] as Record<string, unknown>;

/** Run #2's jobs with the M3c steps inserted where ci.yml has them (derived). */
function attemptJobs(): Record<string, unknown> {
  const jobs = json('github/jobs-39144953322-attempt-1.json');
  const job = jobOf(jobs);
  job['started_at'] = JOB_STARTED;
  job['completed_at'] = JOB_COMPLETED;
  const steps = stepsOf(jobs);
  const step = (name: string): Record<string, unknown> => ({
    name,
    status: 'completed',
    conclusion: 'success',
    number: 0,
  });
  steps.splice(
    steps.findIndex((s) => s['name'] === 'Playwright tests') + 1,
    0,
    step('Collect suite results'),
    step(ARTIFACTS.snapshot.uploadStep),
    step(ARTIFACTS.suites.uploadStep),
  );
  steps.forEach((s, i) => (s['number'] = i + 1));
  return jobs;
}

function setStep(jobs: Record<string, unknown>, name: string, conclusion: string): void {
  const step = stepsOf(jobs).find((s) => s['name'] === name);
  assert.ok(step, name);
  step['conclusion'] = conclusion;
}

function artifact(
  kind: ArtifactKind,
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: kind === 'snapshot' ? 5001 : 5002,
    node_id: 'synthetic',
    name: artifactName(kind, 1),
    size_in_bytes: 4096,
    url: 'https://api.github.com/synthetic',
    archive_download_url: 'https://api.github.com/synthetic/zip',
    expired: false,
    digest: `sha256:${(kind === 'snapshot' ? 'a' : 'b').repeat(64)}`,
    created_at: kind === 'snapshot' ? '2026-10-18T20:05:00Z' : '2026-10-18T20:09:30Z',
    updated_at: '2026-10-18T20:09:30Z',
    expires_at: '2026-10-25T20:09:30Z',
    workflow_run: {
      id: 39144953322,
      repository_id: 1000,
      head_repository_id: 1000,
      head_branch: 'main',
      head_sha: '11f78cdab0e2b4a4b2e92de4bcace444502de158',
    },
    ...change,
  };
}

const listing = (...artifacts: unknown[]): Record<string, unknown> => ({
  total_count: artifacts.length,
  artifacts,
});

function api(): {
  run: Record<string, unknown>;
  jobs: Record<string, unknown>;
  listings: Record<ArtifactKind, Record<string, unknown>>;
} {
  return {
    run: attemptRun(),
    jobs: attemptJobs(),
    listings: { snapshot: listing(artifact('snapshot')), suites: listing(artifact('suites')) },
  };
}

/** A JSON object inside a test value (asserted, so a wrong path fails loudly). */
function obj(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function refused(fn: () => unknown, reason: RegExp): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HandoffError, `expected a HandoffError, got ${String(error)}`);
    assert.match(error.problems.join('\n'), reason);
    return;
  }
  assert.fail('expected a HandoffError');
}

// ---------------------------------------------------------------- decisions

describe('hand-off: artifact names', () => {
  test('are bound to the run attempt', () => {
    assert.equal(artifactName('snapshot', 1), 'ci-snapshot-attempt-1');
    assert.equal(artifactName('suites', 3), 'ci-suite-results-attempt-3');
  });

  test('API requests are attempt-scoped and ask for the exact names', () => {
    const base = '/repos/LarysaK/AI-QA-AutomationFramework/actions/runs/39144953322';
    assert.deepEqual(apiRequests({ ...RUN_2_CONTEXT, runAttempt: 2 }), {
      run: `${base}/attempts/2`,
      jobs: `${base}/attempts/2/jobs?per_page=100`,
      snapshot: `${base}/artifacts?name=ci-snapshot-attempt-2&per_page=100`,
      suites: `${base}/artifacts?name=ci-suite-results-attempt-2&per_page=100`,
    });
  });
});

describe('hand-off: resolving the triggering attempt (synthetic API data)', () => {
  test('both artifacts present: download each by its ID', () => {
    const resolution = resolveHandoff(RUN_2_CONTEXT, api());
    assert.deepEqual(resolution, {
      schemaVersion: '1.0',
      kind: 'ci-handoff',
      runId: 39144953322,
      runAttempt: 1,
      runNumber: 2,
      recordable: true,
      snapshot: {
        state: 'download',
        name: 'ci-snapshot-attempt-1',
        id: 5001,
        sizeInBytes: 4096,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      suites: {
        state: 'download',
        name: 'ci-suite-results-attempt-1',
        id: 5002,
        sizeInBytes: 4096,
        digest: `sha256:${'b'.repeat(64)}`,
      },
    });
    assert.equal(
      stepOutputs(resolution),
      'recordable=true\nrun-id=39144953322\nsnapshot-id=5001\nsuites-id=5002\n',
    );
  });

  test('snapshot generation failed, upload skipped: never produced, not recordable, no IDs', () => {
    const inputs = api();
    setStep(inputs.jobs, 'Generate dashboard snapshot', 'failure');
    setStep(inputs.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
    inputs.listings.snapshot = listing();
    const resolution = resolveHandoff(RUN_2_CONTEXT, inputs);
    assert.equal(resolution.recordable, false);
    assert.deepEqual(resolution.snapshot, {
      state: 'not-produced',
      name: 'ci-snapshot-attempt-1',
      reason:
        'the CI job did not generate the snapshot (step "Generate dashboard snapshot": failure); a run record needs the snapshot, so none is composed',
    });
    assert.match(stepOutputs(resolution), /^recordable=false\n.*\nsnapshot-id=\n/s);
  });

  test('snapshot generation cancelled or skipped (an earlier failure), upload skipped: not recordable', () => {
    for (const conclusion of ['cancelled', 'skipped']) {
      const inputs = api();
      setStep(inputs.jobs, 'Generate dashboard snapshot', conclusion);
      setStep(inputs.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
      inputs.listings.snapshot = listing();
      const resolution = resolveHandoff(RUN_2_CONTEXT, inputs);
      assert.equal(resolution.recordable, false, conclusion);
      assert.ok(resolution.snapshot.state === 'not-produced');
      assert.match(resolution.snapshot.reason, new RegExp(`: ${conclusion}\\)`));
    }
  });

  test('snapshot generated but upload skipped: refused, never "not produced"', () => {
    const inputs = api();
    setStep(inputs.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
    inputs.listings.snapshot = listing();
    refused(
      () => resolveHandoff(RUN_2_CONTEXT, inputs),
      /ci-snapshot-attempt-1: step "Generate dashboard snapshot" succeeded but the upload was skipped; refusing to treat the snapshot as never produced/,
    );
  });

  test('snapshot generated, upload succeeded, artifact absent: refused', () => {
    const inputs = api();
    inputs.listings.snapshot = listing();
    refused(
      () => resolveHandoff(RUN_2_CONTEXT, inputs),
      /ci-snapshot-attempt-1: the upload step succeeded but the artifact is missing/,
    );
  });

  test('a snapshot upload skipped without a generate step, or with an unknown conclusion: refused', () => {
    const missing = api();
    setStep(missing.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
    missing.listings.snapshot = listing();
    const steps = stepsOf(missing.jobs);
    steps.splice(
      steps.findIndex((s) => s['name'] === 'Generate dashboard snapshot'),
      1,
    );
    refused(
      () => resolveHandoff(RUN_2_CONTEXT, missing),
      /expected exactly one step "Generate dashboard snapshot", found 0/,
    );
    const unknown = api();
    setStep(unknown.jobs, 'Generate dashboard snapshot', '$(touch pwned)');
    setStep(unknown.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
    unknown.listings.snapshot = listing();
    refused(
      () => resolveHandoff(RUN_2_CONTEXT, unknown),
      /step "Generate dashboard snapshot" has an unknown conclusion/,
    );
  });

  test('suite results never collected: incomplete suites, still recordable', () => {
    const inputs = api();
    setStep(inputs.jobs, 'Collect suite results', 'failure');
    setStep(inputs.jobs, ARTIFACTS.suites.uploadStep, 'skipped');
    inputs.listings.suites = listing();
    const resolution = resolveHandoff(RUN_2_CONTEXT, inputs);
    assert.equal(resolution.recordable, true);
    assert.equal(resolution.suites.state, 'not-produced');
    assert.match(stepOutputs(resolution), /suites-id=\n$/);
  });

  test('an unknown collect-step conclusion is never echoed', () => {
    const inputs = api();
    setStep(inputs.jobs, 'Collect suite results', '$(touch pwned)');
    setStep(inputs.jobs, ARTIFACTS.suites.uploadStep, 'skipped');
    inputs.listings.suites = listing();
    const resolution = resolveHandoff(RUN_2_CONTEXT, inputs);
    assert.ok(resolution.suites.state === 'not-produced');
    assert.match(resolution.suites.reason, /: unknown\)/);
    assert.ok(!JSON.stringify(resolution).includes('pwned'));
  });

  const unexpected: [string, (i: ReturnType<typeof api>) => void, RegExp][] = [
    [
      'a missing snapshot although its upload succeeded',
      (i) => (i.listings.snapshot = listing()),
      /ci-snapshot-attempt-1: the upload step succeeded but the artifact is missing/,
    ],
    [
      'missing suite results although their upload succeeded',
      (i) => (i.listings.suites = listing()),
      /ci-suite-results-attempt-1: the upload step succeeded but the artifact is missing/,
    ],
    [
      'an artifact although its upload was skipped',
      (i) => {
        setStep(i.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
      },
      /upload step was skipped, yet the artifact exists/,
    ],
    [
      'a failed upload',
      (i) => {
        setStep(i.jobs, ARTIFACTS.suites.uploadStep, 'failure');
      },
      /the upload step concluded "failure"/,
    ],
    [
      'a cancelled upload',
      (i) => {
        setStep(i.jobs, ARTIFACTS.snapshot.uploadStep, 'cancelled');
      },
      /the upload step concluded "cancelled"/,
    ],
    [
      'duplicate artifacts with the expected name',
      (i) =>
        (i.listings.snapshot = listing(artifact('snapshot'), artifact('snapshot', { id: 5003 }))),
      /2 artifacts share this name; refusing to choose one/,
    ],
    [
      'an incomplete listing (more artifacts than listed)',
      (i) => (i.listings.suites = { total_count: 2, artifacts: [artifact('suites')] }),
      /the artifact listing is not a complete list/,
    ],
    [
      'a listing that is not a listing',
      (i) => (i.listings.suites = { artifacts: 'none' }),
      /the artifact listing is not a complete list/,
    ],
    [
      "another attempt's artifact in the listing",
      (i) =>
        (i.listings.snapshot = listing(artifact('snapshot', { name: 'ci-snapshot-attempt-2' }))),
      /the listing contains artifacts with other names/,
    ],
    [
      'an artifact of another run',
      (i) =>
        (i.listings.snapshot = listing(
          artifact('snapshot', {
            workflow_run: { ...(artifact('snapshot')['workflow_run'] as object), id: 1 },
          }),
        )),
      /belongs to another run/,
    ],
    [
      'an artifact of another commit',
      (i) =>
        (i.listings.suites = listing(
          artifact('suites', {
            workflow_run: {
              ...(artifact('suites')['workflow_run'] as object),
              head_sha: 'f'.repeat(40),
            },
          }),
        )),
      /belongs to another commit/,
    ],
    [
      'an artifact of another branch',
      (i) =>
        (i.listings.suites = listing(
          artifact('suites', {
            workflow_run: { ...(artifact('suites')['workflow_run'] as object), head_branch: 'x' },
          }),
        )),
      /belongs to another branch/,
    ],
    [
      'an artifact from a fork head repository',
      (i) =>
        (i.listings.suites = listing(
          artifact('suites', {
            workflow_run: {
              ...(artifact('suites')['workflow_run'] as object),
              head_repository_id: 2000,
            },
          }),
        )),
      /comes from another \(head\) repository/,
    ],
    [
      'an artifact created before this attempt started (an earlier attempt)',
      (i) =>
        (i.listings.snapshot = listing(
          artifact('snapshot', {
            created_at: new Date(
              Date.parse(JOB_STARTED) - ARTIFACT_CLOCK_TOLERANCE_MS - 1000,
            ).toISOString(),
          }),
        )),
      /was not created during this attempt's Verify job/,
    ],
    [
      'an artifact created after the job completed',
      (i) =>
        (i.listings.suites = listing(artifact('suites', { created_at: '2026-10-18T21:00:00Z' }))),
      /was not created during this attempt's Verify job/,
    ],
    [
      'a malformed artifact timestamp',
      (i) =>
        (i.listings.suites = listing(artifact('suites', { created_at: '2026-02-30T20:05:00Z' }))),
      /was not created during this attempt's Verify job/,
    ],
    [
      'an expired artifact',
      (i) => (i.listings.snapshot = listing(artifact('snapshot', { expired: true }))),
      /has expired/,
    ],
    [
      'an artifact without a digest',
      (i) => (i.listings.snapshot = listing(artifact('snapshot', { digest: null }))),
      /has no sha256 digest/,
    ],
    [
      'an artifact with a malformed digest',
      (i) => (i.listings.snapshot = listing(artifact('snapshot', { digest: 'md5:abc' }))),
      /has no sha256 digest/,
    ],
    [
      'an oversized snapshot',
      (i) =>
        (i.listings.snapshot = listing(
          artifact('snapshot', { size_in_bytes: ARTIFACTS.snapshot.maxBytes + 1 }),
        )),
      /size is missing or larger than 8388608 bytes/,
    ],
    [
      'oversized suite results',
      (i) =>
        (i.listings.suites = listing(
          artifact('suites', { size_in_bytes: ARTIFACTS.suites.maxBytes + 1 }),
        )),
      /size is missing or larger than 4194304 bytes/,
    ],
    [
      'a malformed artifact ID',
      (i) => (i.listings.snapshot = listing(artifact('snapshot', { id: '5001; rm -rf /' }))),
      /id is missing or malformed/,
    ],
    [
      'a CI job without the hand-off steps (before M3c)',
      (i) => {
        const steps = stepsOf(i.jobs);
        steps.splice(
          steps.findIndex((s) => s['name'] === ARTIFACTS.snapshot.uploadStep),
          1,
        );
      },
      /expected exactly one step "Upload dashboard snapshot", found 0 \(a CI workflow without the M3c hand-off\?\)/,
    ],
    [
      'two steps with an upload step name',
      (i) =>
        stepsOf(i.jobs).push({
          name: ARTIFACTS.suites.uploadStep,
          status: 'completed',
          conclusion: 'success',
          number: 99,
        }),
      /expected exactly one step "Upload suite results", found 2/,
    ],
    [
      'an upload step that did not complete',
      (i) => {
        const s = stepsOf(i.jobs).find((x) => x['name'] === ARTIFACTS.suites.uploadStep);
        assert.ok(s);
        s['status'] = 'in_progress';
      },
      /step "Upload suite results" did not complete/,
    ],
    [
      'an API run of another attempt',
      (i) => (i.run['run_attempt'] = 2),
      /run: attempt does not match the triggering attempt/,
    ],
    [
      'an API run that has not completed',
      (i) => (i.run['status'] = 'in_progress'),
      /run: the attempt has not completed/,
    ],
    [
      'an API run from a fork',
      (i) => (i.run['head_repository'] = { full_name: 'someone/fork' }),
      /run: head repository differs \(a fork\)/,
    ],
    [
      'an API run of another commit',
      (i) => (i.run['head_sha'] = 'f'.repeat(40)),
      /run: head_sha does not match/,
    ],
    [
      'a job of another attempt',
      (i) => (jobOf(i.jobs)['run_attempt'] = 2),
      /job: attempt does not match/,
    ],
    [
      'two Verify jobs',
      (i) => {
        const all = i.jobs['jobs'] as unknown[];
        all.push(structuredClone(all[0]));
        i.jobs['total_count'] = 2;
      },
      /expected exactly one "Verify" job, found 2/,
    ],
    [
      'an incomplete page of jobs',
      (i) => (i.jobs['total_count'] = 5),
      /jobs: the response is not a complete list of jobs/,
    ],
  ];
  for (const [name, mutate, reason] of unexpected) {
    test(`refuses ${name}`, () => {
      const inputs = api();
      mutate(inputs);
      refused(() => resolveHandoff(RUN_2_CONTEXT, inputs), reason);
    });
  }

  test('a re-run attempt uses only its own names and its own job window', () => {
    const context = { ...RUN_2_CONTEXT, runAttempt: 2 };
    const inputs = api();
    inputs.run['run_attempt'] = 2;
    jobOf(inputs.jobs)['run_attempt'] = 2;
    const second = (kind: ArtifactKind): Record<string, unknown> =>
      artifact(kind, { name: artifactName(kind, 2), id: kind === 'snapshot' ? 6001 : 6002 });
    inputs.listings = { snapshot: listing(second('snapshot')), suites: listing(second('suites')) };
    const resolution = resolveHandoff(context, inputs);
    assert.equal(resolution.runAttempt, 2);
    assert.ok(resolution.snapshot.state === 'download' && resolution.snapshot.id === 6001);
    assert.ok(
      resolution.suites.state === 'download' &&
        resolution.suites.name === 'ci-suite-results-attempt-2',
    );
    // Attempt 1's artifacts under attempt 2 would be refused: wrong name.
    inputs.listings.snapshot = listing(artifact('snapshot'));
    refused(() => resolveHandoff(context, inputs), /listing contains artifacts with other names/);
  });
});

// ---------------------------------------------------------------- downloaded folders

describe('hand-off: downloaded artifact folders', () => {
  const folder = (files: Record<string, string | Buffer>): string => {
    const dir = temporary('ci-handoff-folder-');
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };

  test('exactly the expected file is read', () => {
    assert.equal(readArtifactFile(folder({ 'suite-results.json': '{}' }), 'suites'), '{}');
  });

  test('refuses a missing folder, extra or wrong files, links, oversized or non-UTF-8 files', () => {
    refused(
      () => readArtifactFile(join(tmpdir(), 'ci-handoff-does-not-exist'), 'snapshot'),
      /ci-snapshot-attempt-<attempt>: the downloaded folder is missing/,
    );
    refused(
      () => readArtifactFile(folder({ 'suite-results.json': '{}', 'extra.sh': 'x' }), 'suites'),
      /expected exactly one file "suite-results.json", found 2 entries/,
    );
    refused(
      () => readArtifactFile(folder({ 'results.json': '{}' }), 'suites'),
      /expected exactly one file/,
    );
    const nested = temporary('ci-handoff-nested-');
    mkdirSync(join(nested, 'suite-results.json'));
    refused(() => readArtifactFile(nested, 'suites'), /is not a regular file/);
    const linked = temporary('ci-handoff-link-');
    symlinkSync(
      join(FIXTURES, 'snapshot/dashboard-data.json'),
      join(linked, 'dashboard-data.json'),
    );
    refused(() => readArtifactFile(linked, 'snapshot'), /is not a regular file/);
    refused(
      () =>
        readArtifactFile(
          folder({ 'suite-results.json': Buffer.alloc(ARTIFACTS.suites.maxBytes + 1, 0x20) }),
          'suites',
        ),
      /larger than 4194304 bytes/,
    );
    refused(
      () =>
        readArtifactFile(
          folder({ 'suite-results.json': Buffer.from([0x7b, 0xff, 0x7d]) }),
          'suites',
        ),
      /not valid UTF-8/,
    );
  });
});

// ---------------------------------------------------------------- API fetching

describe('hand-off: fetching API data (fake transport)', () => {
  const TOKEN = 'ghs_' + 'T'.repeat(36);
  const fake = (respond: (url: string) => { status: number; body: string }) => {
    const calls: { url: string; headers: Record<string, string>; redirect: string }[] = [];
    return {
      calls,
      fetch: (url: string, init: { headers: Record<string, string>; redirect: 'error' }) => {
        calls.push({ url, headers: init.headers, redirect: init.redirect });
        const { status, body } = respond(url);
        return Promise.resolve({ status, text: () => Promise.resolve(body) });
      },
    };
  };
  const responses = (url: string): { status: number; body: string } => {
    const inputs = api();
    if (url.includes('/jobs?')) return { status: 200, body: JSON.stringify(inputs.jobs) };
    if (url.includes('ci-snapshot'))
      return { status: 200, body: JSON.stringify(inputs.listings.snapshot) };
    if (url.includes('ci-suite'))
      return { status: 200, body: JSON.stringify(inputs.listings.suites) };
    return { status: 200, body: JSON.stringify(inputs.run) };
  };

  test('four GET requests to api.github.com, authenticated in a header, no redirects', async () => {
    const transport = fake(responses);
    const inputs = await fetchApiInputs(RUN_2_CONTEXT, TOKEN, transport.fetch);
    assert.deepEqual(resolveHandoff(RUN_2_CONTEXT, inputs).recordable, true);
    const requests = apiRequests(RUN_2_CONTEXT);
    assert.deepEqual(
      transport.calls.map((c) => c.url),
      [requests.run, requests.jobs, requests.snapshot, requests.suites].map(
        (path) => `https://api.github.com${path}`,
      ),
    );
    for (const call of transport.calls) {
      assert.equal(call.redirect, 'error');
      assert.equal(call.headers['Authorization'], `Bearer ${TOKEN}`);
      assert.equal(call.headers['X-GitHub-Api-Version'], '2022-11-28');
    }
  });

  const failures: [string, (url: string) => { status: number; body: string }, RegExp][] = [
    ['an HTTP error', () => ({ status: 404, body: '{}' }), /API run request failed with HTTP 404/],
    [
      'a non-JSON response',
      () => ({ status: 200, body: '<html>' }),
      /API run response is not JSON/,
    ],
    [
      'an oversized response',
      () => ({ status: 200, body: ' '.repeat(MAX_API_RESPONSE_BYTES + 1) }),
      /API run response is larger than 8388608 bytes/,
    ],
  ];
  for (const [name, respond, reason] of failures) {
    test(`refuses ${name}, without the token in the message`, async () => {
      await assert.rejects(fetchApiInputs(RUN_2_CONTEXT, TOKEN, fake(respond).fetch), (error) => {
        assert.ok(error instanceof HandoffError);
        assert.match(error.message, reason);
        assert.ok(!error.message.includes(TOKEN));
        return true;
      });
    });
  }

  test('refuses to run without a token', async () => {
    await assert.rejects(
      fetchApiInputs(RUN_2_CONTEXT, '', fake(responses).fetch),
      /GITHUB_TOKEN is not set/,
    );
  });
});

// ---------------------------------------------------------------- stages, end to end

function passingSuites(): unknown {
  const reports: Record<SuiteId, ReportInput> = {
    agents: { kind: 'present', text: read('tap/repository-pass.tap') },
    'dashboard-data': { kind: 'present', text: read('tap/repository-pass.tap') },
    'dashboard-frontend': { kind: 'present', text: read('vitest/repository-pass.json') },
    playwright: { kind: 'present', text: read('playwright/repository-pass.json') },
  };
  const outcomes = Object.fromEntries(SUITE_IDS.map((id) => [id, 'success'])) as Record<
    SuiteId,
    StepConclusion
  >;
  return collectSuites({ outcomes, reports, node: '22.23.3' });
}

const API_FILES: Record<string, (i: ApiInputs) => unknown> = {
  'run.json': (i) => i.run,
  'jobs.json': (i) => i.jobs,
  'artifacts-snapshot.json': (i) => i.listings.snapshot,
  'artifacts-suites.json': (i) => i.listings.suites,
};

/** A work folder as the workflow leaves it before `compose`, plus offline API responses. */
function workFolder(
  inputs: ApiInputs,
  downloads: { snapshot?: string; suites?: string },
): { work: string; apiDir: string } {
  const work = temporary('ci-handoff-work-');
  const apiDir = temporary('ci-handoff-api-');
  writeFileSync(join(work, 'context.json'), canonicalJson(RUN_2_CONTEXT));
  for (const [file, pick] of Object.entries(API_FILES))
    writeFileSync(join(apiDir, file), JSON.stringify(pick(inputs)));
  for (const [kind, content] of Object.entries(downloads) as [ArtifactKind, string][]) {
    mkdirSync(join(work, 'download', kind), { recursive: true });
    writeFileSync(join(work, 'download', kind, ARTIFACTS[kind].file), content);
  }
  return { work, apiDir };
}

const SNAPSHOT = read('snapshot/dashboard-data.json');
const SUITES = canonicalJson(passingSuites());

async function composed(): Promise<{ work: string; text: string }> {
  const { work, apiDir } = workFolder(api(), { snapshot: SNAPSHOT, suites: SUITES });
  await resolveStage(work, { api: apiDir });
  composeStage(work);
  return { work, text: readFileSync(join(work, 'record.json'), 'utf8') };
}

describe('hand-off: resolve and compose (offline, synthetic API data)', () => {
  test('a successful main run: the record is composed with every collector check', async () => {
    const { work, text } = await composed();
    const record = JSON.parse(text) as Record<string, unknown>;
    assert.equal(text, canonicalJson(record));
    assert.deepEqual(record['run'], {
      id: 39144953322,
      attempt: 1,
      number: 2,
      url: 'https://github.com/LarysaK/AI-QA-AutomationFramework/actions/runs/39144953322',
    });
    assert.equal(record['conclusion'], 'success');
    const steps = (record['steps'] as { name: string }[]).map((s) => s.name);
    assert.ok(steps.includes(ARTIFACTS.snapshot.uploadStep));
    assert.ok(steps.includes(ARTIFACTS.suites.uploadStep));
    for (const suite of record['suites'] as { state: string; counts: unknown }[]) {
      assert.equal(suite.state, 'passed');
      assert.notEqual(suite.counts, null);
    }
    assert.deepEqual(readdirSync(work).sort(), [
      'api',
      'context.json',
      'download',
      'record.json',
      'resolution.json',
    ]);
  });

  test('suite results never collected in a failed run: suites incomplete, never counted', async () => {
    const inputs = api();
    jobOf(inputs.jobs)['conclusion'] = 'failure';
    setStep(inputs.jobs, 'Playwright tests', 'failure');
    setStep(inputs.jobs, 'Collect suite results', 'failure');
    setStep(inputs.jobs, ARTIFACTS.suites.uploadStep, 'skipped');
    inputs.listings.suites = listing();
    const { work, apiDir } = workFolder(inputs, { snapshot: SNAPSHOT });
    await resolveStage(work, { api: apiDir });
    const record = composeStage(work) as Record<string, unknown>;
    assert.equal(record['conclusion'], 'failure');
    for (const suite of record['suites'] as { state: string; counts: unknown }[]) {
      assert.equal(suite.state, 'incomplete');
      assert.equal(suite.counts, null);
    }
    assert.equal(record['playwright'], null);
  });

  test('suite results never collected in a successful run: refused, nothing written', async () => {
    const inputs = api();
    setStep(inputs.jobs, ARTIFACTS.suites.uploadStep, 'skipped');
    inputs.listings.suites = listing();
    const { work, apiDir } = workFolder(inputs, { snapshot: SNAPSHOT });
    await resolveStage(work, { api: apiDir });
    assert.throws(
      () => composeStage(work),
      (error) => {
        assert.ok(error instanceof CollectError);
        assert.match(error.message, /conclusion "success" but a suite did not pass/);
        return true;
      },
    );
    assert.ok(!readdirSync(work).includes('record.json'));
  });

  test('the snapshot never produced: no record is composed', async () => {
    const inputs = api();
    jobOf(inputs.jobs)['conclusion'] = 'failure';
    setStep(inputs.jobs, 'Generate dashboard snapshot', 'failure');
    setStep(inputs.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
    inputs.listings.snapshot = listing();
    const { work, apiDir } = workFolder(inputs, {});
    const resolution = await resolveStage(work, { api: apiDir });
    assert.equal(resolution.recordable, false);
    refused(() => composeStage(work), /the snapshot was never produced; no record is composed/);
    assert.ok(!readdirSync(work).includes('record.json'));
  });

  test('compose re-derives the decision; an edited resolution.json changes nothing', async () => {
    const inputs = api();
    setStep(inputs.jobs, ARTIFACTS.suites.uploadStep, 'skipped');
    inputs.listings.suites = listing();
    const { work, apiDir } = workFolder(inputs, { snapshot: SNAPSHOT, suites: SUITES });
    await resolveStage(work, { api: apiDir });
    writeFileSync(join(work, 'resolution.json'), '{"recordable":true}');
    refused(
      () => composeStage(work),
      /suite results were never produced, yet a download folder exists/,
    );
  });

  const invalidDownloads: [string, { snapshot?: string; suites?: string }, RegExp][] = [
    [
      'a snapshot of another commit',
      {
        snapshot: SNAPSHOT.replace('11f78cdab0e2b4a4b2e92de4bcace444502de158', 'f'.repeat(40)),
        suites: SUITES,
      },
      /snapshot/,
    ],
    ['a snapshot that is not JSON', { snapshot: '{', suites: SUITES }, /JSON/],
    [
      'suite results that fail the schema',
      { snapshot: SNAPSHOT, suites: '{"kind":"suite-results"}' },
      /suite results/,
    ],
    ['a missing snapshot download', { suites: SUITES }, /the downloaded folder is missing/],
  ];
  for (const [name, downloads, reason] of invalidDownloads) {
    test(`refuses ${name}`, async () => {
      const { work, apiDir } = workFolder(api(), downloads);
      await resolveStage(work, { api: apiDir });
      assert.throws(
        () => composeStage(work),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, reason);
          return true;
        },
      );
      assert.ok(!readdirSync(work).includes('record.json'));
    });
  }

  test('the resolve CLI writes integer step outputs only', () => {
    const { work, apiDir } = workFolder(api(), {});
    const outputs = join(work, 'outputs.txt');
    writeFileSync(outputs, '');
    const result = spawnSync(
      TSX,
      [join(__dirname, 'handoff-cli.ts'), 'resolve', '--work', work, '--api', apiDir],
      {
        cwd: REPO,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', GITHUB_OUTPUT: outputs },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(outputs, 'utf8'),
      'recordable=true\nrun-id=39144953322\nsnapshot-id=5001\nsuites-id=5002\n',
    );
  });

  test('a refused hand-off exits 1 with a message that names no absolute path', () => {
    const inputs = api();
    inputs.listings.snapshot = listing();
    const { work, apiDir } = workFolder(inputs, {});
    const result = spawnSync(
      TSX,
      [join(__dirname, 'handoff-cli.ts'), 'resolve', '--work', work, '--api', apiDir],
      {
        cwd: REPO,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '' },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the upload step succeeded but the artifact is missing/);
    assert.ok(!result.stderr.includes(tmpdir()), result.stderr);
    assert.ok(!readdirSync(work).includes('resolution.json'));
  });
});

// ---------------------------------------------------------------- job summary

describe('hand-off: job summary', () => {
  test('a complete dry run: stages, counts and the DRY RUN notice, no paths', async () => {
    const { work, text } = await composed();
    writeFileSync(
      join(work, 'plan.json'),
      JSON.stringify({
        action: 'add',
        path: 'v1/runs/39144953322-1.json',
        sha256: sha256(text),
        changed: [],
        dryRun: true,
      }),
    );
    writeFileSync(join(work, 'check.json'), JSON.stringify({ check: 'passed' }));
    const summary = summaryStage(work);
    assert.match(summary, /^## CI history: DRY RUN\n\nNothing was published\./);
    assert.match(
      summary,
      /\| Run context \(workflow_run event\) \| run 39144953322, attempt 1, #2, push \|/,
    );
    assert.match(
      summary,
      /snapshot: downloaded \(digest checked by the download action\); suite results: downloaded/,
    );
    assert.match(summary, /\| Run record \| composed \(job conclusion: success\) \|/);
    assert.match(summary, new RegExp(`add v1/runs/39144953322-1\\.json, sha256 ${sha256(text)}`));
    assert.match(summary, /\| Publisher pre-check \| passed \|/);
    assert.match(summary, /\| playwright \| passed \| \d+ \| 0 \| 0 \| \d+ \| \d+ \|/);
    assert.ok(!summary.includes(work) && !summary.includes(tmpdir()));
  });

  test('a run that was never recordable says so', async () => {
    const inputs = api();
    setStep(inputs.jobs, 'Generate dashboard snapshot', 'failure');
    setStep(inputs.jobs, ARTIFACTS.snapshot.uploadStep, 'skipped');
    inputs.listings.snapshot = listing();
    const { work, apiDir } = workFolder(inputs, {});
    await resolveStage(work, { api: apiDir });
    const summary = summaryStage(work);
    assert.match(
      summary,
      /snapshot: never produced: the CI job did not generate the snapshot; suite results: present, not downloaded \(no record without the snapshot\)/,
    );
    assert.match(
      summary,
      /\| Run record \| not composed: a record is never composed without the snapshot \|/,
    );
  });

  test('missing stages are reported as failed; unexpected values are never echoed', () => {
    const work = temporary('ci-handoff-summary-');
    assert.match(
      summaryStage(work),
      /\| Run context \(workflow_run event\) \| failed or did not run/,
    );
    writeFileSync(
      join(work, 'context.json'),
      JSON.stringify({ runId: '1; rm -rf /', event: '<script>' }),
    );
    writeFileSync(
      join(work, 'resolution.json'),
      JSON.stringify({ recordable: true, snapshot: { state: 'download' } }),
    );
    writeFileSync(
      join(work, 'plan.json'),
      JSON.stringify({ action: '`x`', path: '../../etc/passwd', sha256: 'zz' }),
    );
    const summary = summaryStage(work);
    assert.match(summary, /run \?, attempt \?, #\?, \?/);
    assert.match(summary, /\| History plan \(empty history\) \| \? \?, sha256 \? \|/);
    for (const text of ['rm -rf', '<script>', 'passwd', '`x`'])
      assert.ok(!summary.includes(text), text);
  });
});

// ---------------------------------------------------------------- history plan (read-only)

/** Every entry under `dir`, including .git, with type and content hash. */
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string, rel: string): void => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const stat = lstatSync(absolute);
      const at = `${rel}${name}`;
      if (stat.isDirectory()) {
        out.push(`${at}/`);
        walk(absolute, `${at}/`);
      } else {
        out.push(
          `${at} ${String(stat.mode)} ${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`,
        );
      }
    }
  };
  walk(dir, '');
  return out;
}

const historyCli = (args: string[]) =>
  spawnSync(TSX, [join(__dirname, 'history-cli.ts'), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

describe('history plan (dry run)', () => {
  test('plans an addition and leaves an empty history unchanged', async () => {
    const { work } = await composed();
    const history = temporary('ci-history-plan-');
    const result = historyCli([
      'plan',
      '--history',
      history,
      '--record',
      join(work, 'record.json'),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(join(work, 'record.json'), 'utf8');
    assert.deepEqual(JSON.parse(result.stdout), {
      action: 'add',
      path: 'v1/runs/39144953322-1.json',
      sha256: sha256(text),
      changed: ['v1/runs/39144953322-1.json', 'v1/index.json'],
      dryRun: true,
    });
    assert.deepEqual(readdirSync(history), []);
  });

  test('writes no file, index, branch or ref in a populated git history', async () => {
    const { work } = await composed();
    const history = temporary('ci-history-plan-git-');
    git(history, 'init', '-q', '-b', 'ci-history');
    // A valid one-record history, added by the real tool, then committed.
    const other = JSON.parse(readFileSync(join(work, 'record.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    (other['run'] as Record<string, unknown>)['attempt'] = 2;
    const otherFile = join(work, 'other.json');
    writeFileSync(otherFile, canonicalJson(other));
    assert.equal(historyCli(['add', '--history', history, '--record', otherFile]).status, 0);
    git(history, 'add', '--', 'v1');
    git(history, 'commit', '-q', '-m', 'history');
    const before = fingerprint(history);
    const refs = git(history, 'show-ref');

    const planned = historyCli([
      'plan',
      '--history',
      history,
      '--record',
      join(work, 'record.json'),
    ]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal((JSON.parse(planned.stdout) as { action: string }).action, 'add');
    assert.deepEqual(fingerprint(history), before);
    assert.equal(git(history, 'show-ref'), refs);
    assert.equal(git(history, 'status', '--porcelain', '--untracked-files=all'), '');

    // The same record again: unchanged. A different record for the same attempt: refused.
    const same = historyCli(['plan', '--history', history, '--record', otherFile]);
    assert.equal((JSON.parse(same.stdout) as { action: string }).action, 'unchanged');
    other['conclusion'] = 'failure' as never;
    writeFileSync(otherFile, canonicalJson(other));
    const conflict = historyCli(['plan', '--history', history, '--record', otherFile]);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /a different record already exists for this run attempt/);
    assert.deepEqual(fingerprint(history), before);
  });

  test('refuses an invalid history or record and still writes nothing', async () => {
    const { work } = await composed();
    const history = temporary('ci-history-plan-bad-');
    mkdirSync(join(history, 'v1/runs'), { recursive: true });
    writeFileSync(join(history, 'v1/runs/1-1.json'), '{}');
    const before = fingerprint(history);
    const result = historyCli([
      'plan',
      '--history',
      history,
      '--record',
      join(work, 'record.json'),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the existing history is not valid/);
    assert.deepEqual(fingerprint(history), before);

    const empty = temporary('ci-history-plan-big-');
    const big = join(work, 'big.json');
    writeFileSync(big, ' '.repeat(MAX_RECORD_BYTES + 1));
    const oversized = historyCli(['plan', '--history', empty, '--record', big]);
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /larger than 1048576 bytes/);
    assert.deepEqual(readdirSync(empty), []);
  });
});

// ---------------------------------------------------------------- publish-check (plain Node.js)

const PUBLISH_CHECK = join(__dirname, 'publish-check.mjs');

function publishCheck(args: { record: string; sha?: string; event?: string; history?: string }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      PUBLISH_CHECK,
      '--event',
      args.event ?? EVENT_FIXTURE,
      '--record',
      args.record,
      '--sha256',
      args.sha ?? sha256(readFileSync(args.record, 'utf8')),
      '--history',
      args.history ?? temporary('ci-publish-history-'),
    ],
    // Plain Node.js: no tsx loader, no inherited options, run from outside the repository.
    { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('publish-check (plain Node.js, synthetic event fixture)', () => {
  const writeRecord = (value: unknown, raw?: string): string => {
    const file = join(temporary('ci-publish-record-'), 'record.json');
    writeFileSync(file, raw ?? canonicalJson(value));
    return file;
  };
  const base = async (): Promise<Record<string, unknown>> =>
    JSON.parse((await composed()).text) as Record<string, unknown>;

  test('a composed record passes; nothing is printed but the result', async () => {
    const record = await base();
    const file = writeRecord(record);
    const result = publishCheck({ record: file });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      check: 'passed',
      action: 'add',
      path: 'v1/runs/39144953322-1.json',
      sha256: sha256(canonicalJson(record)),
    });
  });

  test('immutable history: identical bytes are unchanged, different bytes are refused', async () => {
    const record = await base();
    const file = writeRecord(record);
    const history = temporary('ci-publish-existing-');
    mkdirSync(join(history, 'v1/runs'), { recursive: true });
    writeFileSync(join(history, 'v1/runs/39144953322-1.json'), canonicalJson(record));
    assert.equal(
      (JSON.parse(publishCheck({ record: file, history }).stdout) as { action: string }).action,
      'unchanged',
    );
    writeFileSync(
      join(history, 'v1/runs/39144953322-1.json'),
      canonicalJson({ ...record, conclusion: 'failure' }),
    );
    const refusedResult = publishCheck({ record: file, history });
    assert.equal(refusedResult.status, 1);
    assert.match(refusedResult.stderr, /a different record already exists for this run attempt/);
  });

  test('refuses links and non-files in the history and as the record', async () => {
    const record = await base();
    const file = writeRecord(record);
    const linkedRuns = temporary('ci-publish-linked-');
    mkdirSync(join(linkedRuns, 'v1'));
    symlinkSync(temporary('ci-publish-elsewhere-'), join(linkedRuns, 'v1/runs'));
    assert.match(
      publishCheck({ record: file, history: linkedRuns }).stderr,
      /a symbolic link is in the way/,
    );
    const dirInTheWay = temporary('ci-publish-dir-');
    mkdirSync(join(dirInTheWay, 'v1/runs/39144953322-1.json'), { recursive: true });
    assert.match(
      publishCheck({ record: file, history: dirInTheWay }).stderr,
      /something other than a record is in the way/,
    );
    const linkedRoot = join(temporary('ci-publish-root-'), 'history');
    symlinkSync(temporary('ci-publish-target-'), linkedRoot);
    assert.match(
      publishCheck({ record: file, history: linkedRoot }).stderr,
      /the history must be a directory/,
    );
    const linkedRecord = join(temporary('ci-publish-record-link-'), 'record.json');
    symlinkSync(file, linkedRecord);
    assert.match(
      publishCheck({ record: linkedRecord, sha: sha256(canonicalJson(record)) }).stderr,
      /the record is not a regular file/,
    );
  });

  const transport: [
    string,
    (r: Record<string, unknown>) => { raw?: string; sha?: string },
    RegExp,
  ][] = [
    [
      'a sha256 mismatch',
      () => ({ sha: 'f'.repeat(64) }),
      /sha256 does not match the value handed over/,
    ],
    [
      'a malformed sha256',
      () => ({ sha: 'F'.repeat(64) }),
      /the expected sha256 is missing or malformed/,
    ],
    [
      'non-canonical bytes',
      (r) => ({ raw: JSON.stringify(r, null, 4) }),
      /the record is not in canonical form/,
    ],
    [
      'no trailing newline',
      (r) => ({ raw: JSON.stringify(r, null, 2) }),
      /the record is not in canonical form/,
    ],
    [
      'an oversized record',
      () => ({ raw: ' '.repeat(MAX_RECORD_BYTES + 1) }),
      /the record is larger than 1048576 bytes/,
    ],
    ['not JSON', () => ({ raw: '{' }), /the record is not JSON/],
    ['a JSON array', () => ({ raw: '[]\n' }), /the record is not a JSON object/],
  ];
  for (const [name, make, reason] of transport) {
    test(`refuses ${name}`, async () => {
      const record = await base();
      const { raw, sha } = make(record);
      const file = writeRecord(record, raw);
      const result = publishCheck({ record: file, ...(sha === undefined ? {} : { sha }) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, reason);
    });
  }

  test('refuses bytes that are not UTF-8', () => {
    const file = join(temporary('ci-publish-utf8-'), 'record.json');
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    const result = publishCheck({ record: file, sha: 'a'.repeat(64) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the record is not valid UTF-8/);
  });

  const identity: [string, (r: Record<string, Record<string, unknown>>) => void, RegExp][] = [
    ['another run ID', (r) => (obj(r['run'])['id'] = 1), /run ID differs from the event/],
    [
      'another attempt',
      (r) => (obj(r['run'])['attempt'] = 2),
      /run attempt differs from the event/,
    ],
    [
      'another run number',
      (r) => (obj(r['run'])['number'] = 3),
      /run number differs from the event/,
    ],
    [
      'another run URL',
      (r) => (obj(r['run'])['url'] = 'https://github.com/x/y/actions/runs/39144953322'),
      /run URL differs/,
    ],
    [
      'another commit',
      (r) => ((r as Record<string, unknown>)['commitSha'] = 'f'.repeat(40)),
      /commit differs from the event/,
    ],
    [
      'another event',
      (r) => (obj(r['trigger'])['event'] = 'workflow_dispatch'),
      /trigger event differs/,
    ],
    [
      'another ref',
      (r) => (obj(r['trigger'])['ref'] = 'refs/heads/feature'),
      /trigger ref differs/,
    ],
    [
      'another repository',
      (r) => ((r as Record<string, unknown>)['repository'] = 'someone/else'),
      /repository differs from the event/,
    ],
    [
      'another workflow',
      (r) => ((r as Record<string, unknown>)['workflow'] = 'Other'),
      /workflow differs from the event/,
    ],
    [
      'an unknown top-level field',
      (r) => ((r as Record<string, unknown>)['extra'] = 1),
      /exactly the ci-run 1.0 top-level fields/,
    ],
    [
      'a missing top-level field',
      (r) => delete (r as Record<string, unknown>)['playwright'],
      /exactly the ci-run 1.0 top-level fields/,
    ],
    [
      'an in-progress status',
      (r) => ((r as Record<string, unknown>)['status'] = 'in_progress'),
      /status is not completed/,
    ],
    [
      'an unknown conclusion',
      (r) => ((r as Record<string, unknown>)['conclusion'] = 'neutral'),
      /conclusion is not recordable/,
    ],
    [
      'content that is not public-safe',
      (r) => (obj((r['steps'] as unknown as unknown[])[0])['name'] = 'see /Users/someone/x'),
      /not public-safe: \/steps\/0\/name: absolute path/,
    ],
  ];
  for (const [name, mutate, reason] of identity) {
    test(`refuses a record with ${name}`, async () => {
      const record = (await base()) as Record<string, Record<string, unknown>>;
      mutate(record);
      const result = publishCheck({ record: writeRecord(record) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, reason);
    });
  }

  const events: [string, (e: Record<string, Record<string, unknown>>) => void, RegExp][] = [
    [
      'a pull request run',
      (e) => (obj(e['workflow_run'])['event'] = 'pull_request'),
      /"pull_request" runs are not recorded/,
    ],
    [
      'a fork',
      (e) => (obj(e['workflow_run'])['head_repository'] = { full_name: 'someone/fork' }),
      /a fork/,
    ],
    [
      'another branch',
      (e) => (obj(e['workflow_run'])['head_branch'] = 'feature'),
      /head_branch is not main/,
    ],
    [
      'an in-progress run',
      (e) => (obj(e['workflow_run'])['status'] = 'in_progress'),
      /not completed/,
    ],
  ];
  for (const [name, mutate, reason] of events) {
    test(`binds to the trusted event: refuses ${name}`, async () => {
      const record = await base();
      const event = json('github/workflow-run-event-39144953322.json') as Record<
        string,
        Record<string, unknown>
      >;
      mutate(event);
      const eventFile = join(temporary('ci-publish-event-'), 'event.json');
      writeFileSync(eventFile, JSON.stringify(event));
      const result = publishCheck({ record: writeRecord(record), event: eventFile });
      assert.equal(result.status, 1);
      assert.match(result.stderr, reason);
    });
  }

  test('a record for attempt 2 needs an event for attempt 2', async () => {
    const record = (await base()) as Record<string, Record<string, unknown>>;
    obj(record['run'])['attempt'] = 2;
    const file = writeRecord(record);
    assert.match(publishCheck({ record: file }).stderr, /run attempt differs from the event/);
    const event = json('github/workflow-run-event-39144953322.json') as Record<
      string,
      Record<string, unknown>
    >;
    obj(event['workflow_run'])['run_attempt'] = 2;
    const eventFile = join(temporary('ci-publish-event2-'), 'event.json');
    writeFileSync(eventFile, JSON.stringify(event));
    const result = publishCheck({ record: file, event: eventFile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      (JSON.parse(result.stdout) as { path: string }).path,
      'v1/runs/39144953322-2.json',
    );
  });

  test('is dependency-free: Node.js built-ins and three dependency-free repository modules', () => {
    const imports = (file: string): string[] =>
      [...readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map(
        (m) => m[1] ?? '',
      );
    assert.deepEqual(
      imports(PUBLISH_CHECK).filter((s) => !s.startsWith('node:')),
      ['../dashboard-data/sanitize.ts', './context.ts', './history.ts'],
    );
    for (const module of ['../dashboard-data/sanitize.ts', './context.ts', './history.ts']) {
      for (const specifier of imports(join(__dirname, module)))
        assert.match(specifier, /^node:/, module);
    }
  });
});

// ---------------------------------------------------------------- event shape diagnostic

describe('event-shape diagnostic (synthetic event fixture)', () => {
  const describeShape = (file: string) =>
    spawnSync(process.execPath, [join(__dirname, 'event-shape.mjs'), file], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });

  test('reports presence, type and shape of each relied-on field, and no values', () => {
    const result = describeShape(EVENT_FIXTURE);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      /\| `workflow_run\.id` \| yes \| number \| a positive integer \| yes \|/,
    );
    assert.match(
      result.stdout,
      /\| `workflow_run\.head_sha` \| yes \| string \| 40 lowercase hex digits \| yes \|/,
    );
    assert.match(result.stdout, /\| `repository\.default_branch` \| no \| — \|/);
    const event = readFileSync(EVENT_FIXTURE, 'utf8');
    const values = [...event.matchAll(/: ("[^"]{4,}"|\d{2,})/g)].map((m) =>
      (m[1] ?? '').replaceAll('"', ''),
    );
    assert.ok(values.length >= 8);
    for (const value of values.filter(
      (v) =>
        // Enumerated values also appear in the fixed shape descriptions.
        !['completed', 'success', 'push'].includes(v),
    ))
      assert.ok(!result.stdout.includes(value), `a value leaked: ${value}`);
  });

  test('a payload that cannot be read is reported, and the step still succeeds', () => {
    const dir = temporary('ci-event-shape-');
    writeFileSync(join(dir, 'bad.json'), '{');
    for (const file of [join(dir, 'bad.json'), join(dir, 'missing.json')]) {
      const result = describeShape(file);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /could not be read as JSON within the size limit/);
    }
    writeFileSync(join(dir, 'array.json'), '[]');
    assert.doesNotMatch(describeShape(join(dir, 'array.json')).stdout, /\| yes \|/);
  });
});

// ---------------------------------------------------------------- input limits

describe('ci:collect input limits', () => {
  const cli = (args: string[]) =>
    spawnSync(TSX, [join(__dirname, 'cli.ts'), ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });

  test('refuses oversized and non-regular JSON inputs before reading them', () => {
    const dir = temporary('ci-collect-limits-');
    writeFileSync(join(dir, 'big.json'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    const big = cli([
      'context',
      '--event',
      join(dir, 'big.json'),
      '--workflow',
      'CI',
      '--out',
      join(dir, 'out.json'),
    ]);
    assert.equal(big.status, 1);
    assert.match(big.stderr, /is larger than 16777216 bytes/);
    symlinkSync(EVENT_FIXTURE, join(dir, 'link.json'));
    const linked = cli([
      'context',
      '--event',
      join(dir, 'link.json'),
      '--workflow',
      'CI',
      '--out',
      join(dir, 'out.json'),
    ]);
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /is missing or not a regular file/);
    assert.ok(!readdirSync(dir).includes('out.json'));
    const ok = cli([
      'context',
      '--event',
      EVENT_FIXTURE,
      '--workflow',
      'CI',
      '--out',
      join(dir, 'out.json'),
    ]);
    assert.equal(ok.status, 0, ok.stderr);
  });
});
