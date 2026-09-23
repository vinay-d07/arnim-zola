import fs from "node:fs";
import path from "node:path";
import { ToolRegistry } from "../src/tools/registry.js";
import { ConversationContext } from "../src/agent/context.js";
import { Config, AVAILABLE_MODELS } from "../src/config/config.js";

async function runTests() {
  console.log("🧪 Starting Groq Code Test Suite...\n");
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ ${testName} - ${detail || "Assertion failed"}`);
      failed++;
    }
  }

  const testDir = path.join(process.cwd(), "tests", "scratch");
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  const registry = new ToolRegistry();
  const context = { cwd: testDir, autoApprove: true };

  // Test 1: Tool Registry
  console.log("1. Tool Registry & Schemas:");
  const tools = registry.getAllTools();
  assert(tools.length === 9, "Registered 9 built-in tools");

  const groqTools = registry.getGroqTools();
  assert(groqTools.length === 9, "Generated 9 Groq-compatible tool schemas");
  assert(
    groqTools.every((t) => t.type === "function" && t.function.name && t.function.parameters),
    "All tools conform to OpenAI/Groq function format"
  );

  // Test 2: write_file Tool
  console.log("\n2. File Tools (write_file, view_file, edit_file):");
  const sampleContent = "line 1: hello world\nline 2: foo bar\nline 3: typescript groq\n";
  const writeRes = await registry.executeTool(
    "write_file",
    { file_path: "sample.txt", content: sampleContent },
    context
  );
  assert(writeRes.success, "write_file succeeded", writeRes.output);
  assert(fs.existsSync(path.join(testDir, "sample.txt")), "File exists on disk");

  // Test 3: view_file Tool
  const viewRes = await registry.executeTool(
    "view_file",
    { file_path: "sample.txt", start_line: 1, end_line: 2 },
    context
  );
  assert(viewRes.success, "view_file succeeded");
  assert(viewRes.output.includes("line 1: hello world"), "view_file returned line 1");
  assert(viewRes.output.includes("line 2: foo bar"), "view_file returned line 2");

  // Test 4: edit_file Tool
  const editRes = await registry.executeTool(
    "edit_file",
    {
      file_path: "sample.txt",
      old_string: "line 2: foo bar",
      new_string: "line 2: modified content",
    },
    context
  );
  assert(editRes.success, "edit_file succeeded", editRes.output);
  const updatedContent = fs.readFileSync(path.join(testDir, "sample.txt"), "utf-8");
  assert(updatedContent.includes("line 2: modified content"), "edit_file correctly modified file");

  // Test 5: list_dir Tool
  console.log("\n3. Directory & Search Tools:");
  const listRes = await registry.executeTool("list_dir", { dir_path: "." }, context);
  assert(listRes.success, "list_dir succeeded");
  assert(listRes.output.includes("sample.txt"), "list_dir listed sample.txt");

  // Test 6: grep_search Tool
  const grepRes = await registry.executeTool(
    "grep_search",
    { query: "modified" },
    context
  );
  assert(grepRes.success, "grep_search succeeded");
  assert(grepRes.output.includes("sample.txt"), "grep_search found sample.txt match");

  // Test 7: find_files Tool
  const findRes = await registry.executeTool(
    "find_files",
    { pattern: "*.txt" },
    context
  );
  assert(findRes.success, "find_files succeeded");
  assert(findRes.output.includes("sample.txt"), "find_files located sample.txt");

  // Test 8: bashTool (run_command)
  console.log("\n4. Shell Tool (run_command):");
  const bashRes = await registry.executeTool(
    "run_command",
    { command: "node -e \"console.log('GROQ_CODE_TEST_OK')\"" },
    context
  );
  assert(bashRes.success, "run_command succeeded", bashRes.output);
  assert(bashRes.output.includes("GROQ_CODE_TEST_OK"), "run_command captured stdout");

  // Test 9: todo_write Tool
  console.log("\n5. Task Tracking (todo_write):");
  const todoRes = await registry.executeTool(
    "todo_write",
    { todos: [{ id: "1", content: "Set up project structure", status: "in_progress" }] },
    context
  );
  assert(todoRes.success, "todo_write succeeded", todoRes.output);
  assert(todoRes.output.includes("Set up project structure"), "todo_write output includes task content");
  assert(registry.getTodoStore().getTodos().length === 1, "TodoStore reflects the written task list");

  const badTodoRes = await registry.executeTool(
    "todo_write",
    {
      todos: [
        { id: "1", content: "Step one", status: "in_progress" },
        { id: "2", content: "Step two", status: "in_progress" },
      ],
    },
    context
  );
  assert(!badTodoRes.success, "todo_write rejects more than one in_progress item");

  // Test: scaffold_project Tool (error paths only, to keep the suite offline/network-free)
  console.log("\n6. Project Scaffolding (scaffold_project):");
  const badTemplateRes = await registry.executeTool(
    "scaffold_project",
    { template: "not-a-real-template", project_name: "whatever" },
    context
  );
  assert(!badTemplateRes.success, "scaffold_project rejects an unknown template");

  fs.mkdirSync(path.join(testDir, "existing-app"));
  const collisionRes = await registry.executeTool(
    "scaffold_project",
    { template: "vite-react-ts", project_name: "existing-app" },
    context
  );
  assert(!collisionRes.success, "scaffold_project refuses to overwrite an existing directory");

  // Test 10: Conversation Context & Compaction
  console.log("\n7. Conversation Context & Compaction:");

  // A small conversation is nowhere near the context window and should be left alone
  const smallConv = new ConversationContext(process.cwd(), "openai/gpt-oss-20b");
  smallConv.addUserMessage("First question");
  smallConv.addAssistantMessage("First answer");
  smallConv.addUserMessage("Second question");
  smallConv.addAssistantMessage(null, [{ id: "c1", type: "function", function: { name: "view_file", arguments: "{}" } }]);
  smallConv.addToolMessage("c1", "File content result");
  smallConv.addUserMessage("Third question");
  smallConv.addAssistantMessage("Third answer");

  assert(smallConv.getMessages().length > 6, "Added conversation turns");
  assert(!smallConv.shouldAutoCompact(), "Small conversation does not trigger auto-compaction");
  assert(smallConv.compact() === false, "Compact is a no-op on a small conversation");

  // A large conversation that eats into the model's context window should compact down
  const bigConv = new ConversationContext(process.cwd(), "openai/gpt-oss-20b");
  const padding = "x".repeat(12000); // large enough that 20 turns clears the 75% auto-compact threshold

  // A file write near the start of the conversation, deep enough in the "middle" range that it
  // will get summarized away by compaction — its file path must survive as a file-inventory entry.
  bigConv.addUserMessage("Create src/app.ts");
  bigConv.addAssistantMessage(null, [
    {
      id: "wc1",
      type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ file_path: "src/app.ts", content: "// app" }) },
    },
  ]);
  bigConv.addToolMessage("wc1", "Successfully wrote file");

  for (let i = 0; i < 20; i++) {
    bigConv.addUserMessage(`Question ${i}: ${padding}`);
    bigConv.addAssistantMessage(`Answer ${i}: ${padding}`);
  }
  const originalLength = bigConv.getMessages().length;
  assert(bigConv.shouldAutoCompact(), "Large conversation flagged as approaching context window limit");
  const compacted = bigConv.compact();
  assert(compacted, "Context compaction succeeded");
  assert(bigConv.getMessages().length < originalLength, "Compaction reduced message count");
  assert(!bigConv.shouldAutoCompact(), "Compaction brought context back under the threshold");

  const compactedSummary = bigConv.getMessages().find((m) => typeof m.content === "string" && m.content.includes("src/app.ts"));
  assert(!!compactedSummary, "Compaction preserves the touched-files inventory (src/app.ts) instead of losing it");
  assert(!!compactedSummary?.content?.includes("created/overwritten"), "Compacted file inventory records the action taken");

  bigConv.recordUsage(1500, 300);
  const stats = bigConv.getUsageStats();
  assert(stats.totalTokens === 1800, "Token usage tracking accurate");
  assert(stats.estimatedCost > 0, "Cost estimation computed");

  // Test 11: Config & Models
  console.log("\n8. Config & Model Management:");
  const cfg = new Config({ model: "openai/gpt-oss-120b", autoApprove: true });
  assert(cfg.model === "openai/gpt-oss-120b", "Config model set properly");
  assert(cfg.autoApprove === true, "Config autoApprove set properly");
  assert(Object.keys(AVAILABLE_MODELS).length >= 4, "Supported models available");

  const defaultCfg = new Config({ apiKey: "dummy", autoApprove: true });
  assert(defaultCfg.model === "deepseek/deepseek-v4-pro", "Default model is DeepSeek V4 Pro on Velona");
  assert(defaultCfg.getProvider().baseURL === "https://velona.in/v1", "Default model routes to the Velona OpenAI-compatible endpoint");
  assert(defaultCfg.maxTurns === 60, "Default maxTurns raised to 60 for multi-file app builds");

  // Cleanup scratch directory
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
