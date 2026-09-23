# CORE.md — How Zola Actually Works

This is the internals doc: what happens between you typing a prompt and files
landing on disk. `README.md` is the user-facing quick start; this is the
architecture reference. File:line references point at the current source.

---

## 1. The shape of the system

```
you type a prompt
      │
      ▼
 src/cli.ts ── parses argv (Commander) ──► builds a Config
      │
      ▼
 src/ui/repl.ts (interactive)  OR  Agent.runPrompt() directly (one-shot arg)
      │
      ▼
 src/agent/agent.ts  ◄─────────────────────────────────────┐
   Agent.runPrompt()                                       │
   - push user message into ConversationContext            │
   - loop (max Config.maxTurns times):                     │
       1. ask GroqClient to stream a completion             │
       2. if the model returned tool_calls → execute them   │
          via ToolRegistry, push results back into context, │
          run auto-verification if a file changed ──────────┘  (loops again)
       3. if the model returned plain text → done, break
```

Everything is one linear ReAct loop: **send full conversation → model
answers with either tool calls or a final message → tool results get
appended → repeat.** There's no separate planning phase; `todo_write`
(§5) is the model's own scratch list, not something the harness enforces.

---

## 2. Entry points

- **`src/index.ts`** — the actual `bin` target (`zola`). Just calls
  `runCli()` and prints fatal errors.
- **`src/cli.ts`** — Commander-based argv parsing. Builds a `Config` from
  flags/env, calls `config.ensureApiKey()` (interactive prompt + optional
  save if no key is found anywhere), then either:
  - args present → one-shot: `agent.runPrompt(promptText)` once and exit.
  - no args → `startRepl(agent)` (`src/ui/repl.ts`), an infinite
    `input()` loop that routes `/slash` commands (`src/ui/repl.ts:46`)
    or forwards plain text to `agent.runPrompt()`.

---

## 3. Config resolution (`src/config/config.ts`)

Precedence, highest wins: **CLI flag → env var (`GROQ_API_KEY`,
`GROQ_MODEL`, etc.) → `.groqcoderc.json` (project) or
`~/.groqcode/config.json` (global) → hardcoded default.**

`AVAILABLE_MODELS` (`config.ts:24`) is the source of truth for model
metadata (context window, $/1M tokens) used for cost estimates and for
the compaction math in §4 — if you add/rename a model on the Groq side,
update this map too, since `getModelDetails()` falls back to a generic
64k-context guess for anything not listed.

`.env` is loaded from both the current directory and
`~/.groqcode/.env` (`config.ts:9-13`), so a global key doesn't need to
be re-entered per project.

---

## 4. Conversation context & compaction (`src/agent/context.ts`)

`ConversationContext` holds the flat `ChatMessage[]` array that gets
sent to Groq every turn — system prompt, then alternating
user/assistant/tool messages. Three things keep this from blowing up:

1. **Per-tool truncation** — most tools cap their own output before it
   ever reaches the agent (`bash_tool.ts` caps stdout at 10KB, stderr at
   4KB; `view_file` caps at 2000 lines by default; `grep_search` caps at
   ≤100 results with 300-char line previews).
2. **A hard ceiling in `addToolMessage()`** (`context.ts`) — regardless
   of what the tool already did, any single tool result is truncated to
   `MAX_TOOL_OUTPUT_CHARS` (6000 chars) before it's pushed into the
   message array. This is the safety net for tools that don't self-cap.
3. **Auto-compaction** — `Agent.runPrompt()` calls
   `context.shouldAutoCompact()` at the top of every turn
   (`agent.ts:59`). It trips when either:
   - live history crosses 60% of the *model's* rated context window, or
   - live history crosses an absolute `ABSOLUTE_SAFE_TOKEN_CEILING`
     (40,000 tokens), independent of the model's window.

   The second check exists because Groq (and most inference providers)
   enforce a per-request payload-size cap that's often much smaller
   than the model's advertised context window, especially on free
   tiers — without it you can hit a 413 long before the
   percentage-based check ever fires.

`compact()` (`context.ts`) keeps a token-budgeted tail of recent
messages verbatim (snapped to a user-turn boundary so a `tool_call`
never gets separated from its `tool` result), and folds everything
older into a narrative summary — with one exception: **which files
were written or edited is preserved explicitly** as a list, not
summarized away, because losing that is what causes an agent to
re-scaffold or contradict earlier work in long sessions.

Token counts are estimated as `chars / 4` (`estimateCurrentTokens()`),
not a real tokenizer — it's approximate on purpose (cheap, no
dependency), which is also why the absolute ceiling in point 3 is
deliberately conservative rather than cutting it close.

---

## 5. Tools (`src/tools/`)

`ToolRegistry` (`registry.ts`) is a name → `Tool` map. Each `Tool`
(`types.ts`) declares a JSON Schema for its params (sent to Groq as
function-calling schemas via `getGroqTools()`) and an `execute()` that
returns `{ success, output, error?, metadata? }`.

| Tool | File | Notes |
|---|---|---|
| `view_file` | `file_tools.ts` | Line-ranged reads, 2000-line default cap |
| `write_file` | `file_tools.ts` | Full overwrite; requires confirmation |
| `edit_file` | `file_tools.ts` | Exact `old_string` → `new_string`, must be unique in file; returns a unified diff |
| `list_dir` | `file_tools.ts` | Tree view, depth-limited, ignores `node_modules`/`.git`/etc. |
| `grep_search` | `search_tools.ts` | Regex or literal, ≤100 results |
| `find_files` | `search_tools.ts` | Glob search via `fast-glob` |
| `run_command` | `bash_tool.ts` | Spawns `powershell.exe`/`bash`; hard-killed on timeout or 10KB stdout |
| `scaffold_project` | `scaffold_tool.ts` | Shells out to the *real* `create-vite`/`create-next-app`/`express-generator` instead of hand-writing config |
| `todo_write` | `todo_tool.ts` + `todo_store.ts` | Model's own task list; rejects >1 `in_progress` item |

**Confirmation flow**: any tool with `requiresConfirmation: true`
(`write_file`, `edit_file`, `run_command`, `scaffold_project`) calls
`context.onConfirm(description)`, which `Agent.handleToolCall()`
(`agent.ts:169`) wires to an inquirer `confirm()` prompt — unless
`Config.autoApprove` is set (`-y` flag or `GROQ_AUTO_APPROVE=true`),
which skips the prompt entirely.

---

## 6. Automated verification (`agent.ts:187-240`)

After any turn where a tool call was `write_file`, `edit_file`, or
`scaffold_project` and it succeeded, `Agent.runPrompt()` runs
`runVerification()`. It lazily detects (once per session, cached in
`this.verifyCommand`) the project's own check command — `npm run
typecheck` → `npm run build` → `npm test` → `npx tsc --noEmit`, in that
order of preference, or nothing if none apply. The result (truncated to
2000 chars) is fed back into context as a user message, and a FAILED
result is phrased as a blocking instruction ("you must fix these errors
before the task can be considered complete") — this is what makes
verification mandatory instead of a suggestion the model can ignore.

---

## 7. Talking to Groq (`src/agent/groq.ts`)

`GroqClient` wraps the official `groq-sdk`, streams
`chat.completions.create(..., stream: true)`, and reassembles
streamed `delta.tool_calls` chunks into complete tool calls by index
(models stream tool-call arguments token-by-token, not as one blob).

**Retry behavior** (`streamCompletion()`):
- Transient errors (`RateLimitError`, `InternalServerError`,
  `APIConnectionError`, or a tool-call-JSON parse failure) get retried.
- **429 (rate limit)**: honors the server's `Retry-After` header when
  present (capped at 60s); otherwise exponential backoff starting at
  2s, doubling up to 30s. Gets up to 5 attempts (more than the default
  2) since a rate limit clears on its own schedule rather than being a
  one-off glitch.
- **413 (payload too large)**: not retried at the `GroqClient` level —
  resending the identical oversized payload just fails again.
  `isPayloadTooLargeError()` lets `Agent.runPrompt()` catch it,
  force a `context.compact()`, and retry the same turn (up to 3 times)
  without burning a turn against `maxTurns`.

---

## 8. Adding a new tool

1. Define it in `src/tools/*.ts` following the `Tool` interface
   (`types.ts`) — name, JSON Schema `parameters`, `requiresConfirmation`,
   `execute()`.
2. Cap its own output before returning (don't rely solely on the
   6000-char safety net in §4 — that's a last resort, not a budget).
3. Register it in `ToolRegistry`'s constructor (`registry.ts:13-22`).
4. Mention it in `TerminalUI.printHelp()` (`terminal.ts:132`) and the
   README tool table if it's user-facing.
5. If it writes/edits files but isn't `write_file`/`edit_file`, add its
   name to `FILE_MODIFYING_TOOLS` or the check at `agent.ts:184` so
   auto-verification (§6) still triggers.

---

## 9. Publishing to npm

### The name is already taken

`package.json` currently declares `"name": "zola"`. That name exists on
the npm registry already (an unrelated package, first published 2018) —
publishing as-is will fail with `403 Forbidden - you do not have
permission to publish "zola"`. Pick one:

- **Scope it to your npm username** (fastest, no rename needed):
  ```json
  "name": "@your-npm-username/zola"
  ```
  Users then install with `npm i -g @your-npm-username/zola` and the
  binary is still invoked as `zola` (the `bin` key controls the command
  name, not the package name).
- **Rename the package** to something unclaimed (check first:
  `curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/<name>`
  — `404` means available, `200` means taken).

### Steps

```bash
# 1. Log in once (opens a browser / prompts for credentials)
npm login

# 2. Bump the version — publishing the same version twice is rejected
npm version patch   # or minor/major

# 3. Build — "files": ["dist"] in package.json means only dist/ ships,
#    so an out-of-date build silently ships stale code
npm run build

# 4. Sanity-check what will actually be published
npm pack --dry-run

# 5. Publish
npm publish                       # if you renamed the package
npm publish --access public       # if you scoped it as @you/zola — scoped
                                   # packages default to private otherwise
```

### Before you publish, worth fixing

- **No `LICENSE` file exists** despite `package.json` declaring
  `"license": "MIT"`. Not a hard blocker, but npm/GitHub both surface
  license info from that file — add one if you want it to actually show
  up as MIT-licensed on the registry page.
- **`README.md`'s model table is stale** — it lists
  `llama-3.3-70b-versatile`, `qwen-2.5-coder-32b`,
  `deepseek-r1-distill-llama-70b` as available models, but
  `config.ts`'s actual `AVAILABLE_MODELS` map only has
  `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`, and
  `qwen/qwen3.6-27b`. Since the README becomes the npm package page,
  worth reconciling these before it's public.
- **`npm run test` isn't run automatically by `npm publish`** (no
  `prepublishOnly` hook runs it — only `build` runs via
  `prepublishOnly`). Run `npm test` and `npm run typecheck` yourself
  first.

### After publishing

Verify it actually works installed fresh, in a directory that isn't
this repo (a local `npm link` can mask a packaging bug that only shows
up in a real install):

```bash
npm install -g <published-name>
cd C:\some\other\project
zola "list the files here"
```

To ship an update later: bump the version (`npm version patch`), build,
`npm publish` again — the same sequence as above.
