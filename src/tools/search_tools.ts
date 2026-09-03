import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Tool, ToolContext, ToolResult } from "./types.js";

function isTextFile(filePath: string): boolean {
  const binaryExtensions = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg",
    ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".mp3", ".mp4", ".wav", ".avi", ".mov",
    ".woff", ".woff2", ".ttf", ".eot",
    ".node", ".pyc"
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return !binaryExtensions.has(ext);
}

// 1. grep_search Tool
export const grepSearchTool: Tool = {
  name: "grep_search",
  description:
    "Search for a pattern (text or regular expression) across all text files in the workspace. Returns matching file paths, line numbers, and matching lines.",
  requiresConfirmation: false,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The text or regex pattern to search for.",
      },
      path: {
        type: "string",
        description: "Subdirectory or file to limit the search to (default: entire workspace).",
      },
      is_regex: {
        type: "boolean",
        description: "Whether to treat query as a regular expression. Default: false.",
      },
      case_sensitive: {
        type: "boolean",
        description: "Whether the search is case sensitive. Default: false.",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matching lines to return (default: 50).",
      },
    },
    required: ["query"],
  },
  async execute(params: {
    query: string;
    path?: string;
    is_regex?: boolean;
    case_sensitive?: boolean;
    max_results?: number;
  }, context: ToolContext): Promise<ToolResult> {
    try {
      const searchDir = params.path ? path.resolve(context.cwd, params.path) : context.cwd;
      const maxResults = Math.min(100, Math.max(1, params.max_results ?? 50));
      const flags = params.case_sensitive ? "g" : "gi";

      let regex: RegExp;
      try {
        regex = params.is_regex
          ? new RegExp(params.query, flags)
          : new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      } catch (err: any) {
        return {
          success: false,
          output: `Invalid search pattern: ${err.message}`,
          error: "Invalid pattern",
        };
      }

      if (!fs.existsSync(searchDir)) {
        return {
          success: false,
          output: `Search path not found: '${params.path || "."}'`,
          error: "Path not found",
        };
      }

      const files = await fg("**/*", {
        cwd: searchDir,
        dot: false,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/build/**"],
        onlyFiles: true,
        absolute: true,
      });

      const matches: { file: string; line: number; content: string }[] = [];

      for (const file of files) {
        if (!isTextFile(file)) continue;

        try {
          const content = fs.readFileSync(file, "utf-8");
          const lines = content.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            regex.lastIndex = 0;
            if (regex.test(line)) {
              const relPath = path.relative(context.cwd, file);
              matches.push({
                file: relPath,
                line: i + 1,
                content: line.trim(),
              });

              if (matches.length >= maxResults) {
                break;
              }
            }
          }
        } catch {
          // Ignore read errors for unreadable files
        }

        if (matches.length >= maxResults) break;
      }

      if (matches.length === 0) {
        return {
          success: true,
          output: `No matches found for '${params.query}' in '${params.path || "."}'.`,
          metadata: { matchCount: 0 },
        };
      }

      const formatted = matches
        .map((m) => `${m.file}:${m.line} | ${m.content}`)
        .join("\n");

      const header = `Found ${matches.length}${matches.length >= maxResults ? "+" : ""} matches for '${params.query}':\n\n`;

      return {
        success: true,
        output: header + formatted,
        metadata: {
          matchCount: matches.length,
          matches,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Grep search failed: ${err.message}`,
        error: err.message,
      };
    }
  },
};

// 2. find_files Tool
export const findFilesTool: Tool = {
  name: "find_files",
  description:
    "Find files and directories matching a glob pattern (e.g. '**/*.ts', 'src/**/*.json', '*config*').",
  requiresConfirmation: false,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match (e.g. '**/*.js', 'src/**/*.tsx').",
      },
      dir_path: {
        type: "string",
        description: "The root directory to search within (default: current workspace).",
      },
      max_results: {
        type: "number",
        description: "Maximum number of paths to return (default: 50).",
      },
    },
    required: ["pattern"],
  },
  async execute(params: { pattern: string; dir_path?: string; max_results?: number }, context: ToolContext): Promise<ToolResult> {
    try {
      const searchDir = params.dir_path ? path.resolve(context.cwd, params.dir_path) : context.cwd;
      const maxResults = Math.min(100, Math.max(1, params.max_results ?? 50));

      if (!fs.existsSync(searchDir)) {
        return {
          success: false,
          output: `Directory not found: '${params.dir_path || "."}'`,
          error: "Directory not found",
        };
      }

      const entries = await fg(params.pattern, {
        cwd: searchDir,
        dot: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**"],
        onlyFiles: false,
      });

      const sliced = entries.slice(0, maxResults);

      if (sliced.length === 0) {
        return {
          success: true,
          output: `No files found matching pattern '${params.pattern}' in '${params.dir_path || "."}'.`,
          metadata: { count: 0 },
        };
      }

      const outputList = sliced.map((e) => `- ${e}`).join("\n");
      const summary = `Found ${entries.length} match(es) for '${params.pattern}':\n\n${outputList}`;

      return {
        success: true,
        output: summary,
        metadata: {
          count: entries.length,
          files: sliced,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `File search failed: ${err.message}`,
        error: err.message,
      };
    }
  },
};
