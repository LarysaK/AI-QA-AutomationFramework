// Types of pages-gate.mjs (dependency-free JavaScript, run by plain Node.js in the workflow).

export declare const HISTORY_WORKFLOW: string;
export declare const HISTORY_WORKFLOW_PATH: string;
export declare const REQUIRED_JOBS: readonly string[];
export declare class GateError extends Error {}

export interface Decision {
  readonly deploy: boolean;
  readonly reason: string;
}

export type FetchLike = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export declare function historyRun(
  event: unknown,
  repository: string,
): { readonly id: number; readonly attempt: number; readonly conclusion: unknown };

export declare function decide(conclusion: unknown, jobsResponse: unknown): Decision;

export declare function gate(
  env: Readonly<Record<string, string | undefined>>,
  readEvent: () => unknown,
  fetchImpl: FetchLike,
): Promise<Decision>;
