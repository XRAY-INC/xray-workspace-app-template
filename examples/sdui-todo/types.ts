/** Domain model for the SDUI to-do sample (the service's own private shapes). */

export type TodoStatus = "open" | "done";
export type TodoPriority = "high" | "medium" | "low";

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  priority: TodoPriority;
  dueDate?: string;
  project?: string;
  completedOn?: string;
}
