export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** Holds the agent's current task list across turns so a multi-step build doesn't lose track of what's left. */
export class TodoStore {
  private todos: TodoItem[] = [];

  public setTodos(todos: TodoItem[]): void {
    this.todos = todos;
  }

  public getTodos(): TodoItem[] {
    return this.todos;
  }

  public hasTodos(): boolean {
    return this.todos.length > 0;
  }

  public isAllComplete(): boolean {
    return this.todos.length > 0 && this.todos.every((t) => t.status === "completed");
  }

  public render(): string {
    if (this.todos.length === 0) {
      return "(Task list is empty)";
    }

    const marks: Record<TodoStatus, string> = {
      completed: "[x]",
      in_progress: "[~]",
      pending: "[ ]",
    };

    return this.todos.map((t) => `${marks[t.status]} ${t.content}`).join("\n");
  }
}
