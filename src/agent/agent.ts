import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import { Config } from "../config/config.js";
import { ToolRegistry } from "../tools/registry.js";
import { GroqClient, GroqToolCall } from "./groq.js";
import { ConversationContext } from "./context.js";
import { TerminalUI } from "../ui/terminal.js";

export class Agent {
  private config: Config;
  private registry: ToolRegistry;
  private groq: GroqClient;
  private context: ConversationContext;

  constructor(config: Config) {
    this.config = config;
    this.registry = new ToolRegistry();
    this.groq = new GroqClient(config.apiKey, config.model, config.temperature);
    this.context = new ConversationContext(config.cwd, config.model);
  }

  public setModel(modelId: string): boolean {
    if (this.config.setModel(modelId)) {
      this.groq.setModel(modelId);
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

    while (currentTurn < maxTurns) {
      currentTurn++;
      const tools = this.registry.getGroqTools();
      const messages = this.context.getMessages();

      const spinner = TerminalUI.spinner(
        currentTurn === 1 ? "Thinking..." : "Processing tool results..."
      );

      let streamedText = "";
      let hasStartedStreamingText = false;

      let result;
      try {
        result = await this.groq.streamCompletion(messages, tools, {
          onReasoning: (token) => {
            if (spinner.isSpinning) spinner.stop();
            process.stdout.write(chalk.gray.italic(token));
          },
          onToken: (token) => {
            if (spinner.isSpinning) spinner.stop();
            if (!hasStartedStreamingText) {
              hasStartedStreamingText = true;
            }
            process.stdout.write(token);
          },
          onToolCallStart: (index, name) => {
            if (spinner.isSpinning) spinner.stop();
          },
        });
      } catch (err: any) {
        if (spinner.isSpinning) spinner.stop();
        TerminalUI.error(`Groq API error: ${err.message}`);
        return;
      }

      if (spinner.isSpinning) spinner.stop();

      // Ensure newline after streamed text if any was output
      if (hasStartedStreamingText) {
        console.log();
      }

      this.context.recordUsage(result.promptTokens, result.completionTokens);

      // Check if model decided to make tool calls
      if (result.toolCalls && result.toolCalls.length > 0) {
        this.context.addAssistantMessage(
          result.content || null,
          result.toolCalls
        );

        for (const tc of result.toolCalls) {
          await this.handleToolCall(tc);
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
  }

  private async handleToolCall(tc: GroqToolCall): Promise<void> {
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
      return;
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
  }
}
