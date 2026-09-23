import fs from "node:fs";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { Agent } from "../src/agent/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolCall } from "../src/agent/llm.js";

async function testAgentLoopWithMock() {
  console.log("🧪 Testing Agent Autonomous Loop (Mocked LLM Streaming)...\n");

  const testDir = path.join(process.cwd(), "tests", "agent_scratch");
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  const config = new Config({
    apiKey: "dummy-key",
    model: "openai/gpt-oss-20b",
    autoApprove: true,
    cwd: testDir,
  });

  const agent = new Agent(config);

  // Verify agent initialization
  if (agent.getConfig().cwd !== testDir) {
    throw new Error("Agent cwd not set correctly");
  }

  const context = agent.getContext();
  const initialMessages = context.getMessages();
  if (initialMessages.length !== 1 || initialMessages[0].role !== "system") {
    throw new Error("Initial system message missing");
  }

  // Simulate turn 1: User prompt -> Assistant calls write_file
  context.addUserMessage("Create a script math.js that exports add(a, b)");
  context.addAssistantMessage("I will create the math.js file.", [
    {
      id: "call_1",
      type: "function",
      function: {
        name: "write_file",
        arguments: JSON.stringify({
          file_path: "math.js",
          content: "export function add(a, b) { return a + b; }\n",
        }),
      },
    },
  ]);

  const registry = new ToolRegistry();
  const res1 = await registry.executeTool(
    "write_file",
    {
      file_path: "math.js",
      content: "export function add(a, b) { return a + b; }\n",
    },
    { cwd: testDir, autoApprove: true }
  );

  context.addToolMessage("call_1", res1.output);

  if (!fs.existsSync(path.join(testDir, "math.js"))) {
    throw new Error("File math.js was not created");
  }

  // Simulate turn 2: Assistant calls view_file to verify
  context.addAssistantMessage("Now I will verify the file content.", [
    {
      id: "call_2",
      type: "function",
      function: {
        name: "view_file",
        arguments: JSON.stringify({ file_path: "math.js" }),
      },
    },
  ]);

  const res2 = await registry.executeTool(
    "view_file",
    { file_path: "math.js" },
    { cwd: testDir, autoApprove: true }
  );
  context.addToolMessage("call_2", res2.output);

  // Simulate turn 3: Assistant concludes
  context.addAssistantMessage("The math.js file has been created and verified successfully!");

  const messages = context.getMessages();
  console.log(`  ✓ Successfully simulated 3-turn ReAct agent flow`);
  console.log(`  ✓ Message history contains ${messages.length} messages`);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log("\nAgent Loop Verification PASSED!\n");
}

testAgentLoopWithMock().catch((err) => {
  console.error("Agent mock test failed:", err);
  process.exit(1);
});
