import OpenAI, { APIConnectionError, APIError, BadRequestError, InternalServerError, RateLimitError } from "openai";
import { GroqToolFunction } from "../tools/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onReasoning?: (reasoningToken: string) => void;
  onToolCallStart?: (index: number, name: string) => void;
  onRetry?: (attempt: number, maxAttempts: number, reason: string) => void;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  /** False when the provider didn't stream a usage block and the token counts are a chars/4 guess. */
  usageReported: boolean;
}

/** 413 isn't retryable by resending the same payload — the caller needs to shrink the request (compact context) first. */
export function isPayloadTooLargeError(err: any): boolean {
  return err?.status === 413;
}

/** Velona returns 402 when the prepaid wallet can't cover the request; retrying won't help. */
export function isInsufficientCreditsError(err: any): boolean {
  return err?.status === 402;
}

/**
 * Thin streaming client over any OpenAI-compatible chat-completions endpoint (Velona, Groq, ...).
 * The provider is selected purely by baseURL + key, so nothing below is provider-specific.
 */
export class LLMClient {
  private client: OpenAI;
  private model: string;
  private temperature: number;

  constructor(apiKey: string, baseURL: string, model: string, temperature = 0.2) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
    this.temperature = temperature;
  }

  public setModel(model: string): void {
    this.model = model;
  }

  public getModel(): string {
    return this.model;
  }

  /** Transient failures worth retrying: the model or upstream glitched, not a real request error. */
  private isRetryableError(err: any): boolean {
    if (err instanceof RateLimitError) return true;
    // Covers Velona's 502 UPSTREAM_ERROR / 504 UPSTREAM_TIMEOUT as well as plain 500s.
    if (err instanceof InternalServerError) return true;
    if (err instanceof APIConnectionError) return true;
    // The model streamed malformed JSON for a tool call's arguments and the provider rejected the
    // whole completion server-side. Re-sampling the same request usually produces valid JSON.
    if (err instanceof BadRequestError && /parse tool call arguments/i.test(err.message || "")) {
      return true;
    }
    return false;
  }

  /**
   * How long to wait before retrying. Rate limits reset on their own schedule, so we honor the
   * server's Retry-After header when present instead of guessing (both Groq and Velona send it).
   */
  private getRetryDelayMs(err: any, attempt: number): number {
    if (err instanceof RateLimitError) {
      const retryAfterHeader = (err as APIError).headers?.get?.("retry-after");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
        return Math.min(retryAfterSeconds * 1000, 60000);
      }
      return Math.min(2000 * Math.pow(2, attempt - 1), 30000);
    }
    return Math.min(500 * attempt, 5000);
  }

  public async streamCompletion(
    messages: ChatMessage[],
    tools: GroqToolFunction[],
    callbacks: StreamCallbacks = {},
    maxRetries = 2
  ): Promise<CompletionResult> {
    let attempt = 0;
    while (true) {
      try {
        return await this.runCompletion(messages, tools, callbacks);
      } catch (err: any) {
        attempt++;
        // Rate limits clear on their own schedule rather than being a one-off glitch, so give them
        // more attempts than a generic transient error before giving up.
        const effectiveMaxRetries = err instanceof RateLimitError ? Math.max(maxRetries, 5) : maxRetries;
        if (attempt > effectiveMaxRetries || !this.isRetryableError(err)) {
          throw err;
        }
        const delayMs = this.getRetryDelayMs(err, attempt);
        callbacks.onRetry?.(attempt, effectiveMaxRetries, err.message);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async runCompletion(
    messages: ChatMessage[],
    tools: GroqToolFunction[],
    callbacks: StreamCallbacks
  ): Promise<CompletionResult> {
    const formattedTools = tools.length > 0 ? (tools as any) : undefined;

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
      tools: formattedTools,
      tool_choice: formattedTools ? "auto" : undefined,
      temperature: this.temperature,
      stream: true,
      // Ask for real token counts in the final chunk; context budgeting relies on them.
      stream_options: { include_usage: true },
    });

    let fullContent = "";
    const toolCallsMap: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let finishReason = "stop";
    let promptTokens = 0;
    let completionTokens = 0;
    let usageReported = false;

    for await (const chunk of stream) {
      // The usage chunk arrives with an empty `choices` array, so read it before skipping choiceless chunks.
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || 0;
        completionTokens = chunk.usage.completion_tokens || 0;
        usageReported = true;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta as any;

      // Reasoning tokens: OpenRouter-backed gateways use `reasoning`, DeepSeek's native API uses `reasoning_content`.
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        callbacks.onReasoning?.(reasoning);
      }

      if (delta?.content) {
        fullContent += delta.content;
        callbacks.onToken?.(delta.content);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, {
              id: tc.id || `call_${Date.now()}_${idx}`,
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            });
            if (tc.function?.name) {
              callbacks.onToolCallStart?.(idx, tc.function.name);
            }
          } else {
            const existing = toolCallsMap.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }
        }
      }
    }

    // Fallback token estimations if usage was not streamed
    if (!usageReported) {
      const msgStr = JSON.stringify(messages);
      promptTokens = Math.ceil(msgStr.length / 4);
      completionTokens = Math.ceil(fullContent.length / 4);
    }

    const toolCalls: ToolCall[] = Array.from(toolCallsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([_, tc]) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

    return {
      content: fullContent,
      toolCalls,
      finishReason,
      promptTokens,
      completionTokens,
      usageReported,
    };
  }
}
