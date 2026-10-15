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

afterEach(() => {
  if (hasDom) cleanup();
});
