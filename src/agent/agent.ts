import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import { Config } from "../config/config.js";
import { ToolRegistry } from "../tools/registry.js";
import { bashTool } from "../tools/bash_tool.js";
import { LLMClient, ToolCall, isInsufficientCreditsError, isPayloadTooLargeError } from "./llm.js";
import { ConversationContext } from "./context.js";
import { TerminalUI } from "../ui/terminal.js";

const FILE_MODIFYING_TOOLS = new Set(["write_file", "edit_file"]);

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + `\n... [truncated at ${maxLen} chars]` : text;
}

export class Agent {
  private config: Config;
  private registry: ToolRegistry;
  private llm: LLMClient;
  private context: ConversationContext;
  /** Lazily detected once per session: undefined = not yet checked, null = no verify command available. */
  private verifyCommand: string | null | undefined = undefined;

  constructor(config: Config) {
    this.config = config;
    this.registry = new ToolRegistry();
    this.llm = this.createClient();
    this.context = new ConversationContext(config.cwd, config.model);
  }

  private createClient(): LLMClient {
    return new LLMClient(
      this.config.getApiKey(),
      this.config.getProvider().baseURL,
      this.config.model,
      this.config.temperature
    );
  }

  public setModel(modelId: string): boolean {
    if (this.config.setModel(modelId)) {
      // Models can live on different providers, each with its own base URL and key.
      this.llm = this.createClient();
      this.context.setModel(modelId);
      return true;
    }
    return false;
  }

  public getContext(): ConversationContext {
    return this.context;
  }

  public getConfig(): Config {
    return this.config;
  }

  public async runPrompt(userPrompt: string): Promise<void> {
    this.context.addUserMessage(userPrompt);

    let currentTurn = 0;
    const maxTurns = this.config.maxTurns;
    let payloadTooLargeRetries = 0;
    const MAX_PAYLOAD_TOO_LARGE_RETRIES = 3;

    while (currentTurn < maxTurns) {
      currentTurn++;

      if (this.context.shouldAutoCompact()) {
        if (this.context.compact()) {
          TerminalUI.info("Context automatically compacted to stay within the model's context window.");
        }
      }

      const tools = this.registry.getGroqTools();
      const messages = this.context.getMessages();

      const spinner = TerminalUI.spinner(
        currentTurn === 1 ? "Thinking..." : "Processing tool results..."
      );

      let streamedText = "";
      let hasStartedStreamingText = false;
      let hasStreamedReasoning = false;

      let result;
      try {
        result = await this.llm.streamCompletion(messages, tools, {
          onReasoning: (token) => {
            if (spinner.isSpinning) spinner.stop();
            hasStreamedReasoning = true;
            process.stdout.write(chalk.gray.italic(token));
          },
          onToken: (token) => {
            if (spinner.isSpinning) spinner.stop();
            if (!hasStartedStreamingText) {
              hasStartedStreamingText = true;
              // Separate the answer from the gray reasoning stream that precedes it.
              if (hasStreamedReasoning) process.stdout.write("\n\n");
            }
            process.stdout.write(token);
          },
          onToolCallStart: (index, name) => {
            if (spinner.isSpinning) spinner.stop();
          },
          onRetry: (attempt, maxAttempts, reason) => {
            if (spinner.isSpinning) spinner.stop();
            TerminalUI.warning(
              `${this.config.getProvider().name} had a transient error (${reason}). Retrying ${attempt}/${maxAttempts}...`
            );
            spinner.start();
          },
        });
      } catch (err: any) {
        if (spinner.isSpinning) spinner.stop();

        if (isPayloadTooLargeError(err) && payloadTooLargeRetries < MAX_PAYLOAD_TOO_LARGE_RETRIES) {
          payloadTooLargeRetries++;
          if (this.context.compact()) {
            TerminalUI.warning(
              "Request was too large for the model (413). Compacting conversation history and retrying..."
            );
            currentTurn--; // don't burn a turn on a request that never reached the model
            continue;
          }
        }

        if (isInsufficientCreditsError(err)) {
          TerminalUI.error(`${this.config.getProvider().name} wallet balance is too low for this request. Top up and retry.`);
          return;
        }

        TerminalUI.error(`${this.config.getProvider().name} API error: ${err.message}`);
        return;
      }

      if (spinner.isSpinning) spinner.stop();

      // Ensure newline after streamed text if any was output
      if (hasStartedStreamingText) {
        console.log();
      }

      this.context.recordUsage(
        result.promptTokens,
        result.completionTokens,
        result.usageReported ? messages.length : undefined
      );

      // Check if model decided to make tool calls
      if (result.toolCalls && result.toolCalls.length > 0) {
        this.context.addAssistantMessage( 
          result.content || null,
          result.toolCalls
        );

        let filesChanged = false;
        for (const tc of result.toolCalls) {
          const changedFile = await this.handleToolCall(tc);
          if (changedFile) filesChanged = true;
        }

        if (filesChanged) {
          await this.runVerification();
        }

        // Continue agent loop to feed tool responses back to model
        continue;
      } else {
        // Model produced final answer without tool calls
        this.context.addAssistantMessage(result.content);
        break;
      }
    }

    if (currentTurn >= maxTurns) {
      TerminalUI.warning(`Reached maximum turn limit of ${maxTurns}.`);
    }

    TerminalUI.printContextUsage(this.context.estimateCurrentTokens(), this.context.getContextWindow());
  }

  /** Returns true if this call successfully wrote or edited a file, so the caller knows whether to re-verify. */
  private async handleToolCall(tc: ToolCall): Promise<boolean> {
    const toolName = tc.function.name;
    let params: Record<string, any> = {};

    try {
      params = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      params = { raw: tc.function.arguments };
    }

    TerminalUI.logToolCall(toolName, params);

    const tool = this.registry.getTool(toolName);
    if (!tool) {
      const errMsg = `Tool '${toolName}' not found.`;
      TerminalUI.error(errMsg);
      this.context.addToolMessage(tc.id, errMsg);
      return false;
    }

    const toolResult = await this.registry.executeTool(toolName, params, {
      cwd: this.config.cwd,
      autoApprove: this.config.autoApprove,
      onConfirm: async (description: string): Promise<boolean> => {
        console.log();
        return await confirm({
          message: `${chalk.bold.yellow("Permission Request")}\n${description}\nAllow this action?`,
          default: true,
        });
      },
    });

    TerminalUI.logToolResult(toolName, toolResult.output, toolResult.success);
    this.context.addToolMessage(tc.id, toolResult.output);

    return toolResult.success && (FILE_MODIFYING_TOOLS.has(toolName) || toolName === "scaffold_project");
  }

  /**
   * Detects a project's own build/typecheck/test command once per session. We deliberately reuse
   * whatever the project already defines (npm scripts, tsconfig) rather than guessing a toolchain,
   * so this stays correct for any stack instead of hardcoding assumptions.
   */
  private detectVerifyCommand(): string | null {
    if (this.verifyCommand !== undefined) return this.verifyCommand;

    const pkgPath = path.join(this.config.cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts || {};
        if (scripts.typecheck) return (this.verifyCommand = "npm run typecheck");
        if (scripts.build) return (this.verifyCommand = "npm run build");
        if (scripts.test) return (this.verifyCommand = "npm test");
      } catch {
        // Malformed package.json; fall through to other detection.
      }
    }

    const tsconfigPath = path.join(this.config.cwd, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) {
      return (this.verifyCommand = "npx tsc --noEmit");
    }

    return (this.verifyCommand = null);
  }

  /**
   * Runs the project's own verification command after any turn that wrote or edited files, and
   * feeds the result back into the conversation. This is what makes "verify your work" mandatory
   * instead of an easily-skipped suggestion in the system prompt: the model sees real build/type
   * errors on the next turn and has to address them before it can declare the task done.
   */
  private async runVerification(): Promise<void> {
    const cmd = this.detectVerifyCommand();
    if (!cmd) return;

    TerminalUI.info(`Running automated verification: ${cmd}`);
    const result = await bashTool.execute(
      { command: cmd, timeout_ms: 120000 },
      { cwd: this.config.cwd, autoApprove: true }
    );

    TerminalUI.logToolResult(`verify (${cmd})`, result.output, result.success);

    const note = result.success
      ? `[Automated verification]\n$ ${cmd}\n\nVerification passed:\n${truncate(result.output, 2000)}`
      : `[Automated verification]\n$ ${cmd}\n\nVerification FAILED. You must fix these errors before the task can be ` +
        `considered complete — do not tell the user the work is done while this is failing:\n${truncate(result.output, 2000)}`;

    this.context.addUserMessage(note);
  }
}
