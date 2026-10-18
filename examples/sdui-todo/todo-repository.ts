/**
 * Data layer for the SDUI to-do sample.
 *
 * The service logic (`todo-service.ts`) depends only on the `TodoRepository`
 * interface, so the same page-producing code runs against either:
 *
 *   - `tasksApiRepository` — an adapter over an upstream tasks API you already
 *     have (anything shaped like `TasksClientLike`), mapping its rows to the
 *     sample's `Todo` shape; or
 *   - `seedRepository` — an in-memory dataset so the demo runs with zero
 *     configuration.
 *
 * `resolveRepository()` tries the upstream client and transparently falls back
 * to seed data, reporting which one served via `RepositoryResult.source`: an
 * honest degradation, never a silent one.
 *
 * ── The tenancy rule this file exists to demonstrate
 *
 * Every method takes `email` FIRST because it is the tenant key, not a label.
 * The workspace has already proved that identity — it arrives in the verified
 * identity token (`server.mjs` `resolveIdentity`), never from a query hint —
 * and a repository that accepts it and then ignores it hands the caller an
 * IDOR: the record id alone would decide what gets read or written.
 *
 * Reads scope by construction (`fetchTasks({ email })` only ever returns the
 * caller's rows). WRITES CANNOT: `updateTask(id, …)` is addressed by id, so the
 * id must be proved to belong to the caller BEFORE the write. Read the record,
 * check ownership, and answer 404 (never 403, which would confirm the id
 * exists) — which is what {@link tasksApiRepository} does below.
 * `todo-contract.test.ts` holds that line.
 */

import type { Todo, TodoPriority, TodoStatus } from "./types";

/**
 * The record does not exist *for this caller* — either it is absent or it
 * belongs to someone else. Deliberately ONE error for both cases: a distinct
 * "forbidden" would confirm the id exists to a caller probing for it, which is
 * why the workspace's own task route answers 404 rather than 403.
 */
export class TodoNotFoundError extends Error {
  constructor(readonly id: string) {
    super("NOT_FOUND");
    this.name = "TodoNotFoundError";
  }
}

export interface CreateTodoInput {
  title: string;
  priority?: TodoPriority;
  dueDate?: string;
}

export interface TodoRepository {
  /** The caller's own records. Never another tenant's. */
  list(email: string): Promise<Todo[]>;
  /** Creates a record OWNED BY `email` — the owner is not taken from `input`. */
  create(email: string, input: CreateTodoInput): Promise<Todo>;
  /**
   * Mutates `id` only if `email` owns it. Throws {@link TodoNotFoundError}
   * otherwise — the id alone is never sufficient authority.
   */
  setStatus(email: string, id: string, status: TodoStatus): Promise<Todo>;
}

/* ----------------------------------------------------------- seed fallback */

const SEED: Todo[] = [
  {
    id: "t1",
    title: "Draft the onboarding checklist",
    status: "open",
    priority: "high",
    dueDate: "2026-07-14",
    project: "Launch",
  },
  {
    id: "t2",
    title: "Serve /api/v1/health from the new service",
    status: "open",
    priority: "high",
    dueDate: "2026-07-15",
    project: "Launch",
  },
  {
    id: "t3",
    title: "Write the app's manifest",
    status: "open",
    priority: "medium",
    dueDate: "2026-07-16",
    project: "Launch",
  },
  {
    id: "t4",
    title: "Retire the old import script",
    status: "open",
    priority: "low",
    dueDate: "2026-07-22",
    project: "Launch",
  },
  {
    id: "t5",
    title: "Review the block vocabulary",
    status: "done",
    priority: "medium",
    project: "Platform",
    completedOn: "2026-07-12",
  },
  {
    id: "t6",
    title: "Publish the notification event",
    status: "done",
    priority: "high",
    project: "Launch",
    completedOn: "2026-07-11",
  },
  {
    id: "t7",
    title: "Confirm the token clock settings",
    status: "done",
    priority: "high",
    project: "Security",
    completedOn: "2026-07-10",
  },
  {
    id: "t8",
    title: "Rebase the branch on main",
    status: "done",
    priority: "low",
    project: "Platform",
    completedOn: "2026-07-13",
  },
];

/** The tenant key. One place, so every method agrees on what "same user" means. */
function tenantKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * In-memory fallback. Each identity gets its OWN store, seeded on first touch —
 * the same shape `server.mjs` uses (`listFor(email)`). A single shared array
 * would make the demo pass while teaching the opposite of the tenancy rule:
 * two signed-in users would see and mutate each other's rows.
 */
export function seedRepository(): TodoRepository {
  const byTenant = new Map<string, Todo[]>();
  const counters = new Map<string, number>();

  function storeFor(email: string): Todo[] {
    const key = tenantKey(email);
    let store = byTenant.get(key);
    if (!store) {
      // Cloned so mutations in a demo session don't leak across identities.
      store = SEED.map((t) => ({ ...t }));
      byTenant.set(key, store);
      counters.set(key, store.length);
    }
    return store;
  }

  return {
    async list(email) {
      return storeFor(email).map((t) => ({ ...t }));
    },
    async create(email, input) {
      const key = tenantKey(email);
      const store = storeFor(email);
      const next = (counters.get(key) ?? store.length) + 1;
      counters.set(key, next);
      const todo: Todo = {
        id: `t${next}`,
        title: input.title,
        status: "open",
        priority: input.priority ?? "medium",
        dueDate: input.dueDate,
        project: "Inbox",
      };
      // Written into THIS identity's store — the owner comes from the verified
      // caller, never from `input`.
      store.unshift(todo);
      return { ...todo };
    },
    async setStatus(email, id, status) {
      // Scoped lookup IS the authorization check: another identity's id is
      // simply absent here, so it can never be mutated.
      const todo = storeFor(email).find((t) => t.id === id);
      if (!todo) throw new TodoNotFoundError(id);
      todo.status = status;
      todo.completedOn = status === "done" ? "2026-07-13" : undefined;
      return { ...todo };
    },
  };
}

/* ------------------------------------------------ upstream tasks API adapter */

/**
 * One task row as an upstream tasks API returns it. `assignedTo` / `requestedBy`
 * are the OWNERSHIP fields — they are what ownership is decided on, so any
 * adapter that mutates by id needs them.
 */
export interface TasksRow {
  id: string;
  title: string;
  status: string;
  priority?: string;
  dueDate?: string | null;
  projectName?: string;
  actuallyCompletedDate?: string | null;
  assignedTo?: { email?: string | null } | null;
  requestedBy?: { email?: string | null } | null;
}

export interface TasksClientLike {
  /** Already tenant-scoped upstream: only ever returns `email`'s rows. */
  fetchTasks(params: { email: string }): Promise<TasksRow[]>;
  /**
   * Addressed by id, NOT scoped — it will happily return anyone's row. That is
   * precisely why the caller must check ownership before acting on the result.
   */
  fetchTaskById(id: string): Promise<TasksRow>;
  createTask(input: {
    title: string;
    priority?: string;
    dueDate?: string;
    /** Stamps ownership upstream. */
    requesterEmail?: string;
  }): Promise<TasksRow>;
  updateTask(id: string, input: { status?: string }): Promise<TasksRow>;
}

/**
 * Does `email` own this row? Deliberately no admin override: a third-party
 * service has no such role, and inventing one would be a way to widen its own
 * reach.
 */
function ownsTask(email: string, row: TasksRow): boolean {
  const want = tenantKey(email);
  return [row.assignedTo?.email, row.requestedBy?.email].some(
    (value) => typeof value === "string" && tenantKey(value) === want,
  );
}

function mapPriority(raw?: string): TodoPriority {
  const p = (raw ?? "").toLowerCase();
  if (p.startsWith("crit") || p.startsWith("high")) return "high";
  if (p.startsWith("low")) return "low";
  return "medium";
}

function mapStatus(raw: string): TodoStatus {
  return /done|complete|closed/i.test(raw) ? "done" : "open";
}

function toTodo(row: TasksRow): Todo {
  return {
    id: row.id,
    title: row.title,
    status: mapStatus(row.status),
    priority: mapPriority(row.priority),
    dueDate: row.dueDate ?? undefined,
    project: row.projectName,
    completedOn: row.actuallyCompletedDate ?? undefined,
  };
}

/**
 * Adapter over an upstream tasks client. Kept as a thin mapping so the sample
 * stays readable; in a real service, pass your own API client in.
 */
export function tasksApiRepository(client: TasksClientLike): TodoRepository {
  return {
    async list(email) {
      // Scoped by the upstream query — no post-filter needed, and none is a
      // substitute for it.
      const rows = await client.fetchTasks({ email });
      return rows.map(toTodo);
    },
    async create(email, input) {
      // The owner is the VERIFIED caller. Taking it from `input` would let the
      // client file a task against someone else.
      const created = await client.createTask({ ...input, requesterEmail: email });
      return toTodo(created);
    },
    async setStatus(email, id, status) {
      // Read-then-authorize-then-write. A transport
      // failure here is NOT caught: turning an upstream outage into "not found"
      // would report a lie to the user and hide the incident.
      const existing = await client.fetchTaskById(id);
      if (!ownsTask(email, existing)) throw new TodoNotFoundError(id);
      const updated = await client.updateTask(id, {
        status: status === "done" ? "Done" : "In Progress",
      });
      // Return what the upstream actually stored. The previous version
      // fabricated `{ title: "", priority: "medium" }`, so the UI rendered a
      // blank row after every toggle.
      return toTodo(updated);
    },
  };
}

export interface RepositoryResult {
  repo: TodoRepository;
  source: "tasks-api" | "seed";
  notice?: string;
}

/**
 * Try the upstream tasks API; fall back to seed data on any failure (unconfigured,
 * 401, unreachable). The liveness probe is one cheap scoped read —
 * `fetchTasks({ email })` — whose result is discarded; only whether it threw
 * decides which repository serves.
 */
export async function resolveRepository(
  client: TasksClientLike | null,
  email: string,
): Promise<RepositoryResult> {
  if (client) {
    try {
      await client.fetchTasks({ email });
      return { repo: tasksApiRepository(client), source: "tasks-api" };
    } catch {
      return {
        repo: seedRepository(),
        source: "seed",
        notice: "Live tasks API unavailable — showing sample data.",
      };
    }
  }
  return { repo: seedRepository(), source: "seed" };
}
