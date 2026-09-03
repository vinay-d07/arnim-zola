import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import dotenv from "dotenv";
import { password, select } from "@inquirer/prompts";
import chalk from "chalk";

// Load environment variables from cwd .env and home directory .env
dotenv.config();
const homeEnvPath = path.join(os.homedir(), ".groqcode", ".env");
if (fs.existsSync(homeEnvPath)) {
  dotenv.config({ path: homeEnvPath });
}

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export const AVAILABLE_MODELS: Record<string, ModelOption> = {
  "openai/gpt-oss-20b": {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B (Default)",
    description: "Fast, highly capable model for code generation and function calling",
    contextWindow: 131072,
    inputPricePerMillion: 0.20,
    outputPricePerMillion: 0.40,
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    description: "Flagship 120B model for complex architecture, reasoning and coding tasks",
    contextWindow: 131072,
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.79,
  },
  "qwen/qwen3.8-27b": {
    id: "qwen/qwen3.8-27b",
    name: "Qwen 3.8 27B",
    description: "High-performance coding and reasoning model with 131k context",
    contextWindow: 131042,
    inputPricePerMillion: 0.30,
    outputPricePerMillion: 0.50,
  },
  "qwen/qwen3.6-27b": {
    id: "qwen/qwen3.6-27b",
    name: "Qwen 3.6 27B",
    description: "Lightweight and versatile 27B model",
    contextWindow: 131072,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 0.45,
  },
};

export const DEFAULT_MODEL = "openai/gpt-oss-20b";

export interface ConfigOptions {
  apiKey?: string;
  model?: string;
  autoApprove?: boolean;
  maxTurns?: number;
  cwd?: string;
  temperature?: number;
}

export class Config {
  public apiKey: string;
  public model: string;
  public autoApprove: boolean;
  public maxTurns: number;
  public cwd: string;
  public temperature: number;

  constructor(cliOptions: ConfigOptions = {}) {
    const rcConfig = this.loadRcConfig();

    this.apiKey =
      cliOptions.apiKey ||
      process.env.GROQ_API_KEY ||
      rcConfig.apiKey ||
      "";

    this.model =
      cliOptions.model ||
      process.env.GROQ_MODEL ||
      rcConfig.model ||
      DEFAULT_MODEL;

    this.autoApprove =
      cliOptions.autoApprove !== undefined
        ? cliOptions.autoApprove
        : process.env.GROQ_AUTO_APPROVE === "true"
        ? true
        : rcConfig.autoApprove || false;

    this.maxTurns =
      cliOptions.maxTurns ||
      (process.env.GROQ_MAX_TURNS ? parseInt(process.env.GROQ_MAX_TURNS, 10) : undefined) ||
      rcConfig.maxTurns ||
      30;

    this.cwd = cliOptions.cwd || process.cwd();
    this.temperature = cliOptions.temperature ?? rcConfig.temperature ?? 0.2;
  }

  private loadRcConfig(): Partial<ConfigOptions> {
    const localRc = path.join(process.cwd(), ".groqcoderc.json");
    if (fs.existsSync(localRc)) {
      try {
        return JSON.parse(fs.readFileSync(localRc, "utf-8"));
      } catch {
        // Ignore JSON parse errors
      }
    }

    const homeRc = path.join(os.homedir(), ".groqcode", "config.json");
    if (fs.existsSync(homeRc)) {
      try {
        return JSON.parse(fs.readFileSync(homeRc, "utf-8"));
      } catch {
        // Ignore JSON parse errors
      }
    }

    return {};
  }

  public async ensureApiKey(): Promise<string> {
    if (this.apiKey && this.apiKey.trim().length > 0) {
      return this.apiKey;
    }

    console.log(
      chalk.yellow("\n🔑 Groq API Key not found in environment or configuration.")
    );
    console.log(
      chalk.dim("Get your free API key at: https://console.groq.com/keys\n")
    );

    const enteredKey = await password({
      message: "Enter your Groq API Key:",
      mask: "*",
      validate: (value) =>
        value.trim().length > 0 ? true : "API Key cannot be empty.",
    });

    this.apiKey = enteredKey.trim();

    const saveChoice = await select({
      message: "Would you like to save this key for future sessions?",
      choices: [
        { name: "Save to local .env (current directory)", value: "local" },
        { name: "Save to global config (~/.groqcode/.env)", value: "global" },
        { name: "Use for this session only", value: "session" },
      ],
    });

    if (saveChoice === "local") {
      const envPath = path.join(this.cwd, ".env");
      fs.appendFileSync(envPath, `\nGROQ_API_KEY=${this.apiKey}\n`);
      console.log(chalk.green(`✓ Saved to ${envPath}`));
    } else if (saveChoice === "global") {
      const globalDir = path.join(os.homedir(), ".groqcode");
      if (!fs.existsSync(globalDir)) {
        fs.mkdirSync(globalDir, { recursive: true });
      }
      const globalEnv = path.join(globalDir, ".env");
      fs.appendFileSync(globalEnv, `\nGROQ_API_KEY=${this.apiKey}\n`);
      console.log(chalk.green(`✓ Saved to ${globalEnv}`));
    }

    return this.apiKey;
  }

  public setModel(modelId: string): boolean {
    if (AVAILABLE_MODELS[modelId]) {
      this.model = modelId;
      return true;
    }
    return false;
  }

  public getModelDetails(): ModelOption {
    return (
      AVAILABLE_MODELS[this.model] || {
        id: this.model,
        name: this.model,
        description: "Custom Groq model",
        contextWindow: 64000,
        inputPricePerMillion: 0.59,
        outputPricePerMillion: 0.79,
      }
    );
  }
}
