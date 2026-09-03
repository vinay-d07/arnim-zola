import { Tool, ToolContext, ToolResult, GroqToolFunction } from "./types.js";
import { viewFileTool, writeFileTool, editFileTool, listDirTool } from "./file_tools.js";
import { grepSearchTool, findFilesTool } from "./search_tools.js";
import { bashTool } from "./bash_tool.js";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    this.registerTool(viewFileTool);
    this.registerTool(writeFileTool);
    this.registerTool(editFileTool);
    this.registerTool(listDirTool);
    this.registerTool(grepSearchTool);
    this.registerTool(findFilesTool);
    this.registerTool(bashTool);
  }

  public registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  public getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  public getGroqTools(): GroqToolFunction[] {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  public async executeTool(
    name: string,
    params: any,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: `Error: Tool '${name}' not found. Available tools: ${Array.from(this.tools.keys()).join(", ")}`,
        error: "Tool not found",
      };
    }

    try {
      return await tool.execute(params, context);
    } catch (err: any) {
      return {
        success: false,
        output: `Error executing tool '${name}': ${err.message}`,
        error: err.message,
      };
    }
  }
}
