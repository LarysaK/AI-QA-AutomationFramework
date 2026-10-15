import { type ReactNode, useEffect, useRef } from 'react';

import { Layout } from './components/Layout';
import type { Snapshot } from './data/types';
import { HowToRead, NotAvailable, NotFound } from './pages/InfoPages';
import { Overview } from './pages/Overview';
import { TestCaseDetail } from './pages/TestCaseDetail';
import { TestCasesPage } from './pages/TestCasesPage';
import { TestPlanPage } from './pages/TestPlanPage';
import { type Route, useRoute } from './router';

const TITLE = 'RequestFlow QA Dashboard';

function page(snapshot: Snapshot, route: Route): { title: string; element: ReactNode } {
  const { path, query } = route;
  const detail = /^\/test-cases\/(TC-\d{3}-\d{2})$/.exec(path)?.[1];
  if (detail !== undefined) {
    return {
      title: detail,
      element: <TestCaseDetail snapshot={snapshot} id={detail} query={query} />,
    };
  }
  switch (path) {
    case '/':
    case '/overview':
      return { title: 'Overview', element: <Overview snapshot={snapshot} /> };
    case '/test-plan':
      return { title: 'Test Plan', element: <TestPlanPage snapshot={snapshot} query={query} /> };
    case '/test-cases':
      return { title: 'Test Cases', element: <TestCasesPage snapshot={snapshot} query={query} /> };
    case '/executions':
      return { title: 'Executions', element: <NotAvailable kind="executions" /> };
    case '/ai-agents':
      return { title: 'AI Agents', element: <NotAvailable kind="ai-agents" /> };
    case '/defects':
      return { title: 'Defects', element: <NotAvailable kind="defects" /> };
    case '/how-to-read':
      return { title: 'How to read this dashboard', element: <HowToRead snapshot={snapshot} /> };
    default:
      return { title: 'Page not found', element: <NotFound /> };
  }
}

export function App({ snapshot }: { snapshot: Snapshot }) {
  const route = useRoute();
  const { title, element } = page(snapshot, route);
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    document.title = `${title} · ${TITLE}`;
  }, [title]);

  // When the page changes (not when filters or the plan section change), start at the top and
  // move focus to the new page's heading, so keyboard and screen-reader users land on it.
  useEffect(() => {
    const changed = previousPath.current !== null && previousPath.current !== route.path;
    previousPath.current = route.path;
    // A route naming a plan section (?section=…) is scrolled and focused by the Test Plan page.
    if (!changed || new URLSearchParams(route.query).has('section')) return;
    window.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('#main h1')?.focus();
  }, [route.path, route.query]);

  return (
    <Layout snapshot={snapshot} path={route.path}>
      {element}
    </Layout>
  );
}
