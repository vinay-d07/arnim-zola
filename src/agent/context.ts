import { ChatMessage } from "./llm.js";
import { getSystemPrompt } from "./system_prompt.js";
import { AVAILABLE_MODELS, ModelOption } from "../config/config.js";

/**
 * Hard cap on any single tool result entering context, regardless of what the tool itself already
 * truncated to. Scales with the model's working budget (~5% of it, at ~4 chars/token) so large-window
 * models can see whole files, while one runaway command still can't eat the budget in a single turn.
 */
function maxToolOutputChars(budgetTokens: number): number {
  return Math.min(40000, Math.max(6000, Math.floor(budgetTokens * 0.05 * 4)));
}

/**
 * Used when the model isn't in AVAILABLE_MODELS. Providers enforce per-request payload caps that can
 * sit far below a model's advertised window, so for an unknown model we stay conservative to avoid 413s.
 */
const UNKNOWN_MODEL_META: Pick<ModelOption, "contextWindow" | "workingBudgetTokens"> = {
  contextWindow: 64000,
  workingBudgetTokens: 38000,
};

export class ConversationContext {
  private messages: ChatMessage[] = [];
  private cwd: string;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private model: string;
  /**
   * The provider's real prompt_tokens for the last request, and how many messages that request held.
   * Lets us estimate the next request as (exact known count) + (chars/4 of only the new messages)
   * instead of a chars/4 guess over the whole history, which drifts badly on code and JSON.
   */
  private lastPromptTokens = 0;
  private lastPromptMessageCount = 0;

  constructor(cwd: string, model: string) {
    this.cwd = cwd;
    this.model = model;
    this.reset();
  }

  public reset(): void {
    this.lastPromptTokens = 0;
    this.lastPromptMessageCount = 0;
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
    const maxChars = maxToolOutputChars(this.getWorkingBudget());
    const content =
      output.length > maxChars
        ? output.slice(0, maxChars) +
          `\n... [tool output truncated at ${maxChars} chars to keep the conversation within its token budget. ` +
          `Narrow the request (line ranges, grep) to see the rest.]`
        : output;

    this.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content,
    });
  }

  /**
   * `messagesSent` is how many messages the request these tokens were billed for contained. Pass it only
   * when the provider actually reported usage, so a chars/4 fallback never overwrites the real anchor.
   */
  public recordUsage(promptTokens: number, completionTokens: number, messagesSent?: number): void {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    if (messagesSent !== undefined && promptTokens > 0) {
      this.lastPromptTokens = promptTokens;
      this.lastPromptMessageCount = messagesSent;
    }
  }

  /**
   * Token estimate of what the next turn would send: the provider's exact count for the last request
   * plus chars/4 for anything appended since. Falls back to chars/4 over everything when there's no
   * usable anchor yet (first turn, or compaction rewrote the history).
   */
  public estimateCurrentTokens(): number {
    const anchorValid =
      this.lastPromptTokens > 0 &&
      this.lastPromptMessageCount > 0 &&
      this.lastPromptMessageCount <= this.messages.length;
    if (!anchorValid) {
      return Math.ceil(JSON.stringify(this.messages).length / 4);
    }
    const newMessages = this.messages.slice(this.lastPromptMessageCount);
    return this.lastPromptTokens + Math.ceil(JSON.stringify(newMessages).length / 4);
  }

  private getModelMeta(): Pick<ModelOption, "contextWindow" | "workingBudgetTokens"> {
    return AVAILABLE_MODELS[this.model] || UNKNOWN_MODEL_META;
  }

  public getContextWindow(): number {
    return this.getModelMeta().contextWindow;
  }

  /** Live-history size we aim to stay under; see ModelOption.workingBudgetTokens for why it's below the window. */
  public getWorkingBudget(): number {
    return this.getModelMeta().workingBudgetTokens;
  }

  /**
   * True once the next request would exceed the model's working budget. It's a per-model number rather
   * than a fraction of the rated window: on a 131k Groq model it approximates the provider's real payload
   * cap (which 413s well below the window), and on a 1M-window model it keeps each turn's resend cost and
   * latency sane and stays clear of the recall drop-off very long contexts suffer from.
   */
  public shouldAutoCompact(): boolean {
    if (this.messages.length <= 4) return false;
    return this.estimateCurrentTokens() >= this.getWorkingBudget();
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
    // Keep a sizeable verbatim tail (recent file contents, errors, decisions) so compaction doesn't
    // immediately force a re-read of everything the model was just working with.
    const recentBudgetTokens = Math.max(500, Math.floor(this.getWorkingBudget() * 0.4));

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
    // History was rewritten, so the last request's token count no longer describes a prefix of it.
    this.lastPromptTokens = 0;
    this.lastPromptMessageCount = 0;

    return true;
  }
}
