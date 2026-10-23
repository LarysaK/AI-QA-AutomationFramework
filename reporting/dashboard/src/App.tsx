import { Component, lazy, type ReactNode, Suspense, useEffect, useRef } from 'react';

import { Layout } from './components/Layout';
import type { VerifiedAgentLayer } from './data/agents';
import { type DefectSource, NOT_CONNECTED } from './data/defects';
import type { ExecutionHistory } from './data/history';
import type { Snapshot } from './data/types';
import { HowToRead, NotFound } from './pages/InfoPages';
import { Overview } from './pages/Overview';
import { href, type Route, useRoute } from './router';

/*
 * Route-level code splitting: the Overview and the small information pages are in the entry
 * chunk; the pages that need the Markdown renderer (test plan, test cases), the execution views
 * and the agent and defect views are separate same-origin chunks, loaded when first visited. They
 * are static files of this build, allowed by script-src 'self'; nothing is fetched from elsewhere.
 */
const TestPlanPage = lazy(() =>
  import('./pages/TestPlanPage').then((m) => ({ default: m.TestPlanPage })),
);
const TestCasesPage = lazy(() =>
  import('./pages/TestCasesPage').then((m) => ({ default: m.TestCasesPage })),
);
const TestCaseDetail = lazy(() =>
  import('./pages/TestCaseDetail').then((m) => ({ default: m.TestCaseDetail })),
);
const ExecutionsPage = lazy(() =>
  import('./pages/ExecutionsPage').then((m) => ({ default: m.ExecutionsPage })),
);
const ExecutionDetail = lazy(() =>
  import('./pages/ExecutionsPage').then((m) => ({ default: m.ExecutionDetail })),
);
const AgentsPage = lazy(() =>
  import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })),
);
const DefectsPage = lazy(() =>
  import('./pages/DefectsPage').then((m) => ({ default: m.DefectsPage })),
);

const TITLE = 'RequestFlow QA Dashboard';

interface Inputs {
  readonly snapshot: Snapshot;
  readonly history: ExecutionHistory | null;
  readonly agents: VerifiedAgentLayer | null;
  readonly defects: DefectSource;
}

function page(
  { snapshot, history, agents, defects }: Inputs,
  route: Route,
): { title: string; element: ReactNode } {
  const { path, query } = route;
  const run = /^\/executions\/([1-9][0-9]*-[1-9][0-9]*)$/.exec(path)?.[1];
  if (run !== undefined) {
    return {
      title: `Run ${run}`,
      element: <ExecutionDetail history={history} snapshot={snapshot} runKey={run} />,
    };
  }
  const detail = /^\/test-cases\/(TC-\d{3}-\d{2})$/.exec(path)?.[1];
  if (detail !== undefined) {
    return {
      title: detail,
      element: <TestCaseDetail snapshot={snapshot} history={history} id={detail} query={query} />,
    };
  }
  switch (path) {
    case '/':
    case '/overview':
      return { title: 'Overview', element: <Overview snapshot={snapshot} history={history} /> };
    case '/test-plan':
      return { title: 'Test Plan', element: <TestPlanPage snapshot={snapshot} query={query} /> };
    case '/test-cases':
      return { title: 'Test Cases', element: <TestCasesPage snapshot={snapshot} query={query} /> };
    case '/executions':
      return { title: 'Executions', element: <ExecutionsPage history={history} /> };
    case '/ai-agents':
      return { title: 'AI Agents', element: <AgentsPage agents={agents} history={history} /> };
    case '/defects':
      return {
        title: 'Defects',
        element: <DefectsPage snapshot={snapshot} defects={defects} agents={agents} />,
      };
    case '/how-to-read':
      return {
        title: 'How to read this dashboard',
        element: <HowToRead snapshot={snapshot} history={history} agents={agents} />,
      };
    default:
      return { title: 'Page not found', element: <NotFound /> };
  }
}

/** Shown while a page's code loads; announced politely, never as an error. */
function PageLoading() {
  return (
    <p className="page-loading" role="status">
      Loading…
    </p>
  );
}

/** A page whose code could not be loaded (for example after a new deployment). */
export class PageLoadError extends Component<
  { path: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  // Navigating away clears the error, so a failed page does not keep the next page from loading.
  // (Not keyed by path: remounting would also reset the focus handling below.)
  override componentDidUpdate(previous: { path: string }) {
    if (previous.path !== this.props.path && this.state.failed) this.setState({ failed: false });
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <header className="page-header">
        <p className="eyebrow">Not loaded</p>
        <h1 tabIndex={-1}>This page could not be loaded</h1>
        <div className="page-lede">
          <p>
            Its code did not load, possibly because the dashboard was updated. Reload the page to
            try again, or <a href={href('/')}>go to the overview</a>.
          </p>
        </div>
      </header>
    );
  }
}

/**
 * When the page changes (not when filters or the plan section change), start at the top and move
 * focus to the new page's heading, so keyboard and screen-reader users land on it. Rendered inside
 * the Suspense boundary, after the page, so it runs only once the page itself has rendered.
 */
function RouteFocus({ route }: { route: Route }) {
  // Kept across route changes: this component stays at the same place in the tree.
  const previousPath = useRef<string | null>(null);
  useEffect(() => {
    const changed = previousPath.current !== null && previousPath.current !== route.path;
    previousPath.current = route.path;
    // A route naming a plan section (?section=…) is scrolled and focused by the Test Plan page.
    if (!changed || new URLSearchParams(route.query).has('section')) return;
    window.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('#main h1')?.focus();
  }, [route.path, route.query]);
  return null;
}

export function App({
  snapshot,
  history = null,
  agents = null,
  defects = NOT_CONNECTED,
}: {
  snapshot: Snapshot;
  history?: ExecutionHistory | null;
  agents?: VerifiedAgentLayer | null;
  defects?: DefectSource;
}) {
  const route = useRoute();
  const { title, element } = page({ snapshot, history, agents, defects }, route);

  useEffect(() => {
    document.title = `${title} · ${TITLE}`;
  }, [title]);

  return (
    <Layout snapshot={snapshot} path={route.path}>
      <PageLoadError path={route.path}>
        <Suspense fallback={<PageLoading />}>
          {element}
          <RouteFocus route={route} />
        </Suspense>
      </PageLoadError>
    </Layout>
  );
}
