import { type ReactNode, useState } from 'react';

import { shortSha } from '../data/derive';
import type { Snapshot } from '../data/types';
import { href } from '../router';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly unavailable?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: 'Overview' },
  { path: '/test-plan', label: 'Test Plan' },
  { path: '/test-cases', label: 'Test Cases' },
  { path: '/executions', label: 'Executions', unavailable: true },
  { path: '/ai-agents', label: 'AI Agents', unavailable: true },
  { path: '/defects', label: 'Defects', unavailable: true },
  { path: '/how-to-read', label: 'How to read this dashboard' },
];

function isActive(item: NavItem, path: string): boolean {
  return item.path === '/' ? path === '/' : path === item.path || path.startsWith(`${item.path}/`);
}

export function Layout({
  snapshot,
  path,
  children,
}: {
  snapshot: Snapshot;
  path: string;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const available = NAV_ITEMS.filter(
    (item) => item.unavailable !== true && item.path !== '/how-to-read',
  );
  const unavailable = NAV_ITEMS.filter((item) => item.unavailable === true);
  const help = NAV_ITEMS.filter((item) => item.path === '/how-to-read');

  const link = (item: NavItem) => (
    <li key={item.path}>
      <a
        className="nav-link"
        href={href(item.path)}
        aria-current={isActive(item, path) ? 'page' : undefined}
        onClick={() => {
          setMenuOpen(false);
        }}
      >
        <span>{item.label}</span>
        {item.unavailable === true && <span className="nav-tag">Not connected</span>}
      </a>
    </li>
  );

  return (
    <div className="shell">
      {/* The hash is the route, so the skip link moves focus itself instead of changing it. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href={href('/')}>
          <span className="brand-mark" aria-hidden="true">
            QA
          </span>
          <span className="brand-text">
            <span className="brand-name">RequestFlow QA Dashboard</span>
            <span className="brand-sub">AI-assisted QA automation portfolio</span>
          </span>
        </a>
        <button
          type="button"
          className="menu-button"
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          onClick={() => {
            setMenuOpen((open) => !open);
          }}
        >
          {menuOpen ? 'Close menu' : 'Menu'}
        </button>
      </header>

      <nav
        id="primary-navigation"
        className={`sidebar${menuOpen ? ' sidebar-open' : ''}`}
        aria-label="Primary"
      >
        <ul className="nav-list">{available.map(link)}</ul>
        <p className="nav-heading" id="nav-unavailable">
          Not available yet
        </p>
        <ul className="nav-list" aria-labelledby="nav-unavailable">
          {unavailable.map(link)}
        </ul>
        <ul className="nav-list nav-help">{help.map(link)}</ul>
        <p className="nav-provenance">
          Snapshot of commit <code>{shortSha(snapshot.source.commit)}</code>
          <br />
          Read-only · no backend
        </p>
      </nav>

      <main id="main" className="main" tabIndex={-1}>
        {children}
        <footer className="footer">
          <p>
            Built from the approved{' '}
            {snapshot.source.documents.map((document, index) => (
              <span key={document.path}>
                {index > 0 && ' and '}
                <code>{document.path}</code>
              </span>
            ))}{' '}
            and the committed Playwright tests at commit{' '}
            <code>{shortSha(snapshot.source.commit)}</code> (Playwright{' '}
            {snapshot.source.discovery.playwrightVersion}). Snapshot schema {snapshot.schemaVersion}
            .
          </p>
        </footer>
      </main>
    </div>
  );
}
