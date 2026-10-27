import type { APIRequest, APIRequestContext } from '@playwright/test';

import type { DemoUser } from '../data/demo-users';
import { RequestFlowApi } from './requestflow-api.client';

/**
 * Separate API sessions for the users of one test. Each session is its own request context,
 * so session cookies never mix between users or leak into other tests. `dispose()` closes
 * every context opened here and belongs in a `finally` block.
 */
export class ApiSessions {
  private readonly contexts: APIRequestContext[] = [];

  constructor(
    private readonly factory: APIRequest,
    private readonly baseURL: string | undefined,
  ) {}

  /** A new context without a session; `cookie` replays a raw `Cookie` header, if given. */
  async context(cookie?: string): Promise<APIRequestContext> {
    const context = await this.factory.newContext({
      ...(this.baseURL === undefined ? {} : { baseURL: this.baseURL }),
      ...(cookie === undefined ? {} : { extraHTTPHeaders: { Cookie: cookie } }),
    });
    this.contexts.push(context);
    return context;
  }

  /** A new context without a session, as an API client. */
  async anonymous(): Promise<RequestFlowApi> {
    return new RequestFlowApi(await this.context());
  }

  /** A new context logged in as `user`. */
  async as(user: DemoUser): Promise<RequestFlowApi> {
    const api = await this.anonymous();
    await api.loginAs(user);
    return api;
  }

  async dispose(): Promise<void> {
    await Promise.all(this.contexts.splice(0).map((context) => context.dispose()));
  }
}
