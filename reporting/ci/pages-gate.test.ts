import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import type { FetchLike } from './pages-gate.mjs';

/**
 * The Pages deployment gate (pages-gate.mjs): automatic deployment only after a CI history run
 * on main that composed and published a record; manual dispatch on main always; anything else
 * refused, and nothing guessed when the Actions API cannot be read. Offline: the API is a fake.
 */

const gateModule = import('./pages-gate.mjs');
const REPOSITORY = 'LarysaK/AI-QA-AutomationFramework';
const ENV = {
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_run',
  GITHUB_TOKEN: 'test-token',
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A workflow_run event for a CI history run, as GitHub sends it. */
function event(overrides: Record<string, unknown> = {}) {
  return {
    workflow_run: {
      id: 41000000001,
      run_attempt: 1,
      name: 'CI history',
      path: '.github/workflows/ci-history.yml',
      event: 'workflow_run',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      ...overrides,
    },
  };
}

const job = (name: string, conclusion: string | null, status = 'completed') => ({
  name,
  status,
  conclusion,
});
const jobs = (...list: unknown[]) => ({ total_count: list.length, jobs: list });
const PUBLISHED = jobs(job('Compose run record', 'success'), job('Publish run record', 'success'));

/** A fake Actions API that answers one jobs request and records it. */
function api(body: unknown, status = 200) {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers });
    return Promise.resolve({
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    });
  };
  return { calls, fetchImpl };
}

describe('Pages gate: automatic deployment after CI history', () => {
  test('deploys when a record was composed and published, reading the exact run attempt', async () => {
    const { gate } = await gateModule;
    const fake = api(PUBLISHED);
    assert.deepEqual(await gate(ENV, () => event({ run_attempt: 2 }), fake.fetchImpl), {
      deploy: true,
      reason: 'a run record was composed and published',
    });
    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.ok(call);
    assert.equal(
      call.url,
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/41000000001/attempts/2/jobs?per_page=100`,
    );
    assert.equal(call.headers['authorization'], 'Bearer test-token');
  });

  test('a recorded product test failure is a publication like any other, and is deployed', async () => {
    // The CI run failed, but CI history composed and published its record: the gate sees only the
    // CI history run, whose jobs succeeded, so the dashboard is redeployed to show the failure.
    const { gate } = await gateModule;
    assert.equal((await gate(ENV, () => event(), api(PUBLISHED).fetchImpl)).deploy, true);
  });

  const notDeployed: [string, Record<string, unknown>, unknown, RegExp][] = [
    ['a failed CI history run', { conclusion: 'failure' }, PUBLISHED, /concluded failure/],
    ['a cancelled CI history run', { conclusion: 'cancelled' }, PUBLISHED, /concluded cancelled/],
    ['a skipped CI history run', { conclusion: 'skipped' }, PUBLISHED, /concluded skipped/],
    ['a timed-out CI history run', { conclusion: 'timed_out' }, PUBLISHED, /concluded timed_out/],
    [
      'a successful run that published nothing (publish skipped)',
      {},
      jobs(job('Compose run record', 'success'), job('Publish run record', 'skipped')),
      /published no new record/,
    ],
    [
      'a publication that was rejected or failed',
      {},
      jobs(job('Compose run record', 'success'), job('Publish run record', 'failure')),
      /"Publish run record" concluded failure/,
    ],
    [
      'a compose job that did not succeed',
      {},
      jobs(job('Compose run record', 'skipped'), job('Publish run record', 'skipped')),
      /"Compose run record" concluded skipped/,
    ],
    [
      'a publish job that has not completed',
      {},
      jobs(job('Compose run record', 'success'), job('Publish run record', null, 'waiting')),
      /"Publish run record" concluded null/,
    ],
  ];
  for (const [name, overrides, answer, reason] of notDeployed) {
    test(`does not deploy after ${name}`, async () => {
      const { gate } = await gateModule;
      const fake = api(answer);
      const decision = await gate(ENV, () => event(overrides), fake.fetchImpl);
      assert.equal(decision.deploy, false);
      assert.match(decision.reason, reason);
    });
  }

  test('an unsuccessful run is decided without calling the API', async () => {
    const { gate } = await gateModule;
    const fake = api(PUBLISHED);
    await gate(ENV, () => event({ conclusion: 'failure' }), fake.fetchImpl);
    assert.equal(fake.calls.length, 0);
  });
});

describe('Pages gate: refusals (the run fails, nothing is deployed)', () => {
  const refusedEvents: [string, Record<string, unknown>, RegExp][] = [
    ['another workflow', { name: 'CI' }, /not a CI history run/],
    [
      'another workflow file',
      { path: '.github/workflows/other.yml' },
      /not the CI history workflow/,
    ],
    ['a run not triggered by CI', { event: 'workflow_dispatch' }, /not triggered by CI/],
    ['a run on another branch', { head_branch: 'feature' }, /not on main/],
    [
      'a run of another repository',
      { repository: { full_name: 'other/repo' } },
      /another repository/,
    ],
    ['a run from a fork', { head_repository: { full_name: 'fork/repo' } }, /from a fork/],
    ['an incomplete run', { status: 'in_progress' }, /not completed/],
    ['a malformed run ID', { id: '41000000001' }, /valid run ID/],
  ];
  for (const [name, overrides, reason] of refusedEvents) {
    test(`refuses ${name}`, async () => {
      const { gate, GateError } = await gateModule;
      await assert.rejects(
        gate(ENV, () => event(overrides), api(PUBLISHED).fetchImpl),
        (error: unknown) => error instanceof GateError && reason.test(error.message),
      );
    });
  }

  test('refuses other events and other refs; manual dispatch on main deploys without the API', async () => {
    const { gate, GateError } = await gateModule;
    const fake = api(PUBLISHED);
    for (const env of [
      { ...ENV, GITHUB_EVENT_NAME: 'push' },
      { ...ENV, GITHUB_EVENT_NAME: 'pull_request' },
      { ...ENV, GITHUB_REF: 'refs/heads/feature' },
      { ...ENV, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' },
      { ...ENV, GITHUB_REPOSITORY: 'not a repository' },
    ]) {
      await assert.rejects(
        gate(env, () => event(), fake.fetchImpl),
        GateError,
      );
    }
    assert.deepEqual(
      await gate({ ...ENV, GITHUB_EVENT_NAME: 'workflow_dispatch' }, () => ({}), fake.fetchImpl),
      { deploy: true, reason: 'manual workflow_dispatch on main' },
    );
    assert.equal(fake.calls.length, 0);
  });

  test('never guesses when the jobs cannot be read', async () => {
    const { gate, GateError } = await gateModule;
    for (const [body, status] of [
      [PUBLISHED, 403],
      [PUBLISHED, 500],
      ['not json', 200],
      [{ total_count: 3, jobs: PUBLISHED.jobs }, 200],
      [jobs(job('Compose run record', 'success')), 200],
      [
        jobs(
          job('Compose run record', 'success'),
          job('Publish run record', 'success'),
          job('Publish run record', 'success'),
        ),
        200,
      ],
    ] as const) {
      await assert.rejects(
        gate(ENV, () => event(), api(body, status).fetchImpl),
        GateError,
      );
    }
  });

  test('refuses an API URL that is not https', async () => {
    const { gate, GateError } = await gateModule;
    await assert.rejects(
      gate(
        { ...ENV, GITHUB_API_URL: 'http://api.github.com' },
        () => event(),
        api(PUBLISHED).fetchImpl,
      ),
      GateError,
    );
  });
});

describe('Pages gate: command line', () => {
  test('a manual dispatch prints the GitHub output lines; a refusal exits 1 and prints nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pages-gate-'));
    dirs.push(dir);
    const eventFile = join(dir, 'event.json');
    writeFileSync(eventFile, '{}');
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [join(__dirname, 'pages-gate.mjs')], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', GITHUB_EVENT_PATH: eventFile, ...env },
      });
    const manual = run({ ...ENV, GITHUB_EVENT_NAME: 'workflow_dispatch' });
    assert.equal(manual.status, 0, manual.stderr);
    assert.equal(manual.stdout, 'deploy=true\nreason=manual workflow_dispatch on main\n');
    const refused = run({ ...ENV, GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /Pages gate refused: the event pull_request never deploys/);
  });
});
