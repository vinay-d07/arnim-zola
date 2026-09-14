import { Tool, ToolContext, ToolResult } from "./types.js";
import { TodoStore, TodoStatus } from "./todo_store.js";

const VALID_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed"]);

export function createTodoWriteTool(store: TodoStore): Tool {
  return {
    name: "todo_write",
    description:
      "Create or replace the structured task list for the current job. ALWAYS use this before starting any multi-step task " +
      "(scaffolding an app, implementing a feature across several files, a multi-stage refactor). Pass the FULL list of todos " +
      "every time (this replaces the previous list, it does not append). Mark exactly one item 'in_progress' at a time, and " +
      "mark items 'completed' immediately after finishing them rather than batching updates at the end. This is how you keep " +
      "track of what's left to do across many turns.",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full, current task list.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short identifier for this task." },
              content: { type: "string", description: "Description of the task." },
              status: {
                type: "string",
                description: "Current status of the task.",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(params: { todos: Array<{ id: string; content: string; status: string }> }, _context: ToolContext): Promise<ToolResult> {
      if (!Array.isArray(params.todos)) {
        return {
          success: false,
          output: "Error: 'todos' must be an array of {id, content, status}.",
          error: "Invalid todos",
        };
      }

      for (const t of params.todos) {
        if (!t.id || !t.content || !VALID_STATUSES.has(t.status as TodoStatus)) {
          return {
            success: false,
            output: `Error: invalid todo item ${JSON.stringify(t)}. Each item needs id, content, and status of pending/in_progress/completed.`,
            error: "Invalid todo item",
          };
        }
      }

      const inProgressCount = params.todos.filter((t) => t.status === "in_progress").length;
      if (inProgressCount > 1) {
        return {
          success: false,
          output: "Error: more than one todo is marked 'in_progress'. Focus on one task at a time.",
          error: "Multiple in_progress items",
        };
      }

      store.setTodos(params.todos as any);

      return {
        success: true,
        output: `Task list updated:\n${store.render()}`,
        metadata: { todos: params.todos },
      };
    },
  };
}
