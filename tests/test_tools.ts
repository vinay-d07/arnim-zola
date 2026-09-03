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
  assert(tools.length === 7, "Registered 7 built-in tools");

  const groqTools = registry.getGroqTools();
  assert(groqTools.length === 7, "Generated 7 Groq-compatible tool schemas");
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

  // Test 9: Conversation Context & Compaction
  console.log("\n5. Conversation Context & Compaction:");
  const conv = new ConversationContext(process.cwd(), "openai/gpt-oss-20b");
  conv.addUserMessage("First question");
  conv.addAssistantMessage("First answer");
  conv.addUserMessage("Second question");
  conv.addAssistantMessage(null, [{ id: "c1", type: "function", function: { name: "view_file", arguments: "{}" } }]);
  conv.addToolMessage("c1", "File content result");
  conv.addUserMessage("Third question");
  conv.addAssistantMessage("Third answer");

  assert(conv.getMessages().length > 6, "Added conversation turns");
  const compacted = conv.compact();
  assert(compacted, "Context compaction succeeded");
  conv.recordUsage(1500, 300);
  const stats = conv.getUsageStats();
  assert(stats.totalTokens === 1800, "Token usage tracking accurate");
  assert(stats.estimatedCost > 0, "Cost estimation computed");

  // Test 10: Config & Models
  console.log("\n6. Config & Model Management:");
  const cfg = new Config({ model: "openai/gpt-oss-120b", autoApprove: true });
  assert(cfg.model === "openai/gpt-oss-120b", "Config model set properly");
  assert(cfg.autoApprove === true, "Config autoApprove set properly");
  assert(Object.keys(AVAILABLE_MODELS).length >= 4, "Supported models available");

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
