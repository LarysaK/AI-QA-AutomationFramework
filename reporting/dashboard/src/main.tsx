import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import history from 'virtual:ci-history';
import snapshot from 'virtual:dashboard-snapshot';

import { App } from './App';
import type { ExecutionHistory } from './data/history';
import type { Snapshot } from './data/types';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');

// Both inputs were validated when the bundle was built: the snapshot against snapshot.schema.json,
// the CI history (null when not included) by build/history-plugin.ts.
createRoot(root).render(
  <StrictMode>
    <App snapshot={snapshot as Snapshot} history={history as ExecutionHistory | null} />
  </StrictMode>,
);
