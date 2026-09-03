import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Tool, ToolContext, ToolResult } from "./types.js";

const isWindows = os.platform() === "win32";

export const bashTool: Tool = {
  name: "run_command",
  description:
    "Execute a shell command in the workspace terminal. Use this to run build commands, package managers, test runners, git commands, and shell utilities.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command line string to execute.",
      },
      cwd: {
        type: "string",
        description: "Optional working directory for the command (relative to workspace root).",
      },
      timeout_ms: {
        type: "number",
        description: "Maximum execution time in milliseconds (default: 60000, max: 300000).",
      },
    },
    required: ["command"],
  },
  async execute(params: { command: string; cwd?: string; timeout_ms?: number }, context: ToolContext): Promise<ToolResult> {
    try {
      const targetCwd = params.cwd ? path.resolve(context.cwd, params.cwd) : context.cwd;
      const timeout = Math.min(300000, Math.max(1000, params.timeout_ms ?? 60000));

      if (context.onConfirm && !context.autoApprove) {
        const desc = `Run terminal command:\n  $ ${params.command}\n(in: ${targetCwd})`;
        const ok = await context.onConfirm(desc);
        if (!ok) {
          return {
            success: false,
            output: `User denied permission to execute command: '${params.command}'.`,
            error: "User denied permission",
          };
        }
      }

      return new Promise<ToolResult>((resolve) => {
        const shell = isWindows ? "powershell.exe" : "bash";
        const args = isWindows ? ["-NoProfile", "-Command", params.command] : ["-c", params.command];

        let stdoutData = "";
        let stderrData = "";
        let isKilled = false;

        const child = spawn(shell, args, {
          cwd: targetCwd,
          env: {
            ...process.env,
            PAGER: "cat",
            CI: "true",
            FORCE_COLOR: "0",
          },
        });

        const timer = setTimeout(() => {
          isKilled = true;
          child.kill();
          resolve({
            success: false,
            output: `Command timed out after ${timeout / 1000}s:\n$ ${params.command}\n\nPartial stdout:\n${stdoutData}\n\nPartial stderr:\n${stderrData}`,
            error: "Execution timeout",
          });
        }, timeout);

        child.stdout.on("data", (data) => {
          stdoutData += data.toString();
          // Prevent memory issues if command prints megabytes of logs
          if (stdoutData.length > 200000) {
            stdoutData = stdoutData.slice(0, 200000) + "\n... [Output truncated at 200KB]";
            child.kill();
          }
        });

        child.stderr.on("data", (data) => {
          stderrData += data.toString();
          if (stderrData.length > 50000) {
            stderrData = stderrData.slice(0, 50000) + "\n... [Stderr truncated at 50KB]";
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            success: false,
            output: `Failed to spawn process: ${err.message}`,
            error: err.message,
          });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (isKilled) return;

          const exitCode = code ?? 0;
          let outputText = "";

          if (stdoutData.trim().length > 0) {
            outputText += stdoutData;
          }

          if (stderrData.trim().length > 0) {
            if (outputText.length > 0) outputText += "\n";
            outputText += `[STDERR]:\n${stderrData}`;
          }

          if (outputText.trim().length === 0) {
            outputText = `(Command completed with exit code ${exitCode} and no output)`;
          }

          const isSuccess = exitCode === 0;

          resolve({
            success: isSuccess,
            output: `Exit code: ${exitCode}\n\n${outputText.trim()}`,
            metadata: {
              exitCode,
              command: params.command,
              cwd: targetCwd,
            },
          });
        });
      });
    } catch (err: any) {
      return {
        success: false,
        output: `Error executing command: ${err.message}`,
        error: err.message,
      };
    }
  },
};
