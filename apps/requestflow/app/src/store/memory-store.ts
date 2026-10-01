import type { Request } from '../domain/types';

/**
 * In-memory application state: requests, the request ID sequence and sessions.
 * The store holds no business rules; services decide what is stored.
 */
export class MemoryStore {
  private readonly requests = new Map<string, Request>();
  private readonly sessions = new Map<string, string>();
  private sequence = 0;

  /** Readable, monotonic request IDs: req-0001, req-0002, ... */
  nextRequestId(): string {
    this.sequence += 1;
    return `req-${String(this.sequence).padStart(4, '0')}`;
  }

  getRequest(id: string): Request | undefined {
    return this.requests.get(id);
  }

  saveRequest(request: Request): void {
    this.requests.set(request.id, request);
  }

  /** All requests in creation order. */
  listRequests(): Request[] {
    return [...this.requests.values()];
  }

  createSession(sessionId: string, userId: string): void {
    this.sessions.set(sessionId, userId);
  }

  getSessionUserId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Clears all requests and sessions and restarts the ID sequence. Demo users are constant. */
  reset(): void {
    this.requests.clear();
    this.sessions.clear();
    this.sequence = 0;
  }
}
