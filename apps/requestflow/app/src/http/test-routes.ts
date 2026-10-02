import type { MemoryStore } from '../store/memory-store';
import { sendNoContent } from './responses';
import type { Router } from './router';

/**
 * Test-only hooks. Registered only when REQUESTFLOW_TEST_HOOKS=1; otherwise these
 * routes do not exist. They are infrastructure for automated tests, not part of the
 * RequestFlow API, and contain no business logic.
 */
export function registerTestRoutes(router: Router, store: MemoryStore): void {
  router.post('/__test/reset', ({ res }) => {
    store.reset();
    sendNoContent(res);
  });
}
