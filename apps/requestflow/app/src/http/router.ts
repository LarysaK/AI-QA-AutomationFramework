import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
}

export type Handler = (ctx: RouteContext) => Promise<void> | void;

export interface RouteMatch {
  readonly handler: Handler;
  readonly params: Readonly<Record<string, string>>;
}

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
}

/** Minimal method + path router. Patterns use `:name` segments, e.g. `/api/requests/:id`. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }

  match(method: string, pathname: string): RouteMatch | undefined {
    const segments = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params) return { handler: route.handler, params };
    }
    return undefined;
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, expected] of pattern.entries()) {
    const segment = actual[index];
    if (segment === undefined) return undefined;
    if (expected.startsWith(':')) {
      const value = safeDecode(segment);
      if (value === undefined) return undefined;
      params[expected.slice(1)] = value;
    } else if (expected !== segment) {
      return undefined;
    }
  }
  return params;
}

function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
