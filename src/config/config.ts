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

export type ProviderId = "velona" | "groq";

export interface ProviderOption {
  name: string;
  /** OpenAI-compatible chat-completions base URL. */
  baseURL: string;
  apiKeyEnv: string;
  keysUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderOption> = {
  velona: {
    name: "Velona",
    baseURL: "https://velona.in/v1",
    apiKeyEnv: "VELONA_API_KEY",
    keysUrl: "https://velona.in/keys",
  },
  groq: {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    keysUrl: "https://console.groq.com/keys",
  },
};

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  provider: ProviderId;
  contextWindow: number;
  /**
   * Tokens of live history we're willing to resend every turn before compacting. Deliberately far
   * below `contextWindow` on large-window models: every turn resends the whole history, so cost and
   * latency scale with it, and recall quality degrades well before the rated window is full.
   */
  workingBudgetTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export const AVAILABLE_MODELS: Record<string, ModelOption> = {
  "deepseek/deepseek-v4-pro": {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro (Default)",
    description: "Strong agentic coding model with a 1M-token window. Best choice for multi-file app builds.",
    provider: "velona",
    contextWindow: 1048576,
    workingBudgetTokens: 200000,
    inputPricePerMillion: 0.95526,
    outputPricePerMillion: 1.91052,
  },
  "deepseek/deepseek-v4-flash": {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "Much cheaper V4 variant with the same 1M window. Good for quick edits and exploration.",
    provider: "velona",
    contextWindow: 1048576,
    workingBudgetTokens: 200000,
    inputPricePerMillion: 0.088606,
    outputPricePerMillion: 0.177212,
  },
  "qwen/qwen3-coder": {
    id: "qwen/qwen3-coder",
    name: "Qwen3 Coder 480B",
    description: "Coding-specialised MoE model with a 262k window.",
    provider: "velona",
    contextWindow: 262144,
    workingBudgetTokens: 120000,
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 1,
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B (Groq)",
    description: "Flagship 120B model for complex architecture, reasoning and coding tasks. Default because full app builds need the extra reasoning depth over the 20B model.",
    provider: "groq",
    contextWindow: 131072,
    workingBudgetTokens: 40000,
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.79,
  },
  "openai/gpt-oss-20b": {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B",
    description: "Fast, cheap model for quick edits and simple function calling. Not recommended for multi-file app generation.",
    provider: "groq",
    contextWindow: 131072,
    workingBudgetTokens: 40000,
    inputPricePerMillion: 0.20,
    outputPricePerMillion: 0.40,
  },
  "qwen/qwen3.8-27b": {
    id: "qwen/qwen3.8-27b",
    name: "Qwen 3.8 27B",
    description: "High-performance coding and reasoning model with 131k context",
    provider: "groq",
    contextWindow: 131042,
    workingBudgetTokens: 40000,
    inputPricePerMillion: 0.30,
    outputPricePerMillion: 0.50,
  },
  "qwen/qwen3.6-27b": {
    id: "qwen/qwen3.6-27b",
    name: "Qwen 3.6 27B",
    description: "Lightweight and versatile 27B model",
    provider: "groq",
    contextWindow: 131072,
    workingBudgetTokens: 40000,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 0.45,
  },
};

export const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

export interface ConfigOptions {
  apiKey?: string;
  model?: string;
  provider?: ProviderId;
  autoApprove?: boolean;
  maxTurns?: number;
  cwd?: string;
  temperature?: number;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDERS;
}

export class Config {
  public model: string;
  public autoApprove: boolean;
  public maxTurns: number;
  public cwd: string;
  public temperature: number;
  /** Provider used for models not listed in AVAILABLE_MODELS (Velona serves 300+ ids we don't enumerate). */
  private fallbackProvider: ProviderId;
  /** Keys are per provider so /model can hop between a Velona and a Groq model mid-session. */
  private apiKeys: Partial<Record<ProviderId, string>> = {};

  constructor(cliOptions: ConfigOptions = {}) {
    const rcConfig = this.loadRcConfig();

    this.model =
      cliOptions.model ||
      process.env.LLM_MODEL ||
      process.env.GROQ_MODEL ||
      rcConfig.model ||
      DEFAULT_MODEL;

    const envProvider = process.env.LLM_PROVIDER;
    this.fallbackProvider = (isProviderId(cliOptions.provider) ? cliOptions.provider : undefined) || (isProviderId(envProvider) ? envProvider : undefined) ||
      (isProviderId(rcConfig.provider) ? rcConfig.provider : undefined) || "velona";

    for (const [id, provider] of Object.entries(PROVIDERS) as [ProviderId, ProviderOption][]) {
      const key = process.env[provider.apiKeyEnv];
      if (key) this.apiKeys[id] = key;
    }
    // A bare --api-key / rc apiKey belongs to whichever provider the starting model runs on.
    const explicitKey = cliOptions.apiKey || rcConfig.apiKey;
    if (explicitKey) this.apiKeys[this.getProviderId()] = explicitKey;

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
      60;

    this.cwd = cliOptions.cwd || process.cwd();
    this.temperature = cliOptions.temperature ?? rcConfig.temperature ?? 0.2;
  }

  public getProviderId(model = this.model): ProviderId {
    return AVAILABLE_MODELS[model]?.provider ?? this.fallbackProvider;
  }

  public getProvider(model = this.model): ProviderOption {
    return PROVIDERS[this.getProviderId(model)];
  }

  /** API key for the provider serving `model` (defaults to the active model); "" if none configured. */
  public getApiKey(model = this.model): string {
    return this.apiKeys[this.getProviderId(model)] || "";
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
    const existing = this.getApiKey();
    if (existing.trim().length > 0) {
      return existing;
    }

    const providerId = this.getProviderId();
    const provider = PROVIDERS[providerId];

    console.log(
      chalk.yellow(`\n🔑 ${provider.name} API Key not found in environment or configuration.`)
    );
    console.log(chalk.dim(`Get your API key at: ${provider.keysUrl}\n`));

    const enteredKey = await password({
      message: `Enter your ${provider.name} API Key:`,
      mask: "*",
      validate: (value) =>
        value.trim().length > 0 ? true : "API Key cannot be empty.",
    });

    const apiKey = enteredKey.trim();
    this.apiKeys[providerId] = apiKey;

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
      fs.appendFileSync(envPath, `\n${provider.apiKeyEnv}=${apiKey}\n`);
      console.log(chalk.green(`✓ Saved to ${envPath}`));
    } else if (saveChoice === "global") {
      const globalDir = path.join(os.homedir(), ".groqcode");
      if (!fs.existsSync(globalDir)) {
        fs.mkdirSync(globalDir, { recursive: true });
      }
      const globalEnv = path.join(globalDir, ".env");
      fs.appendFileSync(globalEnv, `\n${provider.apiKeyEnv}=${apiKey}\n`);
      console.log(chalk.green(`✓ Saved to ${globalEnv}`));
    }

    return apiKey;
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
        description: "Custom model",
        provider: this.getProviderId(),
        contextWindow: 64000,
        workingBudgetTokens: 38000,
        inputPricePerMillion: 0.59,
        outputPricePerMillion: 0.79,
      }
    );
  }
}
