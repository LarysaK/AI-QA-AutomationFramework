import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import agents from 'virtual:agent-layer';
import history from 'virtual:ci-history';
import snapshot from 'virtual:dashboard-snapshot';

import { App } from './App';
import type { VerifiedAgentLayer } from './data/agents';
import type { ExecutionHistory } from './data/history';
import type { Snapshot } from './data/types';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');

// Every input was validated when the bundle was built: the snapshot against snapshot.schema.json,
// the CI history (null when not included) by build/history-plugin.ts, and the agent layer facts
// against the committed files by build/agent-layer-plugin.ts. No defect source is connected.
createRoot(root).render(
  <StrictMode>
    <App
      snapshot={snapshot as Snapshot}
      history={history as ExecutionHistory | null}
      agents={agents as VerifiedAgentLayer}
    />
  </StrictMode>,
);
