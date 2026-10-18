/**
 * Contract tests for the SDUI to-do sample.
 *
 * Two things are worth holding mechanically, because both are the kind of
 * mistake a comment cannot prevent:
 *
 *  1. TENANCY: the repository takes `email` on every write and must actually
 *     use it. The interesting case is the write addressed by id, where scoping
 *     is a deliberate check rather than a property of the query.
 *  2. PARITY: the sample's `DeepLink` and `SafeMarkdown` must agree with what
 *     XRAY Workspace enforces. A sample that is more permissive than the
 *     renderer teaches a service to emit documents the workspace will refuse.
 *     The Workspace's verdicts are recorded in `contract/workspace-v1.json`,
 *     generated from its real schemas.
 *
 * Run: `npm run test:sdui`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DeepLink, PageDocument, SafeMarkdown } from "./blocks";
import {
  seedRepository,
  tasksApiRepository,
  TodoNotFoundError,
  type TasksClientLike,
  type TasksRow,
} from "./todo-repository";
import { contextFrom, runAction, ServiceError } from "./todo-service";

interface MarkdownVector {
  value: string | { repeat: string; length: number };
  valid: boolean;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../contract/workspace-v1.json", import.meta.url), "utf8"),
) as {
  sdui: {
    deepLinks: Array<{ value: string; valid: boolean }>;
    markdown: { maxLength: number; cases: MarkdownVector[] };
  };
};

const markdownValue = ({ value }: MarkdownVector): string =>
  typeof value === "string" ? value : value.repeat.repeat(value.length);

/** The one verdict the sample deliberately does not share (see the known gap below). */
const workspaceRefusesMarkdown = (md: string): boolean =>
  vectors.sdui.markdown.cases.some((c) => !c.valid && markdownValue(c) === md);

const ALICE = "alice@example.test";
const BOB = "bob@example.test";

/* ------------------------------------------------------------ deep links */

test("the sample's DeepLink agrees with the workspace's enforced deep-link schema", () => {
  assert.ok(vectors.sdui.deepLinks.length > 0);
  for (const { value, valid } of vectors.sdui.deepLinks) {
    assert.equal(DeepLink.safeParse(value).success, valid, `divergence on ${JSON.stringify(value)}`);
  }
});

test("DeepLink refuses protocol-relative and backslash escapes", () => {
  assert.equal(DeepLink.safeParse("/settings").success, true);
  for (const hostile of [
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
  ]) {
    assert.equal(DeepLink.safeParse(hostile).success, false, `accepted ${hostile}`);
  }
});

test("a list block carrying a hostile deepLink fails PageDocument validation", () => {
  const doc = {
    blockVersion: "v1",
    title: "Today",
    blocks: [
      {
        type: "list",
        items: [{ title: "Anything", deepLink: "//evil.example" }],
      },
    ],
  };
  assert.equal(PageDocument.safeParse(doc).success, false);

  const safe = structuredClone(doc);
  (safe.blocks[0] as { items: Array<{ deepLink: string }> }).items[0].deepLink = "/tasks/t1";
  assert.equal(PageDocument.safeParse(safe).success, true);
});

/* ------------------------------------------------------------- markdown */

const RAW_HTML_PAYLOADS = [
  "<script>alert(1)</script>",
  "before <img onerror=alert(1)> after",
  "<a href=x>link</a>",
  "<!-- comment -->",
  "</div>",
];

const SAFE_MARKDOWN = ["**bold** and _italic_", "a [link](/settings)", "plain text", ""];

test("the sample refuses raw HTML in markdown, as its comment always claimed", () => {
  for (const hostile of RAW_HTML_PAYLOADS) {
    assert.equal(SafeMarkdown.safeParse(hostile).success, false, `accepted ${hostile}`);
  }
  for (const safe of SAFE_MARKDOWN) {
    assert.equal(SafeMarkdown.safeParse(safe).success, true, `rejected ${JSON.stringify(safe)}`);
  }
});

test("on raw HTML the sample and the workspace's own scanner agree", () => {
  for (const hostile of RAW_HTML_PAYLOADS) {
    assert.equal(SafeMarkdown.safeParse(hostile).success, false);
    assert.equal(workspaceRefusesMarkdown(hostile), true, `workspace accepted ${hostile}`);
  }
});

test("the sample accepts what the workspace accepts, and refuses its raw HTML", () => {
  for (const vector of vectors.sdui.markdown.cases) {
    const md = markdownValue(vector);
    if (md.includes("](javascript:")) continue; // the known gap, pinned below
    assert.equal(SafeMarkdown.safeParse(md).success, vector.valid, `divergence on ${md.slice(0, 40)}`);
  }
});

test("caps length at the same ceiling the workspace uses", () => {
  const max = vectors.sdui.markdown.maxLength;
  assert.equal(SafeMarkdown.safeParse("x".repeat(max)).success, true);
  assert.equal(SafeMarkdown.safeParse("x".repeat(max + 1)).success, false);
  assert.equal(workspaceRefusesMarkdown("x".repeat(max + 1)), true);
});

/**
 * The one that catches the helper going UNCALLED.
 *
 * Asserting on `SafeMarkdown` alone cannot notice `md` reverting to
 * `z.string()` — the helper still passes its own tests while nothing uses it.
 * This goes through the composed document, the way a service's own output
 * would.
 */
test("a text block carrying raw HTML fails PageDocument validation", () => {
  const doc = {
    blockVersion: "v1",
    title: "Today",
    blocks: [{ type: "text", md: "hello <script>alert(1)</script>" }],
  };
  assert.equal(PageDocument.safeParse(doc).success, false);

  const safe = structuredClone(doc);
  (safe.blocks[0] as { md: string }).md = "hello **world**";
  assert.equal(PageDocument.safeParse(safe).success, true);
});

/**
 * The KNOWN gap, pinned so it stays deliberate.
 *
 * The workspace normalizes and allowlists every link target; the sample does
 * not, because half a link scanner is worse than none — a service would think
 * it had protection it lacks. If someone later ports that logic here, this test
 * fails and should be deleted along with the caveat in blocks.ts.
 */
test("an unsafe LINK passes the sample and is still refused by the workspace", () => {
  const hostile = "[click](javascript:alert(1))";
  assert.equal(SafeMarkdown.safeParse(hostile).success, true);
  assert.equal(workspaceRefusesMarkdown(hostile), true);
});

/* ------------------------------------------------------- seed repository */

test("seed: one identity never sees another's records", async () => {
  const repo = seedRepository();
  await repo.create(ALICE, { title: "Alice private note" });

  const bob = await repo.list(BOB);
  assert.equal(
    bob.some((t) => t.title === "Alice private note"),
    false,
  );
});

test("seed: an identity cannot flip a record it does not own", async () => {
  const repo = seedRepository();
  const created = await repo.create(ALICE, { title: "Alice only" });

  await assert.rejects(
    () => repo.setStatus(BOB, created.id, "done"),
    (error: unknown) => error instanceof TodoNotFoundError,
  );

  // And Alice's record is untouched.
  const alice = await repo.list(ALICE);
  assert.equal(alice.find((t) => t.id === created.id)?.status, "open");
});

test("seed: the tenant key is case- and whitespace-insensitive", async () => {
  const repo = seedRepository();
  const created = await repo.create(ALICE, { title: "Same person" });
  const same = await repo.setStatus(`  ${ALICE.toUpperCase()}  `, created.id, "done");
  assert.equal(same.status, "done");
});

/* -------------------------------------------------- Tasks API repository */

function row(id: string, owner: string, over: Partial<TasksRow> = {}): TasksRow {
  return {
    id,
    title: `task ${id}`,
    status: "In Progress",
    assignedTo: { email: owner },
    ...over,
  };
}

function fakeClient(rows: TasksRow[]) {
  const calls: string[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const client: TasksClientLike = {
    async fetchTasks({ email }) {
      calls.push(`fetchTasks:${email}`);
      return [...byId.values()].filter((r) => r.assignedTo?.email === email);
    },
    async fetchTaskById(id) {
      calls.push(`fetchTaskById:${id}`);
      const found = byId.get(id);
      if (!found) throw new Error("upstream 404");
      return found;
    },
    async createTask(input) {
      calls.push(`createTask:${input.requesterEmail ?? "<none>"}`);
      const created = row("new", input.requesterEmail ?? "", {
        title: input.title,
        status: "In Progress",
      });
      byId.set(created.id, created);
      return created;
    },
    async updateTask(id, input) {
      calls.push(`updateTask:${id}`);
      const found = byId.get(id);
      if (!found) throw new Error("upstream 404");
      const updated = { ...found, status: input.status ?? found.status };
      byId.set(id, updated);
      return updated;
    },
  };
  return { client, calls };
}

test("tasks: create stamps the VERIFIED caller as the owner", async () => {
  const { client, calls } = fakeClient([]);
  await tasksApiRepository(client).create(ALICE, { title: "New" });
  assert.equal(calls.includes(`createTask:${ALICE}`), true);
});

test("tasks: setStatus refuses a record owned by someone else, and does not write", async () => {
  const { client, calls } = fakeClient([row("t1", ALICE)]);
  const repo = tasksApiRepository(client);

  await assert.rejects(
    () => repo.setStatus(BOB, "t1", "done"),
    (error: unknown) => error instanceof TodoNotFoundError,
  );
  // The load-bearing assertion: the write never happened.
  assert.equal(
    calls.some((c) => c.startsWith("updateTask:")),
    false,
  );
});

test("tasks: setStatus allows the owner and returns the RE-READ record", async () => {
  const { client } = fakeClient([row("t1", ALICE, { title: "Real title" })]);
  const updated = await tasksApiRepository(client).setStatus(ALICE, "t1", "done");
  assert.equal(updated.status, "done");
  // Not the fabricated `{ title: "", priority: "medium" }` the sample used to return.
  assert.equal(updated.title, "Real title");
});

test("tasks: requestedBy counts as ownership, as the upstream does", async () => {
  const { client } = fakeClient([
    row("t1", "someone-else@example.test", { requestedBy: { email: ALICE } }),
  ]);
  const updated = await tasksApiRepository(client).setStatus(ALICE, "t1", "done");
  assert.equal(updated.status, "done");
});

test("tasks: an upstream failure is NOT reported as not-found", async () => {
  const { client } = fakeClient([]);
  await assert.rejects(
    () => tasksApiRepository(client).setStatus(ALICE, "missing", "done"),
    (error: unknown) => error instanceof Error && !(error instanceof TodoNotFoundError),
  );
});

/* ------------------------------------------------------ service mapping */

test("runAction maps an unowned target to NOT_FOUND, never to a leak", async () => {
  const repo = seedRepository();
  const created = await repo.create(ALICE, { title: "Alice only" });
  const ctx = contextFrom(BOB, { repo, source: "seed" });

  await assert.rejects(
    () => runAction(`complete:${created.id}`, {}, ctx),
    (error: unknown) => error instanceof ServiceError && error.code === "NOT_FOUND",
  );
});
