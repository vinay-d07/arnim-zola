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

  /** Rough token estimate (chars/4) of the messages that would actually be sent on the next turn. */
  public estimateCurrentTokens(): number {
    return Math.ceil(JSON.stringify(this.messages).length / 4);
  }

  public getContextWindow(): number {
    return AVAILABLE_MODELS[this.model]?.contextWindow || 64000;
  }

  /** True once the live message history is eating too much of the model's context window. */
  public shouldAutoCompact(threshold = 0.75): boolean {
    if (this.messages.length <= 4) return false;
    return this.estimateCurrentTokens() >= this.getContextWindow() * threshold;
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
   * Compacts conversation history by condensing older exchanges into a summary.
   * Keeps a token-budgeted window of recent messages verbatim, snapped back to the
   * nearest user-turn boundary so an assistant tool_call is never split from its tool result.
   */
  public compact(): boolean {
    if (this.messages.length <= 4) {
      return false;
    }

    const systemMsg = this.messages[0];
    const recentBudgetTokens = Math.max(500, Math.floor(this.getContextWindow() * 0.15));

    let boundary = this.messages.length;
    let tokens = 0;
    while (boundary > 1) {
      const msgTokens = Math.ceil(JSON.stringify(this.messages[boundary - 1]).length / 4);
      if (tokens > 0 && tokens + msgTokens > recentBudgetTokens) break;
      tokens += msgTokens;
      boundary--;
    }

    // Snap forward to the next user-turn start so we never split a tool_call from its tool result
    while (boundary < this.messages.length && this.messages[boundary].role !== "user") {
      boundary++;
    }

    if (boundary <= 1 || boundary >= this.messages.length) {
      return false; // nothing meaningful to compact
    }

    const recentMessages = this.messages.slice(boundary);
    const middleMessages = this.messages.slice(1, boundary);

    // Narrative summary of what was asked/done (lossy, but cheap).
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

    // File inventory: the one thing that must NOT get lost to compaction, since forgetting which
    // files already exist (and what was done to them) is what causes broken cross-file references
    // in longer app-building sessions. Kept as a compact list, not full content.
    const filesTouched = new Map<string, string>();
    for (const msg of middleMessages) {
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      for (const tc of msg.tool_calls) {
        if (tc.function.name !== "write_file" && tc.function.name !== "edit_file") continue;
        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          if (typeof args.file_path === "string" && args.file_path) {
            filesTouched.set(
              args.file_path,
              tc.function.name === "write_file" ? "created/overwritten" : "edited"
            );
          }
        } catch {
          // Ignore malformed tool-call arguments; nothing to record for this call.
        }
      }
    }

    if (filesTouched.size > 0) {
      summary += "\nFiles created or modified so far (re-view with view_file before editing again if you need exact current contents):\n";
      for (const [file, action] of filesTouched) {
        summary += `  - ${file} (${action})\n`;
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
