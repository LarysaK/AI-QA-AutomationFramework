import { Fragment } from 'react';

import { Badge, Callout, Card, PageHeader, Stat } from '../components/ui';
import {
  absentPaths,
  type Component,
  evidencePaths,
  type Fact,
  type GateId,
  type VerifiedAgentLayer,
} from '../data/agents';
import { shortSha } from '../data/derive';
import {
  type ExecutionHistory,
  formatInstant,
  type RunRecord,
  runPath,
  SUITES,
} from '../data/history';
import { href } from '../router';

/** Text with `backtick` spans, as written in the Agent Standard's tables, without Markdown. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split('`')
        .map((part, index) =>
          index % 2 === 1 ? (
            <code key={index}>{part}</code>
          ) : (
            <Fragment key={index}>{part}</Fragment>
          ),
        )}
    </>
  );
}

/** The committed files a statement was checked against. */
function Sources({ fact }: { fact: Fact }) {
  const paths = [...new Set(fact.evidence.map((e) => e.path))];
  return (
    <span className="cell-note">
      Source{paths.length === 1 ? '' : 's'}:{' '}
      {paths.map((path, index) => (
        <Fragment key={path}>
          {index > 0 && ', '}
          <code>{path}</code>
        </Fragment>
      ))}
    </span>
  );
}

/** "A", "A and B", "A, B and C". */
function naturalList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

const STATUS_LABEL: Readonly<Record<Component['status'], string>> = {
  implemented: 'Implemented',
  'specified-only': 'Specified only',
};

/** The newest published run that reported the agent suite, if CI history is included. */
function latestAgentSuite(history: ExecutionHistory | null) {
  for (const record of history?.records ?? []) {
    const suite = record.suites.find((s) => s.id === 'agents');
    if (suite !== undefined) return { record, suite };
  }
  return undefined;
}

function AgentSuiteResult({ history }: { history: ExecutionHistory | null }) {
  if (history === null) {
    return (
      <p>
        CI execution history is not included in this build, so no published result of the agent
        suite is shown.
      </p>
    );
  }
  const latest = latestAgentSuite(history);
  if (latest === undefined) {
    return <p>No published CI run has reported the agent suite yet.</p>;
  }
  const { record, suite }: { record: RunRecord; suite: RunRecord['suites'][number] } = latest;
  const counts =
    suite.counts?.passed !== null &&
    suite.counts?.passed !== undefined &&
    suite.counts.total !== null
      ? `${String(suite.counts.passed)} of ${String(suite.counts.total)} tests passed`
      : 'no test counts reported';
  return (
    <p>
      Latest published result:{' '}
      <a href={href(runPath(record))}>CI run #{String(record.run.number)}</a> (
      {formatInstant(record.timestamps.jobCompletedAt)}), {SUITES.agents.label}:{' '}
      <strong>{suite.state}</strong>, {counts}. These are automated tests with a fake model, not AI
      model runs.
    </p>
  );
}

const GATE_TONE = (id: GateId): 'warning' | 'outline' => (id === 'H7' ? 'warning' : 'outline');

function NotIncluded() {
  return (
    <>
      <PageHeader eyebrow="Agent layer" title="AI Agents" />
      <Card>
        <Callout title="Agent layer facts are not included in this build" tone="empty">
          <p>
            This build was made without the checked agent layer facts, so nothing about the agents
            is shown.
          </p>
        </Callout>
      </Card>
    </>
  );
}

export function AgentsPage({
  agents,
  history = null,
}: {
  agents: VerifiedAgentLayer | null;
  history?: ExecutionHistory | null;
}) {
  if (agents === null) return <NotIncluded />;
  const { layer, commit } = agents;
  // Counts AI agents only (the standard's LLM-backed roles); the Validator is deterministic code
  // and is never counted among them.
  const ai = layer.components.filter((c) => c.kind === 'AI agent');
  const implementedAi = ai.filter((c) => c.status === 'implemented');
  const specifiedAi = ai.filter((c) => c.status === 'specified-only');
  const validators = layer.components.filter((c) => c.kind === 'Deterministic validator');
  const names = (list: readonly Component[]) =>
    naturalList(list.map((c) => c.name.replace(/ agent$/, '')));
  const agentCount =
    specifiedAi.length === 0
      ? `All ${String(ai.length)} AI agents defined by the Agent Standard are implemented: ${names(implementedAi)}.`
      : `Of the ${String(ai.length)} AI agents defined by the Agent Standard, implemented: ${names(implementedAi)}; specified only: ${names(specifiedAi)}.`;
  const executing = layer.guards.filter((g) => g.executionCapable);
  const m = layer.modelExecution;

  return (
    <>
      <PageHeader eyebrow="Agent layer" title="AI Agents">
        <p>
          What the repository’s AI agent layer is, what is implemented and tested, and which human
          approvals it requires. {layer.principle.text}
        </p>
        <p>
          Every statement here was checked against the committed files of commit{' '}
          <code>{shortSha(commit)}</code> when this dashboard was built. No agent activity is shown,
          because the repository records none.
        </p>
      </PageHeader>

      <Callout title="Real AI model execution is not enabled">
        <ul className="plain-list">
          <li>
            <strong>H7 is closed.</strong> {m.h7.text}
          </li>
          <li>{m.ci.text}</li>
          <li>{m.liveRuns.text}</li>
        </ul>
      </Callout>

      <dl className="stats" aria-label="Agent layer status">
        <Stat
          label="AI agents implemented"
          value={`${String(implementedAi.length)} of ${String(ai.length)}`}
          detail={`${agentCount} The ${names(validators)} is deterministic code, not an AI agent, and is not counted.`}
        />
        <Stat
          label="Validation guards"
          value={String(layer.guards.length)}
          detail={`${String(executing.length)} run proposed code, only after H7`}
        />
        <Stat
          label="Execution authorization (H7)"
          value="Closed"
          detail="None in effect or stored"
        />
        <Stat
          label="Live AI model runs recorded"
          value="None"
          detail="Agent tests use a fake model"
        />
      </dl>

      <Card title="Code, tests, live AI runs and H7 are different things">
        <dl className="definitions">
          <div>
            <dt>Implemented agent code</dt>
            <dd>
              {naturalList(
                layer.components.filter((c) => c.status === 'implemented').map((c) => c.name),
              )}{' '}
              are implemented. {m.liveModeInCode.text} <Sources fact={m.liveModeInCode} />
            </dd>
          </div>
          <div>
            <dt>Automated tests with a fake model</dt>
            <dd>
              {m.fakeModelTests.text} <Sources fact={m.fakeModelTests} />
              <AgentSuiteResult history={history} />
            </dd>
          </div>
          <div>
            <dt>Live AI model executions</dt>
            <dd>
              <strong>None recorded.</strong> {m.liveRuns.text} <Sources fact={m.liveRuns} />
            </dd>
          </div>
          <div>
            <dt>Historical offline demonstration (not a live run)</dt>
            <dd>
              {m.offlineDemo.text} <Sources fact={m.offlineDemo} />
            </dd>
          </div>
          <div>
            <dt>Current H7 authorization</dt>
            <dd>
              <strong>None; H7 is closed.</strong> {m.h7.text} <Sources fact={m.h7} />
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="AI agents">
        <p className="card-intro">
          {layer.agentRoles.text} {layer.retired.text}
        </p>
        <div className="table-scroll" role="region" aria-label="AI agents" tabIndex={0}>
          <table className="data-table agent-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Status</th>
                <th scope="col">Purpose</th>
                <th scope="col">Code and tests</th>
                <th scope="col">Human approval</th>
              </tr>
            </thead>
            <tbody>
              {ai.map((c) => (
                <tr key={c.id}>
                  <th scope="row">
                    {c.name}
                    <span className="cell-note">{c.kind}</span>
                  </th>
                  <td>
                    <Badge tone={c.status === 'implemented' ? 'neutral' : 'outline'}>
                      {STATUS_LABEL[c.status]}
                    </Badge>
                  </td>
                  <td className="prose">{c.purpose.text}</td>
                  <td className="prose">
                    {c.code.text}
                    <span className="cell-note">Tests: {c.tests.text}</span>
                  </td>
                  <td className="prose">{c.approval.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ai
          .filter((c) => c.responsibilities.length > 0)
          .map((c) => (
            <section key={c.id} className="agent-duties">
              <h3 className="subheading">{c.name}: responsibilities</h3>
              <ul className="plain-list">
                {c.responsibilities.map((r) => (
                  <li key={r.text}>{r.text}</li>
                ))}
              </ul>
            </section>
          ))}
      </Card>

      {validators.map((c) => (
        <Card key={c.id} title={`${c.name}: deterministic safety component`}>
          <p className="card-intro">{layer.validatorRole.text}</p>
          <dl className="definitions" aria-label={c.name}>
            <div>
              <dt>Status</dt>
              <dd>
                <Badge tone="neutral">{STATUS_LABEL[c.status]}</Badge> {c.kind}
              </dd>
            </div>
            <div>
              <dt>Purpose</dt>
              <dd>{c.purpose.text}</dd>
            </div>
            <div>
              <dt>Code and tests</dt>
              <dd>
                {c.code.text}
                <span className="cell-note">Tests: {c.tests.text}</span>
              </dd>
            </div>
            <div>
              <dt>Human approval</dt>
              <dd>{c.approval.text}</dd>
            </div>
          </dl>
          <section className="agent-duties">
            <h3 className="subheading">{c.name}: responsibilities</h3>
            <ul className="plain-list">
              {c.responsibilities.map((r) => (
                <li key={r.text}>{r.text}</li>
              ))}
            </ul>
          </section>
        </Card>
      ))}

      <Card title="Validation guards">
        <p className="card-intro">
          The validator runs these guards in this order and stops at the first failure. The two
          execution-capable guards import or run proposed code, so they run only after H7.
        </p>
        <div className="table-scroll" role="region" aria-label="Validation guards" tabIndex={0}>
          <table className="data-table agent-table">
            <thead>
              <tr>
                <th scope="col">Guard</th>
                <th scope="col">Checks (Agent Standard)</th>
                <th scope="col">Runs proposed code</th>
                <th scope="col">Automated tests</th>
              </tr>
            </thead>
            <tbody>
              {layer.guards.map((g) => (
                <tr key={g.id}>
                  <th scope="row">
                    <code>{g.id}</code>
                  </th>
                  <td className="prose">
                    <Inline text={g.checks} />
                  </td>
                  <td>
                    {g.executionCapable ? <Badge tone="warning">Yes — H7 required</Badge> : 'No'}
                  </td>
                  <td>
                    <code>{g.tests.text}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Human approval gates">
        <p className="card-intro">
          The Agent Standard’s seven gates, and how each one stands in this repository. The
          repository keeps no record of approval or authorization events.
        </p>
        <div className="table-scroll" role="region" aria-label="Human approval gates" tabIndex={0}>
          <table className="data-table agent-table">
            <thead>
              <tr>
                <th scope="col">Gate</th>
                <th scope="col">Requires human approval</th>
                <th scope="col">In this repository</th>
              </tr>
            </thead>
            <tbody>
              {layer.gates.map((g) => (
                <tr key={g.id}>
                  <th scope="row">
                    <Badge tone={GATE_TONE(g.id)}>{g.id}</Badge>
                  </th>
                  <td className="prose">{g.requires}</td>
                  <td className="prose">{g.here.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Not recorded in this repository">
        <p className="card-intro">
          The following are not shown because they do not exist as records. Nothing is estimated or
          filled in.
        </p>
        <ul className="plain-list">
          {layer.notRecorded.map((fact) => (
            <li key={fact.text}>
              {fact.text} <Sources fact={fact} />
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Evidence">
        <p>
          {layer.standard.text} Each statement on this page cites committed files. When the
          dashboard is built, every quotation is checked against these files at commit{' '}
          <code>{commit}</code>, retired components are checked to have no committed files, and the
          guard and gate tables are checked to be the standard’s complete tables. If any statement
          no longer holds, the build fails.
        </p>
        <h3 className="subheading">Committed files quoted or checked</h3>
        <ul className="plain-list evidence-list">
          {evidencePaths(layer).map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
        <h3 className="subheading">Paths checked to have no committed files</h3>
        <ul
          className="plain-list evidence-list"
          aria-label="Paths checked to have no committed files"
        >
          {absentPaths(layer).map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
        <p>
          <a href={href('/how-to-read')}>How to read this dashboard</a>
        </p>
      </Card>
    </>
  );
}
