# ARNIM ZOLA (Claude Code Alternative in TypeScript)

> A blazing fast, lightweight **Claude Code** alternative powered by **Groq LLM** inference, built with **TypeScript**.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Groq](https://img.shields.io/badge/LLM-Groq%20Cloud-orange.svg)](https://groq.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## ✨ Features

- ⚡ **Ultra-Fast Inference**: Leverages Groq's LPU inference engine for near-instant responses and function execution.
- 🤖 **Autonomous ReAct Agent Loop**: Seamless multi-turn reasoning, tool calling, execution, and observation cycle.
- 🧰 **Complete Coding Tool Suite**:
  - `view_file`: Read entire files or specific line ranges with line numbers.
  - `write_file`: Create new files or overwrite existing files.
  - `edit_file`: Precise string/block replacement with git-style unified diffs.
  - `list_dir`: Directory tree explorer with file size metadata and depth control.
  - `grep_search`: Fast regex/text search across all workspace files.
  - `find_files`: Glob-based file pattern finder.
  - `run_command`: Cross-platform terminal command execution (PowerShell/Bash) with timeout and safety controls.
- 💬 **Interactive Terminal REPL & One-Shot Mode**:
  - Use interactively (`zola`) or in one-shot script mode (`zola "add unit tests"`).
  - Slash commands: `/help`, `/model`, `/compact`, `/clear`, `/tokens`, `/init`, `/exit`.
- 🛡️ **Safety Guardrails**: Asks for user confirmation before modifying files or executing terminal commands (can be auto-approved with `-y`).
- 📊 **Token & Cost Tracking**: Live tracking of prompt/completion tokens and estimated Groq usage cost.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- A Groq API key from [console.groq.com](https://console.groq.com/keys)

### 2. Installation & Setup

Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd devin
npm install
npm run build
```

Link globally (optional, to use `zola` anywhere):
```bash
npm link
```

### 3. Set your Groq API Key

You can provide your key in any of the following ways:

- **Via Environment Variable**:
  ```bash
  export GROQ_API_KEY="gsk_..."      # Linux/macOS
  $env:GROQ_API_KEY="gsk_..."       # Windows PowerShell
  ```
- **Via `.env` file**:
  ```ini
  GROQ_API_KEY=gsk_...
  GROQ_MODEL=llama-3.3-70b-versatile
  GROQ_AUTO_APPROVE=false
  ```
- **Interactive Prompt**: Run `zola` without an API key and it will prompt you securely to enter and optionally save it.

---

## 💻 Usage

### Interactive Mode (REPL)

Launch the interactive coding assistant:

```bash
npm run dev
# or if linked/built:
zola
```

### One-Shot Mode

Run a single autonomous task from your terminal:

```bash
zola "Inspect package.json and add a test script for vitest"
```

Auto-approve all actions without interactive confirmation:

```bash
zola "Create an Express server in server.js on port 3000" --yes
```

---

## 🎛️ CLI Options

```text
Usage: groq-code [options] [prompt...]

A high-speed, lightweight Claude Code alternative powered by Groq LLM

Arguments:
  prompt                           Optional one-shot prompt to execute

Options:
  -V, --version                    output the version number
  -m, --model <model>              Groq model ID (default: llama-3.3-70b-versatile)
  -y, --yes                        Auto-approve tool actions without confirmation
  -k, --api-key <key>              Groq API key
  -t, --temperature <temperature>  Sampling temperature (default: 0.2)
  --max-turns <turns>              Maximum reasoning turns per prompt (default: 30)
  -d, --cwd <path>                 Custom working directory
  -h, --help                       Display help information
```

---

## 🧠 Supported Groq Models

| Model ID | Context Window | Best For |
| :--- | :---: | :--- |
| `llama-3.3-70b-versatile` *(Default)* | 128k | Overall coding, architecture & complex tool calling |
| `qwen-2.5-coder-32b` | 32k | Fast, precise code generation & refactoring |
| `deepseek-r1-distill-llama-70b` | 128k | Complex reasoning and problem-solving |
| `llama-3.1-8b-instant` | 128k | Ultra-fast lightweight tasks |

Switch models at runtime in REPL with `/model` or via flag `-m <model_id>`.

---

## 🕹️ Interactive Slash Commands

Inside the REPL session, use slash commands for quick control:

- `/help` - Show command overview and list of tools.
- `/model [id]` - View available models or switch the active model interactively.
- `/tokens` - Display prompt tokens, completion tokens, and estimated cost.
- `/compact` - Summarize conversation history to keep context compact.
- `/clear` - Reset conversation context back to a clean state.
- `/init` - Generate a `.groqcoderc.json` configuration file in the current directory.
- `/exit` / `/quit` - Exit the REPL.

---

## 🏗️ Project Architecture

```
devin/
├── src/
│   ├── index.ts                # Application entry point
│   ├── cli.ts                  # CLI argument parsing (Commander)
│   ├── config/
│   │   └── config.ts           # Config & API key manager (.env, rc files)
│   ├── agent/
│   │   ├── agent.ts            # Autonomous ReAct agent loop
│   │   ├── groq.ts             # Groq SDK client wrapper & streaming
│   │   ├── system_prompt.ts    # Dynamic environment & agent prompt
│   │   └── context.ts          # Conversation memory, compaction, cost tracking
│   ├── tools/
│   │   ├── types.ts            # Tool interfaces & JSON schema types
│   │   ├── registry.ts         # Tool registration & dispatcher
│   │   ├── file_tools.ts       # view_file, write_file, edit_file, list_dir
│   │   ├── search_tools.ts     # grep_search, find_files
│   │   └── bash_tool.ts        # run_command terminal runner
│   └── ui/
│       ├── terminal.ts         # Rich terminal formatting, diffs, spinners
│       └── repl.ts             # Interactive REPL loop
├── tests/
│   ├── test_tools.ts           # 25-point unit & integration test suite
│   └── test_agent_mock.ts      # Multi-turn mock agent loop verification
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## 🧪 Testing

Run the test suites:

```bash
npm test
npx tsx tests/test_agent_mock.ts
```

---

## 📄 License

MIT © 2026
