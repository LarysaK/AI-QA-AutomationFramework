import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import snapshot from 'virtual:dashboard-snapshot';

import { App } from './App';
import type { Snapshot } from './data/types';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');

// The snapshot was validated against snapshot.schema.json when the bundle was built.
createRoot(root).render(
  <StrictMode>
    <App snapshot={snapshot as Snapshot} />
  </StrictMode>,
);
