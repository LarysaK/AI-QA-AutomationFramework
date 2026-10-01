import { randomUUID } from 'node:crypto';

import { unauthenticated, validationError } from '../domain/errors';
import type { User } from '../domain/types';
import { findDemoUser } from '../domain/users';
import { validateLoginPayload } from '../domain/validation';
import type { MemoryStore } from '../store/memory-store';

export interface LoginResult {
  readonly sessionId: string;
  readonly user: User;
}

/** Demo authentication (REQ-010). No passwords; sessions live in the store. */
export class AuthService {
  constructor(
    private readonly store: MemoryStore,
    private readonly generateSessionId: () => string = randomUUID,
  ) {}

  login(payload: unknown): LoginResult {
    const userId = validateLoginPayload(payload);
    const user = findDemoUser(userId);
    // Not defined by Requirements v1.2; minimal implementation choice, not a frozen rule.
    if (!user) throw validationError([{ field: 'userId', message: 'is not a demo user' }]);

    const sessionId = this.generateSessionId();
    this.store.createSession(sessionId, user.id);
    return { sessionId, user };
  }

  /**
   * Invalidates the session. Logging out without a valid session is a no-op
   * (not defined by Requirements v1.2; minimal implementation choice).
   */
  logout(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.store.deleteSession(sessionId);
  }

  /** Resolves the session to its user, or throws 401 UNAUTHENTICATED. */
  authenticate(sessionId: string | undefined): User {
    const userId = sessionId === undefined ? undefined : this.store.getSessionUserId(sessionId);
    const user = userId === undefined ? undefined : findDemoUser(userId);
    if (!user) throw unauthenticated();
    return user;
  }
}
