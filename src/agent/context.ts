import { ChatMessage } from "./groq.js";
import { getSystemPrompt } from "./system_prompt.js";
import { AVAILABLE_MODELS } from "../config/config.js";

export class ConversationContext {
  private messages: ChatMessage[] = [];
  private cwd: string;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private model: string;

  constructor(cwd: string, model: string) {
    this.cwd = cwd;
    this.model = model;
    this.reset();
  }

  public reset(): void {
    this.messages = [
      {
        role: "system",
        content: getSystemPrompt(this.cwd),
      },
    ];
  }

  public setModel(model: string): void {
    this.model = model;
  }

  public getMessages(): ChatMessage[] {
    return this.messages;
  }

  public addUserMessage(content: string): void {
    this.messages.push({
      role: "user",
      content,
    });
  }

  public addAssistantMessage(content: string | null, toolCalls?: any[]): void {
    this.messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    });
  }

  public addToolMessage(toolCallId: string, output: string): void {
    this.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: output,
    });
  }

  public recordUsage(promptTokens: number, completionTokens: number): void {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
  }

  public getUsageStats(): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  } {
    const modelMeta = AVAILABLE_MODELS[this.model] || {
      inputPricePerMillion: 0.59,
      outputPricePerMillion: 0.79,
    };

    const cost =
      (this.totalPromptTokens / 1_000_000) * modelMeta.inputPricePerMillion +
      (this.totalCompletionTokens / 1_000_000) * modelMeta.outputPricePerMillion;

    return {
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
      estimatedCost: cost,
    };
  }

  /**
   * Compacts conversation history by condensing older exchanges into a summary
   */
  public compact(): boolean {
    if (this.messages.length <= 4) {
      return false;
    }

    const systemMsg = this.messages[0];
    const recentMessages = this.messages.slice(-4);
    const middleMessages = this.messages.slice(1, -4);

    let summary = "Summary of previous conversation actions and discoveries:\n";
    for (const msg of middleMessages) {
      if (msg.role === "user") {
        summary += `- User asked: ${msg.content?.substring(0, 100)}...\n`;
      } else if (msg.role === "assistant" && msg.tool_calls) {
        const calls = msg.tool_calls.map((t) => t.function.name).join(", ");
        summary += `- Assistant performed actions: ${calls}\n`;
      } else if (msg.role === "tool") {
        const preview = msg.content ? msg.content.substring(0, 60).replace(/\n/g, " ") : "";
        summary += `  └ Result: ${preview}...\n`;
      }
    }

    this.messages = [
      systemMsg,
      {
        role: "user",
        content: `[Previous conversation context has been compacted]\n${summary}`,
      },
      {
        role: "assistant",
        content: "Understood. I have the context of our previous work. How can I assist you next?",
      },
      ...recentMessages,
    ];

    return true;
  }
}
