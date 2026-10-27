// Deployment gate for the GitHub Pages workflow (Phase 5.3 M5). Dependency-free: plain Node.js.
//
//   node reporting/ci/pages-gate.mjs >> "$GITHUB_OUTPUT"
//
// Decides whether the dashboard may be deployed, from the trusted event file (GITHUB_EVENT_PATH)
// and, for an automatic deployment, the jobs of the triggering CI history run (read-only GET of
// the Actions API with GITHUB_TOKEN):
//   - workflow_dispatch on main of this repository: deploy (an explicit, manual decision);
//   - workflow_run: deploy only when the triggering run is a successful run of the CI history
//     workflow on main of this repository, triggered by CI, AND its jobs "Compose run record" and
//     "Publish run record" both succeeded: a run record was composed and published. A recorded
//     product test failure is such a publication and is deployed; a CI history run that failed,
//     was cancelled, was skipped or published nothing (publish skipped) is not.
// Prints "deploy=true" or "deploy=false" and "reason=<text>" (GitHub output format); exit 0.
// Exit 1, failing the run, when the event is not acceptable or the jobs cannot be read: the gate
// never guesses.

import console from 'node:console';
import { readFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const HISTORY_WORKFLOW = 'CI history';
export const HISTORY_WORKFLOW_PATH = '.github/workflows/ci-history.yml';
export const REQUIRED_JOBS = ['Compose run record', 'Publish run record'];
const MAX_BYTES = 4 * 1024 * 1024;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export class GateError extends Error {}

const field = (value, key) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value[key] : undefined;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * The triggering CI history run from a workflow_run event, if it may lead to a deployment;
 * throws GateError for an event that must never deploy.
 */
export function historyRun(event, repository) {
  const run = field(event, 'workflow_run');
  const problems = [];
  if (field(run, 'name') !== HISTORY_WORKFLOW) problems.push('not a CI history run');
  if (field(run, 'path') !== HISTORY_WORKFLOW_PATH) problems.push('not the CI history workflow');
  if (field(run, 'event') !== 'workflow_run') problems.push('not triggered by CI');
  if (field(run, 'status') !== 'completed') problems.push('not completed');
  if (field(run, 'head_branch') !== 'main') problems.push('not on main');
  if (field(field(run, 'repository'), 'full_name') !== repository) {
    problems.push('from another repository');
  }
  if (field(field(run, 'head_repository'), 'full_name') !== repository) {
    problems.push('from a fork');
  }
  if (!positive(field(run, 'id')) || !positive(field(run, 'run_attempt'))) {
    problems.push('without a valid run ID and attempt');
  }
  if (problems.length > 0) throw new GateError(`the triggering run is ${problems.join(', ')}`);
  return {
    id: field(run, 'id'),
    attempt: field(run, 'run_attempt'),
    conclusion: field(run, 'conclusion'),
  };
}

/** The deployment decision for a CI history run, from its conclusion and its jobs. */
export function decide(conclusion, jobsResponse) {
  if (conclusion !== 'success') {
    return { deploy: false, reason: `the CI history run concluded ${String(conclusion)}` };
  }
  const jobs = field(jobsResponse, 'jobs');
  const total = field(jobsResponse, 'total_count');
  if (!Array.isArray(jobs) || !Number.isSafeInteger(total) || total !== jobs.length) {
    throw new GateError("the CI history run's jobs could not be read completely");
  }
  for (const name of REQUIRED_JOBS) {
    const matching = jobs.filter((job) => field(job, 'name') === name);
    if (matching.length !== 1) {
      throw new GateError(`the CI history run has ${String(matching.length)} jobs named "${name}"`);
    }
    const job = matching[0];
    if (field(job, 'status') !== 'completed' || field(job, 'conclusion') !== 'success') {
      return {
        deploy: false,
        reason:
          name === 'Publish run record' && field(job, 'conclusion') === 'skipped'
            ? 'the CI history run published no new record'
            : `the CI history job "${name}" concluded ${String(field(job, 'conclusion'))}`,
      };
    }
  }
  return { deploy: true, reason: 'a run record was composed and published' };
}

/** Reads one Actions API response; GateError unless it is complete JSON. */
async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
    },
  });
  const text = await response.text();
  if (response.status !== 200 || text.length > MAX_BYTES) {
    throw new GateError(`the Actions API answered ${String(response.status)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GateError('the Actions API answer is not JSON');
  }
}

/** The whole gate; `env` and `fetchImpl` are injectable for tests. */
export async function gate(env, readEvent, fetchImpl) {
  const repository = env.GITHUB_REPOSITORY ?? '';
  if (!REPOSITORY.test(repository)) throw new GateError('GITHUB_REPOSITORY is not owner/name');
  if (env.GITHUB_REF !== 'refs/heads/main') throw new GateError('not running on main');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    return { deploy: true, reason: 'manual workflow_dispatch on main' };
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_run') {
    throw new GateError(`the event ${String(env.GITHUB_EVENT_NAME)} never deploys`);
  }
  const run = historyRun(readEvent(), repository);
  if (run.conclusion !== 'success') return decide(run.conclusion, undefined);
  const api = env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._/-]*)?$/.test(api)) {
    throw new GateError('GITHUB_API_URL is not an https URL');
  }
  const jobs = await getJson(
    `${api}/repos/${repository}/actions/runs/${String(run.id)}/attempts/${String(run.attempt)}/jobs?per_page=100`,
    env.GITHUB_TOKEN ?? '',
    fetchImpl,
  );
  return decide(run.conclusion, jobs);
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  const readEvent = () => {
    const path = process.env.GITHUB_EVENT_PATH ?? '';
    const text = readFileSync(path, 'utf8');
    if (text.length > MAX_BYTES) throw new GateError('the event file is too large');
    return JSON.parse(text);
  };
  gate(process.env, readEvent, (url, init) => globalThis.fetch(url, init))
    .then(({ deploy, reason }) => {
      console.error(`${deploy ? 'Deploying' : 'Not deploying'}: ${reason}`);
      process.stdout.write(`deploy=${String(deploy)}\nreason=${reason}\n`);
    })
    .catch((error) => {
      console.error(
        error instanceof GateError
          ? `Pages gate refused: ${error.message}`
          : `Pages gate failed: unexpected ${error instanceof Error ? error.name : 'error'}`,
      );
      process.exit(1);
    });
}
