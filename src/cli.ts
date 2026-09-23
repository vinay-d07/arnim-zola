import { Command } from "commander";
import { Config } from "./config/config.js";
import { Agent } from "./agent/agent.js";
import { startRepl } from "./ui/repl.js";
import { TerminalUI } from "./ui/terminal.js";

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("groq-code")
    .description("A lightweight Claude Code alternative for any OpenAI-compatible LLM provider (Velona, Groq)")
    .version("1.0.0")
    .argument("[prompt...]", "Optional one-shot prompt to execute")
    .option("-m, --model <model>", "Model ID to use (e.g. deepseek/deepseek-v4-pro, openai/gpt-oss-120b)")
    .option("-p, --provider <provider>", "Provider for model IDs not in the built-in list: velona | groq (default: velona)")
    .option("-y, --yes", "Auto-approve all tool actions without interactive confirmation", false)
    .option("-k, --api-key <key>", "API key for the selected model's provider")
    .option("-t, --temperature <temperature>", "Sampling temperature (default: 0.2)", parseFloat)
    .option("--max-turns <turns>", "Maximum reasoning turns per prompt (default: 60)", parseInt)
    .option("-d, --cwd <path>", "Custom working directory for operations")
    .helpOption("-h, --help", "Display help information");

  program.parse(argv);

  const options = program.opts();
  const promptArgs = program.args;

  const config = new Config({
    apiKey: options.apiKey,
    model: options.model,
    provider: options.provider,
    autoApprove: options.yes,
    temperature: options.temperature,
    maxTurns: options.maxTurns,
    cwd: options.cwd,
  });

  try {
    await config.ensureApiKey();
  } catch (err: any) {
    TerminalUI.error("Failed to obtain API key.");
    process.exit(1);
  }

  const agent = new Agent(config);

  if (promptArgs && promptArgs.length > 0) {
    const singlePrompt = promptArgs.join(" ");
    try {
      await agent.runPrompt(singlePrompt);
    } catch (err: any) {
      TerminalUI.error(`Execution error: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Launch interactive REPL
    await startRepl(agent);
  }
}
