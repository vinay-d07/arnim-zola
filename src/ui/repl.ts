import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { input, select } from "@inquirer/prompts";
import { Agent } from "../agent/agent.js";
import { TerminalUI } from "./terminal.js";
import { AVAILABLE_MODELS, DEFAULT_MODEL } from "../config/config.js";

export async function startRepl(agent: Agent): Promise<void> {
  TerminalUI.banner("1.0.0", agent.getConfig().model);

  while (true) {
    let userInput: string;
    try {
      userInput = await input({
        message: chalk.hex("#FF7A00")("❯"),
      });
    } catch (err: any) {
      // User pressed Ctrl+C or exited
      console.log("\nGoodbye!");
      process.exit(0);
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // Handle slash commands
    if (trimmed.startsWith("/")) {
      const handled = await handleSlashCommand(trimmed, agent);
      if (handled === "exit") {
        console.log(chalk.cyan("Goodbye!"));
        process.exit(0);
      }
      continue;
    }

    // Run user prompt through agent
    try {
      await agent.runPrompt(trimmed);
    } catch (err: any) {
      TerminalUI.error(`Error during execution: ${err.message}`);
    }
  }
}

async function handleSlashCommand(
  cmdStr: string,
  agent: Agent
): Promise<"handled" | "exit"> {
  const parts = cmdStr.split(" ");
  const command = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (command) {
    case "/exit":
    case "/quit":
    case "/q":
      return "exit";

    case "/help":
    case "/h":
    case "/?":
      TerminalUI.printHelp();
      return "handled";

    case "/clear":
    case "/reset":
      agent.getContext().reset();
      TerminalUI.success("Conversation history cleared. Context reset to fresh state.");
      return "handled";

    case "/compact":
      const compacted = agent.getContext().compact();
      if (compacted) {
        TerminalUI.success("Conversation context compacted to preserve tokens.");
      } else {
        TerminalUI.info("Context is already small. Compaction not required yet.");
      }
      return "handled";

    case "/tokens":
    case "/cost":
    case "/usage":
      const stats = agent.getContext().getUsageStats();
      TerminalUI.printTokenStats(
        stats.promptTokens,
        stats.completionTokens,
        stats.estimatedCost,
        agent.getConfig().model
      );
      return "handled";

    case "/model":
      if (arg) {
        if (AVAILABLE_MODELS[arg]) {
          agent.setModel(arg);
          TerminalUI.success(`Switched active model to: ${chalk.bold(arg)}`);
        } else {
          TerminalUI.warning(
            `Unknown model '${arg}'. Available: ${Object.keys(AVAILABLE_MODELS).join(", ")}`
          );
        }
      } else {
        const selectedModel = await select({
          message: "Select Groq LLM Model:",
          default: agent.getConfig().model,
          choices: Object.values(AVAILABLE_MODELS).map((m) => ({
            name: `${m.name} ${chalk.dim(`(${m.contextWindow / 1000}k ctx)`)}`,
            value: m.id,
            description: m.description,
          })),
        });
        agent.setModel(selectedModel);
        TerminalUI.success(`Active model updated to: ${chalk.bold(selectedModel)}`);
      }
      return "handled";

    case "/init":
      const rcPath = path.join(agent.getConfig().cwd, ".groqcoderc.json");
      const defaultRc = {
        model: agent.getConfig().model || DEFAULT_MODEL,
        autoApprove: agent.getConfig().autoApprove,
        maxTurns: agent.getConfig().maxTurns,
        temperature: agent.getConfig().temperature,
      };

      fs.writeFileSync(rcPath, JSON.stringify(defaultRc, null, 2), "utf-8");
      TerminalUI.success(`Created configuration file at ${chalk.cyan(rcPath)}`);
      return "handled";

    default:
      TerminalUI.warning(`Unknown command '${command}'. Type ${chalk.yellow("/help")} for available commands.`);
      return "handled";
  }
}
