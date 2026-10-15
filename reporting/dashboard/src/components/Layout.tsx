import { type ReactNode, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

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

/** Matches the CSS breakpoint above which the sidebar is always shown and the menu button hidden. */
const DESKTOP = '(min-width: 961px)';

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
  const menuButton = useRef<HTMLButtonElement>(null);

  // While the mobile menu is open, Escape closes it and returns focus to the menu button.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Widening the window to the desktop layout closes the menu, so the page is never left inert.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const desktop = window.matchMedia(DESKTOP);
    const onChange = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    desktop.addEventListener('change', onChange);
    return () => {
      desktop.removeEventListener('change', onChange);
    };
  }, []);

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
          if (!menuOpen) return;
          // Close synchronously, so the page is no longer inert when focus moves to it.
          flushSync(() => {
            setMenuOpen(false);
          });
          // Choosing the current page does not change the route; focus its heading instead of
          // leaving it on a link that is now hidden.
          if (
            href(item.path) === window.location.hash ||
            (item.path === '/' && window.location.hash === '')
          ) {
            document.querySelector<HTMLElement>('#main h1')?.focus();
          }
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
        inert={menuOpen}
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href={href('/')} inert={menuOpen}>
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
          ref={menuButton}
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

      {/* Background content cannot be reached while the mobile menu covers it. */}
      <main id="main" className="main" tabIndex={-1} inert={menuOpen}>
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
