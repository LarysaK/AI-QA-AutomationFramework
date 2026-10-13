import Anthropic from '@anthropic-ai/sdk';

/**
 * The single seam between the Generator and an LLM provider. The Generator depends only on this
 * interface; tests use a fake implementation and never reach a provider.
 */

export interface ModelRequest {
  readonly model: string;
  readonly maxTokens: number;
  /** Omitted for models that do not accept the effort parameter. */
  readonly effort?: 'medium';
  readonly system: string;
  /** Approved context, then the task; sent as one user turn. */
  readonly context: string;
  readonly task: string;
  /** JSON Schema for structured output (supported subset only). */
  readonly schema: Record<string, unknown>;
}

export interface ModelResponse {
  /** The model's text output (the JSON document), concatenated across text blocks. */
  readonly text: string;
  /** For example `end_turn`, `max_tokens`, `refusal`. */
  readonly stopReason: string | null;
  /** The model that actually served the request. */
  readonly servedModel: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface ModelClient {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_MAX_TOKENS = 12_000;

/** Models known to accept `output_config.effort`; effort is omitted for any other model. */
export const EFFORT_MODELS: readonly string[] = [
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
];

/**
 * Anthropic implementation. Credentials are resolved by the SDK from the environment
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant` profile) and never handled here.
 * No transport retries, no fallback model, no regeneration.
 */
/** Client options: no transport retries (a failed call ends the run). */
export const ANTHROPIC_CLIENT_OPTIONS = { maxRetries: 0 } as const;

/** The exact Messages API parameters sent for a request. No fallback model is configured. */
export function toMessageParams(request: ModelRequest): Anthropic.MessageStreamParams {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: request.context },
          { type: 'text', text: request.task },
        ],
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: request.schema },
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    },
  };
}

export function createAnthropicModelClient(): ModelClient {
  const client = new Anthropic(ANTHROPIC_CLIENT_OPTIONS);
  return {
    async generate(request) {
      const stream = client.messages.stream(toMessageParams(request));
      const message = await stream.finalMessage();
      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return {
        text,
        stopReason: message.stop_reason,
        servedModel: message.model,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    },
  };
}
