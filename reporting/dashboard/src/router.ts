import { useSyncExternalStore } from 'react';

/**
 * Hash routing (`#/test-cases/TC-003-07?…`), so the static build works on any host without
 * server rewrites. The hash never leaves the browser.
 */

export interface Route {
  readonly path: string;
  readonly query: string;
}

function current(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
}

export function useRoute(): Route {
  const raw = useSyncExternalStore(subscribe, current, () => '/');
  const index = raw.indexOf('?');
  const path = index === -1 ? raw : raw.slice(0, index);
  return { path: path === '' ? '/' : path, query: index === -1 ? '' : raw.slice(index + 1) };
}

export function href(path: string, query = ''): string {
  return `#${path}${query === '' ? '' : `?${query}`}`;
}

/** Updates the hash; `replace` avoids a history entry per keystroke while filtering. */
export function navigate(path: string, query = '', replace = false): void {
  const target = href(path, query);
  if (target === window.location.hash) return;
  // pushState/replaceState do not fire hashchange; dispatching it makes the update synchronous.
  // Browser back/forward between these entries fires hashchange itself.
  if (replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
