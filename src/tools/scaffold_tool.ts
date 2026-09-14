import fs from "node:fs";
import path from "node:path";
import { Tool, ToolContext, ToolResult } from "./types.js";
import { bashTool } from "./bash_tool.js";

const TEMPLATE_COMMANDS: Record<string, (name: string) => string> = {
  "vite-react-ts": (name) => `npm create vite@latest ${name} -- --template react-ts`,
  "vite-vue-ts": (name) => `npm create vite@latest ${name} -- --template vue-ts`,
  "vite-vanilla-ts": (name) => `npm create vite@latest ${name} -- --template vanilla-ts`,
  "next": (name) =>
    `npx --yes create-next-app@latest ${name} --ts --eslint --app --no-tailwind --src-dir --import-alias "@/*" --use-npm --yes`,
  "express": (name) => `npx --yes express-generator --no-view ${name}`,
};

// 8. scaffold_project Tool
export const scaffoldProjectTool: Tool = {
  name: "scaffold_project",
  description:
    "Generate a brand-new project's boilerplate using the official scaffolding CLI for a known stack, instead of hand-writing " +
    "package.json/tsconfig/build config from memory (which is a common source of broken greenfield apps). ALWAYS prefer this " +
    "over manually authoring config files when starting a new app from scratch. Creates a new subdirectory named after the " +
    "project inside the workspace root; implement the actual feature code inside that generated directory afterwards.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      template: {
        type: "string",
        description:
          "Which official scaffolding template to use: vite-react-ts, vite-vue-ts, vite-vanilla-ts, next (Next.js), or express.",
        enum: Object.keys(TEMPLATE_COMMANDS),
      },
      project_name: {
        type: "string",
        description: "Name of the new project directory to create (no spaces).",
      },
    },
    required: ["template", "project_name"],
  },
  async execute(params: { template: string; project_name: string }, context: ToolContext): Promise<ToolResult> {
    const builder = TEMPLATE_COMMANDS[params.template];
    if (!builder) {
      return {
        success: false,
        output: `Unknown template '${params.template}'. Available: ${Object.keys(TEMPLATE_COMMANDS).join(", ")}`,
        error: "Unknown template",
      };
    }

    if (!params.project_name || /[\\/\s]/.test(params.project_name)) {
      return {
        success: false,
        output: `Error: '${params.project_name}' is not a valid project directory name (no spaces or path separators).`,
        error: "Invalid project name",
      };
    }

    const targetDir = path.join(context.cwd, params.project_name);
    if (fs.existsSync(targetDir)) {
      return {
        success: false,
        output: `Error: '${params.project_name}' already exists in the workspace. Choose a different name or remove it first.`,
        error: "Directory exists",
      };
    }

    const command = builder(params.project_name);

    if (context.onConfirm && !context.autoApprove) {
      const ok = await context.onConfirm(
        `Scaffold a new '${params.template}' project named '${params.project_name}':\n  $ ${command}`
      );
      if (!ok) {
        return {
          success: false,
          output: `User denied permission to scaffold project '${params.project_name}'.`,
          error: "User denied permission",
        };
      }
    }

    const result = await bashTool.execute(
      { command, timeout_ms: 180000 },
      { cwd: context.cwd, autoApprove: true }
    );

    if (!result.success) {
      return {
        success: false,
        output: `Scaffolding command failed:\n${result.output}`,
        error: "Scaffold command failed",
      };
    }

    return {
      success: true,
      output:
        `Scaffolded '${params.template}' project into '${params.project_name}/'.\n\n${result.output}\n\n` +
        `Next: list_dir/view_file into '${params.project_name}' to see what was generated, install dependencies, ` +
        `then implement the app's actual features there rather than rewriting the generated boilerplate.`,
      metadata: { projectDir: targetDir, template: params.template },
    };
  },
};
