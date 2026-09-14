import { Groq, APIConnectionError, BadRequestError, InternalServerError, RateLimitError } from "groq-sdk";
import { GroqToolFunction } from "../tools/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: GroqToolCall[];
}

export interface GroqToolCall {
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
  toolCalls: GroqToolCall[];
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
}

export class GroqClient {
  private client: Groq;
  private model: string;
  private temperature: number;

  constructor(apiKey: string, model: string, temperature = 0.2) {
    this.client = new Groq({ apiKey });
    this.model = model;
    this.temperature = temperature;
  }

  public setModel(model: string): void {
    this.model = model;
  }

  public getModel(): string {
    return this.model;
  }

  /** Transient failures worth retrying: the model itself glitched, not a real request error. */
  private isRetryableError(err: any): boolean {
    if (err instanceof RateLimitError) return true;
    if (err instanceof InternalServerError) return true;
    if (err instanceof APIConnectionError) return true;
    // The model streamed malformed JSON for a tool call's arguments; Groq rejects the
    // whole completion server-side. Re-sampling the same request usually produces valid JSON.
    if (err instanceof BadRequestError && /parse tool call arguments/i.test(err.message || "")) {
      return true;
    }
    return false;
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
        if (attempt > maxRetries || !this.isRetryableError(err)) {
          throw err;
        }
        callbacks.onRetry?.(attempt, maxRetries, err.message);
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
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
    });

    let fullContent = "";
    const toolCallsMap: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let finishReason = "stop";
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;

      // Handle reasoning content (e.g. DeepSeek R1 models)
      if ((delta as any)?.reasoning) {
        callbacks.onReasoning?.((delta as any).reasoning);
      }

      // Handle content tokens
      if (delta.content) {
        fullContent += delta.content;
        callbacks.onToken?.(delta.content);
      }

      // Handle tool call chunks
      if (delta.tool_calls) {
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

      // Capture usage if provided in chunk
      if ((chunk as any).usage) {
        promptTokens = (chunk as any).usage.prompt_tokens || 0;
        completionTokens = (chunk as any).usage.completion_tokens || 0;
      }
    }

    // Fallback token estimations if usage was not streamed
    if (promptTokens === 0 && completionTokens === 0) {
      const msgStr = JSON.stringify(messages);
      promptTokens = Math.ceil(msgStr.length / 4);
      completionTokens = Math.ceil(fullContent.length / 4);
    }

    const toolCalls: GroqToolCall[] = Array.from(toolCallsMap.entries())
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
    };
  }
}
