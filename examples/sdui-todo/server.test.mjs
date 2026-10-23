import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createApp, manifest, mintTestToken, verifyWorkspaceToken } from "./server.mjs";

const SLUG = "sduitodo";
const EMBED_KEY = "xre_fixture_test_key";
const API_KEY = "xrk_fixture_test_key";

/** The configured service — the shape a registered app actually runs in. */
let server;
let base;
/** The same code with no credentials configured: private paths must be closed. */
let unconfigured;
let unconfiguredBase;

before(async () => {
  server = createApp({ slug: SLUG, embedKey: EMBED_KEY, apiKey: API_KEY });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  unconfigured = createApp({ slug: SLUG, embedKey: null, apiKey: null });
  await new Promise((resolve) => unconfigured.listen(0, resolve));
  unconfiguredBase = `http://127.0.0.1:${unconfigured.address().port}`;
});
after(() => {
  server.close();
  unconfigured.close();
});

const A = { email: "jordan.lee.aaa@example.com", companyId: "org_aaaa1111" };
const B = { email: "sam.rivera.bbb@example.com", companyId: "org_bbbb2222" };

/** Exactly what the certification harness and the BFF proxy send. */
function signedHeaders(identity, { key = EMBED_KEY, aud = SLUG } = {}) {
  return {
    "X-Workspace-Api-Key": API_KEY,
    "X-Workspace-Token": mintTestToken(key, {
      sub: identity.email,
      aud,
      companyId: identity.companyId,
    }),
  };
}

/** A token whose claims are intact but whose HMAC does not verify. */
function tamperedHeaders(identity) {
  const headers = signedHeaders(identity);
  const parts = headers["X-Workspace-Token"].split(".");
  const sig = parts[2];
  parts[2] = `${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`;
  headers["X-Workspace-Token"] = parts.join(".");
  return headers;
}

const get = (path, headers = {}, at = base) =>
  fetch(`${at}${path}`, { headers, redirect: "manual" });
const hint = (identity) =>
  `email=${encodeURIComponent(identity.email)}&companyId=${encodeURIComponent(identity.companyId)}`;

test("the four required endpoints answer 200 with the envelope and never redirect", async () => {
  for (const path of ["/api/v1/health", "/api/v1/ready", "/api/v1/version", "/api/v1/manifest"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const body = await res.json();
    assert.ok("data" in body, path);
  }
  const trailing = await get("/api/v1/health/");
  assert.equal(trailing.status, 200);
});

test("the public four stay public even when nothing is configured", async () => {
  for (const path of ["/api/v1/health", "/api/v1/ready", "/api/v1/version", "/api/v1/manifest"]) {
    assert.equal((await get(path, {}, unconfiguredBase)).status, 200, path);
  }
});

test("the manifest carries what the workspace's schema requires", () => {
  assert.equal(manifest.contractVersion, "v1");
  assert.equal(manifest.capabilities.search, true);
  assert.equal(manifest.capabilities.merge, true);
  assert.match(manifest.service, /^[a-z0-9]{3,32}$/);
  assert.equal(manifest.capabilities.pages, true);
  assert.equal(manifest.certification.resourcePath, "/api/v1/resources");
  assert.ok(manifest.certification.recordPathTemplate.includes("{id}"));
});

// ── The trust boundary. These are the regressions that matter. ───────────────

test("a bare ?email= hint is NOT an identity: unauthenticated reads are refused", async () => {
  // This is the exact request the old certification harness made, and the exact
  // request this fixture used to answer with real records.
  const list = await get(`/api/v1/resources?${hint(A)}`);
  assert.equal(list.status, 401);
  const body = await list.json();
  assert.equal(body.error.code, "UNAUTHENTICATED");
  assert.equal((await get(`/api/v1/resources/anything?${hint(A)}`)).status, 401);
  assert.equal((await get(`/api/v1/pages/today?${hint(A)}`)).status, 401);
});

test("the service key alone is not enough — a request with no token is refused", async () => {
  const res = await get("/api/v1/resources", { "X-Workspace-Api-Key": API_KEY });
  assert.equal(res.status, 401);
});

test("a valid token without the service key is refused", async () => {
  const headers = signedHeaders(A);
  delete headers["X-Workspace-Api-Key"];
  assert.equal((await get("/api/v1/resources", headers)).status, 401);
});

test("the correct service key with an unverifiable token is refused", async () => {
  assert.equal((await get("/api/v1/resources", tamperedHeaders(A))).status, 401);
  // A token signed with the wrong key, and one minted for another audience.
  assert.equal(
    (await get("/api/v1/resources", signedHeaders(A, { key: "xre_someone_else" }))).status,
    401,
  );
  assert.equal(
    (await get("/api/v1/resources", signedHeaders(A, { aud: "someoneelse" }))).status,
    401,
  );
});

test("private paths fail closed when the instance has no keys configured", async () => {
  for (const path of ["/api/v1/resources", "/api/v1/pages", "/api/v1/pages/today"]) {
    const res = await get(`${path}?${hint(A)}`, signedHeaders(A), unconfiguredBase);
    assert.equal(res.status, 401, path);
  }
});

test("resources are scoped by the SIGNED identity: A never sees B's list or record", async () => {
  const aList = await (await get(`/api/v1/resources?${hint(A)}`, signedHeaders(A))).json();
  const bList = await (await get(`/api/v1/resources?${hint(B)}`, signedHeaders(B))).json();
  assert.ok(aList.data.items.length > 0);
  const aId = aList.data.items[0].id;

  assert.ok(!bList.data.items.some((item) => item.id === aId));
  const leak = await get(`/api/v1/resources/${aId}?${hint(B)}`, signedHeaders(B));
  assert.equal(leak.status, 404);
  const own = await get(`/api/v1/resources/${aId}?${hint(A)}`, signedHeaders(A));
  assert.equal(own.status, 200);
});

test("a query hint cannot override the signed identity", async () => {
  // B's valid token, A's hint. The hint must never win.
  const res = await get(`/api/v1/resources?${hint(A)}`, signedHeaders(B));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "IDENTITY_MISMATCH");

  const aList = await (await get(`/api/v1/resources?${hint(A)}`, signedHeaders(A))).json();
  const aId = aList.data.items[0].id;
  const record = await get(`/api/v1/resources/${aId}?${hint(A)}`, signedHeaders(B));
  assert.equal(record.status, 403);
});

test("a hint that agrees with the token is accepted", async () => {
  const res = await get(`/api/v1/resources?${hint(A)}`, signedHeaders(A));
  assert.equal(res.status, 200);
});

// ── Server-driven UI and actions ─────────────────────────────────────────────

test("pages list and a page document have the shapes the shell reads", async () => {
  const list = await (await get("/api/v1/pages", signedHeaders(A))).json();
  assert.deepEqual(list.data.pages, [{ id: "today", title: "My to-dos" }]);
  const doc = await (await get("/api/v1/pages/today", signedHeaders(A))).json();
  assert.equal(doc.data.blockVersion, "v1");
  assert.ok(Array.isArray(doc.data.blocks) && doc.data.blocks.length >= 3);
  assert.equal((await get("/api/v1/pages/nope", signedHeaders(A))).status, 404);
});

test("actions need identity, an Idempotency-Key, and replay the same result", async () => {
  const url = `${base}/api/v1/actions/add-todo`;
  const unauthenticated = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ values: { title: "Ship it" } }),
  });
  assert.equal(unauthenticated.status, 401);

  const bare = await fetch(url, {
    method: "POST",
    headers: signedHeaders(A),
    body: JSON.stringify({ values: { title: "Ship it" } }),
  });
  assert.equal(bare.status, 400);

  const idempotencyKey = randomUUID();
  const call = () =>
    fetch(url, {
      method: "POST",
      headers: {
        ...signedHeaders(A),
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: { title: "Ship it" } }),
    });
  const first = await (await call()).json();
  assert.equal(first.data.ok, true);
  assert.equal(first.data.refresh, true);
  await call();
  const after2 = await (await get("/api/v1/resources", signedHeaders(A))).json();
  assert.equal(after2.data.items.filter((t) => t.title === "Ship it").length, 1);
});

test("token verification: HS256 only, signature, iss, aud, exp", () => {
  const key = "xre_test_key";
  const good = mintTestToken(key, { sub: "Person@Example.com" });
  const v = verifyWorkspaceToken(good, key);
  assert.equal(v.ok, true);
  assert.equal(v.email, "person@example.com");
  assert.equal(verifyWorkspaceToken(good, "xre_other").ok, false);
  assert.equal(
    verifyWorkspaceToken(mintTestToken(key, { sub: "a@b.c", alg: "none" }), key).reason,
    "alg",
  );
  assert.equal(
    verifyWorkspaceToken(mintTestToken(key, { sub: "a@b.c", aud: "someone-else" }), key).reason,
    "aud",
  );
  assert.equal(
    verifyWorkspaceToken(
      mintTestToken(key, { sub: "a@b.c", now: Math.floor(Date.now() / 1000) - 1000, ttl: 60 }),
      key,
    ).reason,
    "exp",
  );
  assert.equal(verifyWorkspaceToken("not.a.jwt", key).reason, "malformed");
});

test("search answers only the signed identity's own to-dos, linking inside the app", async () => {
  // Every app serves search. Same gate, same rows, same isolation as the
  // resources: A's to-dos never surface in B's search.
  const own = await get(`/api/v1/search?q=certification&limit=5`, signedHeaders(A));
  assert.equal(own.status, 200);
  const rows = (await own.json()).data.results;
  assert.deepEqual(
    rows.map((row) => row.title),
    ["Run certification"],
  );
  assert.equal(rows[0].deepLink, `/svc/${SLUG}/today`);
  assert.ok(rows[0].score >= 0 && rows[0].score <= 1);

  const aIds = new Set(
    (await (await get("/api/v1/resources", signedHeaders(A))).json()).data.items.map((t) => t.id),
  );
  const peer = (await (await get(`/api/v1/search?q=certification`, signedHeaders(B))).json()).data
    .results;
  assert.ok(
    peer.every((row) => !aIds.has(row.id)),
    "B never finds A's to-dos",
  );

  assert.equal((await get(`/api/v1/search?q=c`, signedHeaders(A))).status, 400);
  assert.equal((await get(`/api/v1/search?q=certification&${hint(A)}`)).status, 401);
  assert.equal((await get(`/api/v1/search?q=certification`, tamperedHeaders(A))).status, 401);
});

// ── Subject merge: POST /api/v1/subject/merge ────────────────────────────────

/** The call the workspace's fan-out makes: service key, merge token, body. */
function mergeHeaders(survivor, { scope = ["merge"], key = EMBED_KEY } = {}) {
  return {
    "X-Workspace-Api-Key": API_KEY,
    "X-Workspace-Token": mintTestToken(key, { sub: survivor, scope }),
    "Content-Type": "application/json",
  };
}
const merge = (body, headers = mergeHeaders(body.to.email)) =>
  fetch(`${base}/api/v1/subject/merge`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
const mergeBody = (from, to, requestId) => ({
  requestId,
  from: { emails: [from] },
  to: { email: to, emails: [to, from] },
  reason: "linked_email",
});
const titles = async (email) =>
  (await (await get("/api/v1/resources", signedHeaders({ email }))).json()).data.items
    .map((todo) => todo.title)
    .sort();

test("merge moves the absorbed person's to-dos to the survivor, who wins collisions", async () => {
  const from = `absorbed.${randomUUID()}@example.com`;
  const to = `survivor.${randomUUID()}@example.com`;
  // Both have the three starter to-dos; the absorbed one also has their own.
  await get("/api/v1/resources", signedHeaders({ email: to }));
  await fetch(`${base}/api/v1/actions/add-todo`, {
    method: "POST",
    headers: {
      ...signedHeaders({ email: from }),
      "Idempotency-Key": randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: { title: "Booked under the old address" } }),
  });

  const res = await merge(mergeBody(from, to, `m-${randomUUID()}`));
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.status, "done");
  assert.deepEqual(data.moved, { todos: 1 });
  assert.deepEqual(data.conflicts, [{ label: "starter_todos", kept: "to", count: 3 }]);
  assert.deepEqual(await titles(to), [
    "Booked under the old address",
    "Read the manifest contract",
    "Run certification",
    "Submit for review",
  ]);
});

test("merge is idempotent on requestId, and a repeat under a new id is done", async () => {
  const from = `absorbed.${randomUUID()}@example.com`;
  const to = `survivor.${randomUUID()}@example.com`;
  await get("/api/v1/resources", signedHeaders({ email: from }));
  const requestId = `m-${randomUUID()}`;
  const first = await (await merge(mergeBody(from, to, requestId))).json();
  const retry = await merge(mergeBody(from, to, requestId));
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), first);
  assert.equal(first.data.status, "done");

  const again = await (await merge(mergeBody(from, to, `m-${randomUUID()}`))).json();
  assert.equal(again.data.status, "done");
  assert.deepEqual(again.data.moved, {});

  // Merging INTO someone already absorbed is refused with 409.
  const into = await merge(
    mergeBody(`third.${randomUUID()}@example.com`, from, `m-${randomUUID()}`),
  );
  assert.equal(into.status, 409);
  assert.equal((await into.json()).error.code, "MERGE_CONFLICT");
});

test("merge answers nothing_to_merge when it holds nothing for the absorbed person", async () => {
  const from = `never.seen.${randomUUID()}@example.com`;
  const to = `survivor.${randomUUID()}@example.com`;
  const requestId = `m-${randomUUID()}`;
  const res = await merge(mergeBody(from, to, requestId));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, {
    requestId,
    status: "nothing_to_merge",
    moved: {},
    conflicts: [],
  });
});

test("an unauthenticated, wrongly scoped or mismatched merge is refused", async () => {
  const from = `absorbed.${randomUUID()}@example.com`;
  const to = `survivor.${randomUUID()}@example.com`;
  await get("/api/v1/resources", signedHeaders({ email: from }));
  const body = mergeBody(from, to, `m-${randomUUID()}`);

  assert.equal((await merge(body, { "Content-Type": "application/json" })).status, 401);
  const noKey = mergeHeaders(to);
  delete noKey["X-Workspace-Api-Key"];
  assert.equal((await merge(body, noKey)).status, 401);
  assert.equal((await merge(body, mergeHeaders(to, { key: "xre_someone_else" }))).status, 401);
  const readOnly = await merge(body, mergeHeaders(to, { scope: ["read"] }));
  assert.equal(readOnly.status, 403);
  assert.equal((await readOnly.json()).error.code, "SCOPE_INSUFFICIENT");
  const mismatch = await merge(body, mergeHeaders(`someone.${randomUUID()}@example.com`));
  assert.equal(mismatch.status, 403);
  assert.equal((await mismatch.json()).error.code, "IDENTITY_MISMATCH");
  assert.equal((await merge({ ...body, extra: true }, mergeHeaders(to))).status, 400);
  assert.equal((await merge({ ...body, reason: "because" }, mergeHeaders(to))).status, 400);
  // The private gate fails closed on an unconfigured instance, merge included.
  const closed = await fetch(`${unconfiguredBase}/api/v1/subject/merge`, {
    method: "POST",
    headers: mergeHeaders(to),
    body: JSON.stringify(body),
  });
  assert.equal(closed.status, 401);

  assert.equal((await titles(from)).length, 3, "nothing moved");
});
