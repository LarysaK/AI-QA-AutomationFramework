import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// DOM tests only (test-node/ runs in Node, without a window).
const hasDom = typeof window !== 'undefined';

// jsdom does not implement scrolling.
beforeEach(() => {
  if (!hasDom) return;
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  window.location.hash = '';
});

afterEach(async () => {
  if (!hasDom) return;
  // jsdom applies a clicked link's hash navigation as a queued task; let it finish here, so it
  // cannot land in the next test (tests await lazily loaded pages, which yields to that queue).
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanup();
});
