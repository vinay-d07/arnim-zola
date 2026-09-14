import fs from "node:fs";
import path from "node:path";
import * as diff from "diff";
import chalk from "chalk";
import { Tool, ToolContext, ToolResult } from "./types.js";

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }
  return path.normalize(path.join(cwd, filePath));
}

// 1. view_file Tool
export const viewFileTool: Tool = {
  name: "view_file",
  description:
    "View the contents of a file in the workspace. Supports viewing specific line ranges (1-indexed). Returns line-numbered content.",
  requiresConfirmation: false,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to view (relative to workspace or absolute).",
      },
      start_line: {
        type: "number",
        description: "Optional 1-indexed line number to start reading from.",
      },
      end_line: {
        type: "number",
        description: "Optional 1-indexed line number to end reading at.",
      },
    },
    required: ["file_path"],
  },
  async execute(params: { file_path: string; start_line?: number; end_line?: number }, context: ToolContext): Promise<ToolResult> {
    try {
      const fullPath = resolvePath(params.file_path, context.cwd);

      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          output: `Error: File not found at '${params.file_path}' (resolved: '${fullPath}')`,
          error: "File not found",
        };
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return {
          success: false,
          output: `Error: '${params.file_path}' is a directory, not a file. Use 'list_dir' instead.`,
          error: "Is a directory",
        };
      }

      const rawContent = fs.readFileSync(fullPath, "utf-8");
      const lines = rawContent.split(/\r?\n/);
      const totalLines = lines.length;
      const MAX_DEFAULT_LINES = 2000;

      let start = params.start_line ? Math.max(1, params.start_line) : 1;
      let end = params.end_line ? Math.min(totalLines, params.end_line) : totalLines;

      if (start > totalLines) {
        return {
          success: true,
          output: `File '${params.file_path}' has ${totalLines} lines. Requested start_line ${start} is beyond end of file.`,
        };
      }

      if (start > end) {
        start = end;
      }

      // Guard against dumping huge files into the model's context window when no explicit range was requested
      let truncationNotice = "";
      if (!params.start_line && !params.end_line && end - start + 1 > MAX_DEFAULT_LINES) {
        end = start + MAX_DEFAULT_LINES - 1;
        truncationNotice = `\n\n[Truncated: showing lines ${start}-${end} of ${totalLines}. Pass start_line/end_line to view a different range.]`;
      }

      const selectedLines = lines.slice(start - 1, end);
      const formatted = selectedLines
        .map((line, idx) => {
          const lineNum = (start + idx).toString().padStart(4, " ");
          return `${lineNum} | ${line}`;
        })
        .join("\n");

      return {
        success: true,
        output: `File: ${params.file_path} (Lines ${start}-${end} of ${totalLines}, ${stat.size} bytes)\n\n${formatted}${truncationNotice}`,
        metadata: {
          filePath: fullPath,
          totalLines,
          startLine: start,
          endLine: end,
          size: stat.size,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to view file '${params.file_path}': ${err.message}`,
        error: err.message,
      };
    }
  },
};

// 2. write_file Tool
export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing file with the provided content.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to write (relative or absolute).",
      },
      content: {
        type: "string",
        description: "The full content to write to the file.",
      },
    },
    required: ["file_path", "content"],
  },
  async execute(params: { file_path: string; content: string }, context: ToolContext): Promise<ToolResult> {
    try {
      const fullPath = resolvePath(params.file_path, context.cwd);
      const exists = fs.existsSync(fullPath);

      if (context.onConfirm && !context.autoApprove) {
        const desc = exists
          ? `Overwrite existing file '${params.file_path}' (${Buffer.byteLength(params.content, "utf-8")} bytes)`
          : `Create new file '${params.file_path}' (${Buffer.byteLength(params.content, "utf-8")} bytes)`;
        const ok = await context.onConfirm(desc);
        if (!ok) {
          return {
            success: false,
            output: `User denied permission to write to file '${params.file_path}'.`,
            error: "User denied permission",
          };
        }
      }

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, params.content, "utf-8");
      const lineCount = params.content.split(/\r?\n/).length;
      const byteCount = Buffer.byteLength(params.content, "utf-8");

      return {
        success: true,
        output: `Successfully wrote ${byteCount} bytes (${lineCount} lines) to '${params.file_path}'.`,
        metadata: {
          filePath: fullPath,
          bytesWritten: byteCount,
          linesWritten: lineCount,
          isNew: !exists,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to write to file '${params.file_path}': ${err.message}`,
        error: err.message,
      };
    }
  },
};

// 3. edit_file Tool
export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Make precise edits to an existing file by replacing an exact string/code block ('old_string') with a new string/code block ('new_string'). Ensure old_string matches the original file text exactly.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to edit.",
      },
      old_string: {
        type: "string",
        description: "The exact text block in the file to be replaced.",
      },
      new_string: {
        type: "string",
        description: "The new text block that will replace 'old_string'.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async execute(params: { file_path: string; old_string: string; new_string: string }, context: ToolContext): Promise<ToolResult> {
    try {
      const fullPath = resolvePath(params.file_path, context.cwd);

      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          output: `Error: File not found at '${params.file_path}'`,
          error: "File not found",
        };
      }

      const originalContent = fs.readFileSync(fullPath, "utf-8");

      // Normalize line endings for reliable matching
      const normalizedOriginal = originalContent.replace(/\r\n/g, "\n");
      const normalizedOld = params.old_string.replace(/\r\n/g, "\n");
      const normalizedNew = params.new_string.replace(/\r\n/g, "\n");

      if (!normalizedOriginal.includes(normalizedOld)) {
        return {
          success: false,
          output: `Error: 'old_string' was not found in '${params.file_path}'. Make sure whitespace, indentation, and characters match the file content exactly. Use 'view_file' to check current content.`,
          error: "old_string not found",
        };
      }

      const occurrences = normalizedOriginal.split(normalizedOld).length - 1;
      if (occurrences > 1) {
        return {
          success: false,
          output: `Error: 'old_string' occurred ${occurrences} times in '${params.file_path}'. Please provide more surrounding lines in 'old_string' to make the match unique.`,
          error: "Ambiguous old_string",
        };
      }

      const updatedContent = normalizedOriginal.replace(normalizedOld, normalizedNew);

      // Create unified diff representation for preview
      const patch = diff.createPatch(params.file_path, normalizedOriginal, updatedContent);

      if (context.onConfirm && !context.autoApprove) {
        const desc = `Edit file '${params.file_path}':\n${patch}`;
        const ok = await context.onConfirm(desc);
        if (!ok) {
          return {
            success: false,
            output: `User denied permission to edit '${params.file_path}'.`,
            error: "User denied permission",
          };
        }
      }

      fs.writeFileSync(fullPath, updatedContent, "utf-8");

      return {
        success: true,
        output: `Successfully edited '${params.file_path}'.\n\nDiff:\n${patch}`,
        metadata: {
          filePath: fullPath,
          patch,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to edit file '${params.file_path}': ${err.message}`,
        error: err.message,
      };
    }
  },
};

// 4. list_dir Tool
export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "List contents of a directory in the workspace as a tree, including file sizes and directory indicators.",
  requiresConfirmation: false,
  parameters: {
    type: "object",
    properties: {
      dir_path: {
        type: "string",
        description: "The directory path to list (defaults to current directory '.').",
      },
      max_depth: {
        type: "number",
        description: "Maximum depth to recurse into subdirectories (default: 2, max: 5).",
      },
      show_hidden: {
        type: "boolean",
        description: "Whether to include hidden files (files starting with .). Default: false.",
      },
    },
  },
  async execute(params: { dir_path?: string; max_depth?: number; show_hidden?: boolean }, context: ToolContext): Promise<ToolResult> {
    try {
      const targetDir = resolvePath(params.dir_path || ".", context.cwd);

      if (!fs.existsSync(targetDir)) {
        return {
          success: false,
          output: `Error: Directory not found at '${params.dir_path || "."}'`,
          error: "Directory not found",
        };
      }

      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return {
          success: false,
          output: `Error: '${params.dir_path}' is a file, not a directory. Use 'view_file' instead.`,
          error: "Not a directory",
        };
      }

      const maxDepth = Math.min(5, Math.max(1, params.max_depth ?? 2));
      const showHidden = params.show_hidden ?? false;
      const ignoredDirs = new Set(["node_modules", ".git", "dist", ".next", ".cache", "build"]);

      let countFiles = 0;
      let countDirs = 0;

      function renderTree(dir: string, currentDepth: number, prefix: string): string[] {
        if (currentDepth > maxDepth) return [];

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e: any) {
          return [`${prefix}└── [Error reading: ${e.message}]`];
        }

        // Filter hidden and ignored directories
        entries = entries.filter((e) => {
          if (!showHidden && e.name.startsWith(".")) return false;
          if (e.isDirectory() && ignoredDirs.has(e.name)) return false;
          return true;
        });

        // Sort: directories first, then alphabetical
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        const lines: string[] = [];

        entries.forEach((entry, idx) => {
          const isLast = idx === entries.length - 1;
          const branch = isLast ? "└── " : "├── ";
          const childPrefix = prefix + (isLast ? "    " : "│   ");
          const entryPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            countDirs++;
            lines.push(`${prefix}${branch}📁 ${entry.name}/`);
            if (currentDepth < maxDepth) {
              lines.push(...renderTree(entryPath, currentDepth + 1, childPrefix));
            }
          } else {
            countFiles++;
            let sizeStr = "";
            try {
              const fileStat = fs.statSync(entryPath);
              sizeStr = ` (${formatBytes(fileStat.size)})`;
            } catch {
              // Ignore stat failure
            }
            lines.push(`${prefix}${branch}📄 ${entry.name}${sizeStr}`);
          }
        });

        return lines;
      }

      const treeLines = renderTree(targetDir, 1, "");
      const relativeRoot = path.relative(context.cwd, targetDir) || ".";
      const header = `Directory tree for '${relativeRoot}':\n`;
      const footer = `\n\nTotal: ${countDirs} directories, ${countFiles} files (depth: ${maxDepth})`;

      return {
        success: true,
        output: header + (treeLines.length > 0 ? treeLines.join("\n") : "(Empty directory)") + footer,
        metadata: {
          dirPath: targetDir,
          directories: countDirs,
          files: countFiles,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to list directory: ${err.message}`,
        error: err.message,
      };
    }
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
