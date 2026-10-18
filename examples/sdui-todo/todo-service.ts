/**
 * The headless to-do service.
 *
 * This module IS the product. It ships no UI — it answers the three SDUI
 * endpoints as pure functions over data:
 *
 *   listPages(ctx)                → GET  /api/v1/pages
 *   getPage(pageId, ctx)          → GET  /api/v1/pages/{id}
 *   runAction(actionId, in, ctx)  → POST /api/v1/actions/{id}
 *
 * Everything it returns is validated `PageDocument` / `ActionResult` JSON. The
 * workspace renders it; no React, CSS, or HTML lives here. Actions are
 * idempotent-friendly (the caller supplies an Idempotency-Key at the BFF hop).
 */

import { PageDocument, PageRef, ActionResult, type Block } from "./blocks";
import { TodoNotFoundError } from "./todo-repository";
import type { CreateTodoInput, RepositoryResult, TodoRepository } from "./todo-repository";
import type { Todo, TodoPriority } from "./types";

export interface ServiceContext {
  email: string;
  repo: TodoRepository;
  /** Set when the live tasks API was unavailable and seed data is standing in. */
  notice?: string;
}

export const PAGES: PageRef[] = [
  { id: "today", title: "Today", icon: "list-todo", order: 1 },
  { id: "insights", title: "Insights", icon: "bar-chart", order: 2 },
];

export function listPages(): PageRef[] {
  return PAGES;
}

/* --------------------------------------------------------------- helpers */

const PRIORITY_TONE: Record<TodoPriority, "critical" | "warning" | "neutral"> = {
  high: "critical",
  medium: "warning",
  low: "neutral",
};

const PRIORITY_LABEL: Record<TodoPriority, string> = { high: "High", medium: "Medium", low: "Low" };

function todoListItem(todo: Todo): Block {
  const done = todo.status === "done";
  return {
    type: "list",
    items: [
      {
        title: todo.title,
        body:
          [todo.project, todo.dueDate ? `Due ${todo.dueDate}` : null].filter(Boolean).join(" · ") ||
          undefined,
        badge: done
          ? { text: "Done", tone: "good" as const }
          : { text: PRIORITY_LABEL[todo.priority], tone: PRIORITY_TONE[todo.priority] },
        actions: [
          done
            ? { id: `reopen:${todo.id}`, label: "Reopen", style: "secondary" as const }
            : { id: `complete:${todo.id}`, label: "Complete", style: "primary" as const },
        ],
      },
    ],
  };
}

/** Group consecutive todos into a single list block for tidier rendering. */
function todoList(todos: Todo[], empty: string): Block {
  if (todos.length === 0) return { type: "list", items: [], empty };
  const done = (t: Todo) => t.status === "done";
  return {
    type: "list",
    items: todos.map((todo) => ({
      title: todo.title,
      body:
        [todo.project, todo.dueDate ? `Due ${todo.dueDate}` : null].filter(Boolean).join(" · ") ||
        undefined,
      badge: done(todo)
        ? { text: "Done", tone: "good" as const }
        : { text: PRIORITY_LABEL[todo.priority], tone: PRIORITY_TONE[todo.priority] },
      actions: [
        done(todo)
          ? { id: `reopen:${todo.id}`, label: "Reopen", style: "secondary" as const }
          : {
              id: `complete:${todo.id}`,
              label: "Complete",
              style: "primary" as const,
              confirm: undefined,
            },
      ],
    })),
    empty,
  };
}

function completionsByDay(todos: Todo[]): { label: string; value: number }[] {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const counts = new Map<string, number>(days.map((d) => [d, 0]));
  // Deterministic demo distribution keyed off completedOn's day; falls back to
  // spreading completed items across the week so the chart is never empty.
  const done = todos.filter((t) => t.status === "done");
  done.forEach((t, i) => {
    const day = days[(t.completedOn ? new Date(t.completedOn).getDay() + 6 : i) % 7];
    counts.set(day, (counts.get(day) ?? 0) + 1);
  });
  return days.map((d) => ({ label: d, value: counts.get(d) ?? 0 }));
}

/* ----------------------------------------------------------------- pages */

function todayPage(ctx: ServiceContext, todos: Todo[]): PageDocument {
  const open = todos.filter((t) => t.status === "open");
  const done = todos.filter((t) => t.status === "done");
  const dueToday = open.filter((t) => t.dueDate === "2026-07-13" || t.dueDate === "2026-07-14");

  const blocks: Block[] = [
    { type: "heading", text: "Today", level: 2 },
    {
      type: "text",
      md: `You have **${open.length}** open task${open.length === 1 ? "" : "s"}. Keep the migration moving.`,
      emphasis: "muted",
    },
  ];

  if (ctx.notice) {
    blocks.push({
      type: "card",
      title: "Sample data",
      body: ctx.notice,
      icon: "inbox",
      accent: "amber",
    });
  }

  blocks.push(
    {
      type: "statGroup",
      stats: [
        {
          label: "Open",
          value: String(open.length),
          emphasis: "strong",
          icon: "circle",
          trend: undefined,
        },
        {
          label: "Due soon",
          value: String(dueToday.length),
          emphasis: "default",
          icon: "clock",
          trend: dueToday.length ? "up" : "flat",
        },
        {
          label: "Completed",
          value: String(done.length),
          emphasis: "default",
          icon: "check-circle",
          trend: "up",
        },
      ],
    },
    { type: "divider" },
    {
      type: "form",
      fields: [
        {
          kind: "text",
          id: "title",
          label: "New task",
          placeholder: "e.g. Rotate GUARDIAN_SIGNING_KEY",
          required: true,
        },
        {
          kind: "select",
          id: "priority",
          label: "Priority",
          options: [
            { value: "high", label: "High" },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
          ],
        },
      ],
      submit: { id: "create", label: "Add task", style: "primary", input: ["title", "priority"] },
    },
    { type: "divider" },
    {
      type: "tabs",
      tabs: [
        {
          id: "active",
          title: `Active (${open.length})`,
          blocks: [todoList(open, "Nothing open — inbox zero. 🎉")],
        },
        {
          id: "completed",
          title: `Completed (${done.length})`,
          blocks: [todoList(done, "No completed tasks yet.")],
        },
      ],
    },
  );

  // `title` is the workspace's top bar; `subtitle` the line under it.
  return { blockVersion: "v1", title: "Today", subtitle: `Your to-dos, as ${ctx.email}`, blocks };
}

function insightsPage(_ctx: ServiceContext, todos: Todo[]): PageDocument {
  const open = todos.filter((t) => t.status === "open");
  const byProject = new Map<string, { open: number; done: number }>();
  todos.forEach((t) => {
    const key = t.project ?? "—";
    const row = byProject.get(key) ?? { open: 0, done: 0 };
    if (t.status === "done") row.done += 1;
    else row.open += 1;
    byProject.set(key, row);
  });

  const priorityCounts = (["high", "medium", "low"] as const).map((p) => ({
    label: PRIORITY_LABEL[p],
    value: open.filter((t) => t.priority === p).length,
    tone:
      PRIORITY_TONE[p] === "critical"
        ? ("critical" as const)
        : PRIORITY_TONE[p] === "warning"
          ? ("warning" as const)
          : ("neutral" as const),
  }));

  const blocks: Block[] = [
    { type: "heading", text: "Insights", level: 2 },
    { type: "text", md: "Completion trend and where the open work sits.", emphasis: "muted" },
    {
      type: "chart",
      chartType: "bar",
      title: "Completed this week",
      unit: "tasks",
      accent: "teal",
      points: completionsByDay(todos),
    },
    {
      type: "chart",
      chartType: "donut",
      title: "Open work by priority",
      accent: "violet",
      points: priorityCounts,
    },
    { type: "heading", text: "By project", level: 3 },
    {
      type: "table",
      columns: [
        { key: "project", label: "Project", align: "left" },
        { key: "open", label: "Open", align: "right" },
        { key: "done", label: "Done", align: "right" },
      ],
      rows: [...byProject.entries()].map(([project, r]) => ({
        project,
        open: r.open,
        done: r.done,
      })),
    },
  ];

  return { blockVersion: "v1", title: "Insights", blocks };
}

/* ---------------------------------------------------------------- getPage */

export async function getPage(pageId: string, ctx: ServiceContext): Promise<PageDocument> {
  const todos = await ctx.repo.list(ctx.email);
  const doc = pageId === "insights" ? insightsPage(ctx, todos) : todayPage(ctx, todos);
  // Validate before returning — the contract is the certification surface.
  return PageDocument.parse(doc);
}

/* -------------------------------------------------------------- runAction */

/** `actionId` encodes the verb and target: `complete:t3`, `reopen:t3`, `create`. */
export async function runAction(
  actionId: string,
  input: Record<string, string>,
  ctx: ServiceContext,
): Promise<ActionResult> {
  const [verb, target] = actionId.split(":");

  if (verb === "create") {
    const title = (input.title ?? "").trim();
    if (title.length < 2) {
      // Surfaced to the shell as a user-safe validation toast.
      throw new ServiceError("VALIDATION_ERROR", "Enter a task title (at least 2 characters).");
    }
    const created: CreateTodoInput = {
      title,
      priority: (input.priority as CreateTodoInput["priority"]) ?? "medium",
    };
    await ctx.repo.create(ctx.email, created);
    return ActionResult.parse({ result: "ok", refresh: true, toast: "Task added" });
  }

  if (verb === "complete" || verb === "reopen") {
    if (!target) throw new ServiceError("VALIDATION_ERROR", "Missing task id.");
    // `target` is a CLIENT-SUPPLIED id split out of the action id, so the
    // repository authorizes it against `ctx.email` before writing. A record
    // owned by someone else surfaces as NOT_FOUND — never "forbidden", which
    // would confirm the id exists to whoever guessed it.
    try {
      await ctx.repo.setStatus(ctx.email, target, verb === "complete" ? "done" : "open");
    } catch (error) {
      if (error instanceof TodoNotFoundError) {
        throw new ServiceError("NOT_FOUND", "No such task.");
      }
      throw error;
    }
    return ActionResult.parse({
      result: "ok",
      refresh: true,
      toast: verb === "complete" ? "Marked complete" : "Reopened",
    });
  }

  throw new ServiceError("NOT_FOUND", "Unknown action.");
}

export class ServiceError extends Error {
  constructor(
    readonly code: "VALIDATION_ERROR" | "NOT_FOUND" | "UNAUTHORIZED",
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Convenience for the demo harness: build a context from a resolved repo. */
export function contextFrom(email: string, resolved: RepositoryResult): ServiceContext {
  return { email, repo: resolved.repo, notice: resolved.notice };
}
