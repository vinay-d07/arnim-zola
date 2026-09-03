import chalk from "chalk";
import boxen from "boxen";
import ora, { Ora } from "ora";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// Configure marked with terminal renderer
marked.use(
  markedTerminal({
    code: chalk.yellow,
    blockquote: chalk.gray.italic,
    heading: chalk.bold.cyan,
    firstHeading: chalk.bold.magenta,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.bgGray.white,
    del: chalk.dim.strikethrough,
    link: chalk.blue.underline,
    href: chalk.blue.underline,
  }) as any
);

export class TerminalUI {
  public static banner(version = "1.0.0", modelName = "openai/gpt-oss-20b"): void {
    const title = chalk.bold.hex("#FF7A00")("ARNIM ZOLA") + chalk.dim(` v${version}`);
    const subtitle = chalk.cyan("A light-weight open-source AI code agent powered by Groq LLM");
    const info = [
      `${chalk.dim("Active Model:")} ${chalk.green(modelName)}`,
      `${chalk.dim("Commands:")} Type ${chalk.yellow("/help")} for available commands or ${chalk.yellow("/exit")} to quit.`,
    ].join("\n");

    const boxed = boxen(`${title}\n${subtitle}\n\n${info}`, {
      padding: 1,
      margin: { top: 0, bottom: 1, left: 0, right: 0 },
      borderStyle: "round",
      borderColor: "#FF7A00",
      textAlignment: "left",
    });

    console.log(boxed);
  }

  public static renderMarkdown(content: string): void {
    try {
      const rendered = marked.parse(content);
      if (typeof rendered === "string") {
        process.stdout.write(rendered);
      }
    } catch {
      console.log(content);
    }
  }

  public static spinner(text: string): Ora {
    return ora({
      text: chalk.dim(text),
      color: "yellow",
      spinner: "dots",
    }).start();
  }

  public static logToolCall(name: string, params: Record<string, any>): void {
    const paramSummary = Object.entries(params)
      .map(([k, v]) => {
        let valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
        if (valStr.length > 50) valStr = valStr.substring(0, 47) + "...";
        return `${chalk.dim(k)}=${chalk.cyan(valStr)}`;
      })
      .join(" ");

    console.log(`\n${chalk.bgHex("#333333").white(` 🛠️  TOOL: ${name} `)} ${paramSummary}`);
  }

  public static logToolResult(name: string, output: string, success: boolean): void {
    const badge = success
      ? chalk.bgGreen.black(" ✓ SUCCESS ")
      : chalk.bgRed.white(" ✗ FAILED ");

    const lines = output.trim().split("\n");
    const preview = lines.slice(0, 8).join("\n");
    const remaining = lines.length > 8 ? chalk.dim(`\n... (${lines.length - 8} more lines)`) : "";

    console.log(`${badge} ${chalk.dim(`[${name}]`)}`);
    if (preview) {
      console.log(chalk.gray(preview + remaining));
    }
    console.log();
  }

  public static renderDiff(patch: string): void {
    const lines = patch.split("\n");
    const colored = lines
      .map((line) => {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          return chalk.green(line);
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          return chalk.red(line);
        } else if (line.startsWith("@@")) {
          return chalk.cyan(line);
        }
        return chalk.dim(line);
      })
      .join("\n");

    console.log(
      boxen(colored, {
        padding: 0,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
        borderStyle: "single",
        borderColor: "gray",
        title: chalk.bold("Unified Diff Preview"),
      })
    );
  }

  public static info(message: string): void {
    console.log(chalk.blue("ℹ ") + message);
  }

  public static success(message: string): void {
    console.log(chalk.green("✓ ") + message);
  }

  public static warning(message: string): void {
    console.log(chalk.yellow("⚠ ") + message);
  }

  public static error(message: string): void {
    console.log(chalk.red("✗ ") + message);
  }

  public static printHelp(): void {
    const helpText = [
      chalk.bold("Interactive REPL Slash Commands:"),
      `  ${chalk.yellow("/help")}             Show this help screen`,
      `  ${chalk.yellow("/model [id]")}       View or switch the active Groq model`,
      `  ${chalk.yellow("/tokens")}           Show token consumption and estimated session cost`,
      `  ${chalk.yellow("/compact")}          Compact/summarize conversation context to save tokens`,
      `  ${chalk.yellow("/clear")}            Clear conversation history and reset context`,
      `  ${chalk.yellow("/init")}             Create a local .groqcoderc.json config file`,
      `  ${chalk.yellow("/exit")} or ${chalk.yellow("/quit")}  Exit Groq Code`,
      "",
      chalk.bold("Available Built-in Tools:"),
      `  ${chalk.cyan("view_file")}         Inspect file contents with line ranges`,
      `  ${chalk.cyan("write_file")}        Create or overwrite files`,
      `  ${chalk.cyan("edit_file")}         Targeted string replacement with unified diffs`,
      `  ${chalk.cyan("list_dir")}          Explore workspace directory structure`,
      `  ${chalk.cyan("grep_search")}       Regex/text search across all code files`,
      `  ${chalk.cyan("find_files")}        Glob file search across repository`,
      `  ${chalk.cyan("run_command")}       Execute terminal/shell commands`,
    ].join("\n");

    console.log(
      boxen(helpText, {
        padding: 1,
        borderStyle: "round",
        borderColor: "cyan",
        title: chalk.bold.cyan("Groq Code Manual"),
      })
    );
  }

  public static printTokenStats(
    promptTokens: number,
    completionTokens: number,
    cost: number,
    modelName: string
  ): void {
    const totalTokens = promptTokens + completionTokens;
    const content = [
      `${chalk.dim("Model:")}             ${chalk.cyan(modelName)}`,
      `${chalk.dim("Prompt Tokens:")}     ${chalk.white(promptTokens.toLocaleString())}`,
      `${chalk.dim("Completion Tokens:")} ${chalk.white(completionTokens.toLocaleString())}`,
      `${chalk.dim("Total Tokens:")}      ${chalk.bold.yellow(totalTokens.toLocaleString())}`,
      `${chalk.dim("Est. Groq Cost:")}    ${chalk.bold.green(`$${cost.toFixed(6)}`)}`,
    ].join("\n");

    console.log(
      boxen(content, {
        padding: 1,
        borderStyle: "round",
        borderColor: "yellow",
        title: chalk.bold("Session Token & Cost Analytics"),
      })
    );
  }
}
