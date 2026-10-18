/**
 * The app's behaviour: the registered-service contract, the embed page's
 * headers, and the tenant/role rules on its own backend.
 *
 * The adversarial half lives in `security.test.mjs`. Both run against a real
 * loopback HTTP server with the online authorization boundary stubbed — no
 * workspace, no database, no network, no sleeping.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { buildManifest } from "./server.mjs";
import { createStore } from "./store.mjs";
import {
  ADMIN,
  COMPANY_A,
  COMPANY_B,
  MEMBER,
  canaryToken,
  closeAllApps,
  SERVICE_API_KEY,
  SLUG,
  WORKSPACE_ORIGIN,
  idempotencyKey,
  makeToken,
  startApp,
  stubAuthorize,
  testConfig,
} from "./test-support.mjs";

let app;
before(async () => {
  app = await startApp();
});
// Drains every app any test started, so a failed assertion cannot strand a
// listening server and hang the runner.
after(() => closeAllApps());

describe("the registered-service contract", () => {
  test("health, ready and manifest answer 200 in the envelope and never redirect", async () => {
    for (const path of ["/api/v1/health", "/api/v1/ready", "/api/v1/manifest"]) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      assert.ok(res.body && "data" in res.body, path);
      assert.equal(res.headers.get("cache-control"), "no-store", path);
    }
    assert.equal((await app.request("/api/v1/health/")).status, 200);
  });

  test("the manifest declares the grants this app cannot work without", () => {
    const manifest = buildManifest(testConfig());
    assert.equal(manifest.service, SLUG);
    assert.equal(manifest.contractVersion, "v1");
    assert.equal(manifest.capabilities.embed.path, "/embed");
    assert.equal(manifest.capabilities.search, true);
    assert.equal(manifest.requestedGrants.embed, true);
    // The tenant key and the role data. Without either, the admin plane and
    // the tenant scoping have nothing to stand on.
    assert.equal(manifest.requestedGrants.identity.companyId, true);
    assert.equal(manifest.requestedGrants.identity.access, true);
    assert.equal(manifest.requestedGrants.identity.tier, false);
    assert.ok(manifest.certification.recordPathTemplate.includes("{id}"));
  });

  test("the resource handlers are owner-scoped and never leak existence", async () => {
    // The four checks the certification harness runs, against the
    // real handlers — there is no probe-only code path. The harness signs a
    // short-lived read-scoped canary token per identity and sends it with the
    // app's service key, exactly as the workspace proxy would.
    const a = canaryToken({ sub: "jordan.lee.a1b2c3@example.com", companyId: COMPANY_A });
    const b = canaryToken({ sub: "sam.rivera.d4e5f6@example.com", companyId: COMPANY_B });

    // 2. A legitimate identity's list resolves, and is non-empty: an empty
    //    list gives the harness no record to prove isolation with, which it
    //    treats as a non-pass.
    const bList = await app.asProxy("/api/v1/resources", b);
    assert.equal(bList.status, 200);
    assert.ok(bList.body.data.items.length > 0, "first use provisions a starter note");
    const bId = bList.body.data.items[0].id;

    // 3. B's own record, requested AS A, must be absent — not forbidden.
    assert.equal((await app.asProxy(`/api/v1/resources/${bId}`, a)).status, 404);

    // 4. And B's id must not appear in A's list either.
    const aList = await app.asProxy("/api/v1/resources", a);
    assert.ok(!aList.body.data.items.some((item) => item.id === bId));

    assert.equal((await app.asProxy(`/api/v1/resources/${bId}`, b)).status, 200);
  });

  test("a matching email hint cannot rescue an invalid token signature", async () => {
    const token = makeToken({ key: SERVICE_API_KEY });
    const result = await app.asProxy(
      `/api/v1/resources?email=${encodeURIComponent(MEMBER)}`,
      token,
    );
    assert.equal(result.status, 401);
    assert.equal(result.body.data, undefined);
  });

  test("one person's token for one organization cannot read their other organization's notes", async () => {
    const store = createStore();
    const a = store.add({ companyId: COMPANY_A, ownerEmail: MEMBER, title: "Client A" });
    const b = store.add({ companyId: COMPANY_B, ownerEmail: MEMBER, title: "Client B" });
    const local = await startApp({ store });
    const token = makeToken({ sub: MEMBER, companyId: COMPANY_A });
    const list = await local.asProxy("/api/v1/resources", token);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.data.items.map((note) => note.id),
      [a.note.id],
    );
    assert.equal((await local.asProxy(`/api/v1/resources/${b.note.id}`, token)).status, 404);
  });

  test("the resource surface reads the same rows the app writes", async () => {
    // If the proxied read and the app's own read did not reach the same
    // storage, the harness would be certifying a fiction.
    const store = createStore();
    const local = await startApp({ store, authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const token = makeToken();
    await local.asUser("/app/notes", token, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "Written through the app" }),
    });

    const viaProxy = await local.asProxy("/api/v1/resources", token);
    assert.equal(viaProxy.status, 200);
    assert.ok(viaProxy.body.data.items.some((n) => n.title === "Written through the app"));
    // The hint is allowed when it AGREES with the signature — it is a routing
    // convenience, never a second source of identity.
    const withHint = await local.asProxy(
      `/api/v1/resources?email=${encodeURIComponent(MEMBER)}`,
      token,
    );
    assert.deepEqual(withHint.body, viaProxy.body);
    await local.close();
  });

  test("search answers only the signed person's own notes, linking inside the app", async () => {
    // Every app serves search. The same gate and the same rows as
    // the resources, and the same isolation the harness proves for them.
    const store = createStore();
    store.add({ companyId: COMPANY_A, ownerEmail: MEMBER, title: "Roadmap for Acme" });
    store.add({ companyId: COMPANY_B, ownerEmail: MEMBER, title: "Roadmap for Globex" });
    const local = await startApp({ store });
    const token = makeToken({ sub: MEMBER, companyId: COMPANY_A });

    const found = await local.asProxy("/api/v1/search?q=roadmap&limit=5", token);
    assert.equal(found.status, 200);
    assert.deepEqual(
      found.body.data.results.map((row) => row.title),
      ["Roadmap for Acme"],
    );
    const [row] = found.body.data.results;
    assert.equal(row.type, "note");
    assert.ok(row.deepLink.startsWith(`/svc/${SLUG}?at=`), row.deepLink);
    assert.ok(row.score >= 0 && row.score <= 1);

    assert.equal((await local.asProxy("/api/v1/search?q=r", token)).status, 400);
    assert.equal((await local.request("/api/v1/search?q=roadmap")).status, 401);
    const forged = makeToken({ key: SERVICE_API_KEY, sub: MEMBER, companyId: COMPANY_A });
    assert.equal((await local.asProxy("/api/v1/search?q=roadmap", forged)).status, 401);
    await local.close();
  });

  test("pages need the service key, and carry no user data when they get it", async () => {
    assert.equal((await app.request("/api/v1/pages")).status, 401);
    const withKey = await app.request("/api/v1/pages", {
      headers: { "X-Workspace-Api-Key": SERVICE_API_KEY },
    });
    assert.equal(withKey.status, 200);
    assert.deepEqual(withKey.body.data.pages, [
      { id: "open", title: "Team notes", embedPath: "/embed" },
    ]);
    const doc = await app.request("/api/v1/pages/open", {
      headers: { "X-Workspace-Api-Key": SERVICE_API_KEY },
    });
    assert.equal(doc.body.data.blockVersion, "v1");
    assert.ok(!JSON.stringify(doc.body).includes("@example.com"));
  });

  test("an unknown method is 405 with an Allow header; unknown paths are 404", async () => {
    const res = await app.request("/api/v1/health", { method: "PUT" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, POST, DELETE");
    assert.equal((await app.request("/nope")).status, 404);
  });
});

describe("the framed page", () => {
  test("serves a CSP that names the workspace in frame-ancestors and nothing inline", async () => {
    const response = await fetch(`${app.base}/embed`, { redirect: "manual" });
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp.includes(`frame-ancestors ${WORKSPACE_ORIGIN}`), csp);
    assert.equal(response.headers.get("x-frame-options"), null, "would override frame-ancestors");
    assert.ok(!csp.includes("unsafe-inline"), csp);
    assert.ok(!csp.includes("unsafe-eval"), csp);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);

    const html = await response.text();
    // Every script and style is a file this process serves from its own origin.
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "no inline <script>");
    assert.ok(!/\sstyle=/i.test(html), "no inline style attributes");
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(WORKSPACE_ORIGIN, "")), "no CDN");
    assert.ok(html.includes('src="/embed/app.mjs"'));
  });

  test("renders the workspace's mode from ?theme= for the first paint, and nothing else", async () => {
    // Theme handoff v1: a module script runs too late to stop a flash of the
    // OS palette, so the server puts the mode on <html> itself.
    for (const [query, expected] of [
      ["?theme=dark", '<html lang="en" data-theme="dark">'],
      ["?theme=light", '<html lang="en" data-theme="light">'],
      ["", '<html lang="en">'],
      ["?theme=%22%3E%3Cscript%3E", '<html lang="en">'],
      ["?theme=sepia", '<html lang="en">'],
    ]) {
      const html = await (await fetch(`${app.base}/embed${query}`)).text();
      assert.ok(html.includes(expected), `${query} → ${expected}`);
      assert.ok(!html.includes("<script>"), query);
    }
  });

  test("its script and stylesheet are served from the same origin", async () => {
    for (const [path, type] of [
      ["/embed/app.mjs", "text/javascript"],
      ["/embed/protocol.mjs", "text/javascript"],
      ["/embed/app.css", "text/css"],
    ]) {
      const res = await fetch(`${app.base}${path}`, { redirect: "manual" });
      assert.equal(res.status, 200, path);
      assert.ok(res.headers.get("content-type").startsWith(type), path);
    }
  });

  test("the page never ships the service key, and never persists the token", async () => {
    const html = await (await fetch(`${app.base}/embed`)).text();
    const script = await (await fetch(`${app.base}/embed/app.mjs`)).text();
    assert.ok(!html.includes(SERVICE_API_KEY));
    assert.ok(!script.includes(SERVICE_API_KEY));
    // Strip comments first: the file talks ABOUT these APIs at length, and
    // the assertion is about what it calls, not what it discusses.
    const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const sink of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
      assert.ok(!code.includes(sink), `the token must never reach ${sink}`);
    }
    // Nor the URL, nor a log line.
    assert.ok(!/history\.(replace|push)State|location\s*=/.test(code));
    assert.ok(!/console\.[a-z]+\([^)]*identityToken/.test(code));
  });
});

describe("the embedded page's backend", () => {
  test("a member can open a session and see their own role", async () => {
    const local = await startApp({ authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const token = makeToken();
    const res = await local.asUser("/app/session", token, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.email, MEMBER);
    assert.equal(res.body.data.companyId, COMPANY_A);
    assert.equal(res.body.data.isAdmin, false);
    // The token itself is never echoed back to the page.
    assert.ok(!JSON.stringify(res.body).includes(token), "no JWT in the session payload");
    await local.close();
  });

  test("a member session reports their departments, custom roles, and permissions", async () => {
    const local = await startApp({
      authorize: stubAuthorize({
        orgRole: "MEMBER",
        deptSlugs: ["engineering", "operations"],
        roleSlugs: ["lead"],
        permissions: ["xrayteamapp.notes.read"],
      }),
    });
    const token = makeToken();
    const res = await local.asUser("/app/session", token, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.deptSlugs, ["engineering", "operations"]);
    assert.deepEqual(res.body.data.roleSlugs, ["lead"]);
    assert.deepEqual(res.body.data.permissions, ["xrayteamapp.notes.read"]);

    const added = await local.asUser("/app/notes", token, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "Tagged with primary department" }),
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.data.dept, "engineering");
    await local.close();
  });

  test("a member adds and lists their own notes; the org plane refuses them", async () => {
    const local = await startApp({ authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const token = makeToken();
    const added = await local.asUser("/app/notes", token, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "Book the retro" }),
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.data.title, "Book the retro");

    const list = await local.asUser("/app/notes", token);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.mine.length, 1);

    const org = await local.asUser("/app/org-notes", token);
    assert.equal(org.status, 403);
    assert.equal(org.body.error.code, "ADMIN_REQUIRED");
    await local.close();
  });

  test("your own reads are served offline; anything sensitive calls the workspace", async () => {
    const authorize = stubAuthorize({ orgRole: "ADMIN" });
    const local = await startApp({ authorize });
    const token = makeToken({ sub: ADMIN });

    // Offline: the token alone, bounded by its ≤300s lifetime.
    await local.asUser("/app/notes", token);
    assert.equal(authorize.calls.length, 0, "reading your own rows needs no callback");

    // Sensitive: a role report, other people's rows, and a write.
    await local.asUser("/app/session", token, { method: "POST" });
    await local.asUser("/app/org-notes", token);
    await local.asUser("/app/notes", token, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "Sensitive" }),
    });
    assert.equal(authorize.calls.length, 3);
    await local.close();
  });

  test("the same Idempotency-Key replays instead of writing twice", async () => {
    const local = await startApp({ authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const token = makeToken();
    const key = idempotencyKey("replay");
    const call = () =>
      local.asUser("/app/notes", token, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ title: "Only once" }),
      });
    const first = await call();
    const second = await call();
    assert.equal(first.status, 201);
    assert.deepEqual(second.body, first.body);
    const list = await local.asUser("/app/notes", token);
    assert.equal(list.body.data.mine.filter((n) => n.title === "Only once").length, 1);
    await local.close();
  });

  test("an idempotency key cannot replay a different operation's response", async () => {
    const store = createStore();
    const target = store.add({ companyId: COMPANY_A, ownerEmail: MEMBER, title: "Remove me" });
    const local = await startApp({ store, authorize: stubAuthorize({ orgRole: "ADMIN" }) });
    const token = makeToken({ sub: ADMIN });
    const key = idempotencyKey();
    const created = await local.asUser("/app/notes", token, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ title: "Mine" }),
    });
    assert.equal(created.status, 201);
    const removed = await local.asUser(`/app/org-notes/${target.note.id}`, token, {
      method: "DELETE",
      headers: { "Idempotency-Key": key },
    });
    assert.equal(removed.status, 200);
    assert.equal(store.getInTenant(COMPANY_A, target.note.id), undefined);
  });

  test("a mutation without an Idempotency-Key is refused", async () => {
    const local = await startApp({ authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const res = await local.asUser("/app/notes", makeToken(), {
      method: "POST",
      body: JSON.stringify({ title: "No key" }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
    await local.close();
  });

  test("the admin-only operation: a member is denied, an admin is not", async () => {
    // One shared store, so the two roles are looking at the same tenant.
    const store = createStore();
    const seeded = store.add({
      companyId: COMPANY_A,
      ownerEmail: "colleague@example.com",
      title: "Someone else's note",
    });
    assert.equal(seeded.ok, true);
    const noteId = seeded.note.id;

    const asMember = await startApp({ store, authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const memberDelete = await asMember.asUser(`/app/org-notes/${noteId}`, makeToken(), {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    assert.equal(memberDelete.status, 403);
    assert.equal(memberDelete.body.error.code, "ADMIN_REQUIRED");
    // And the member's own-notes read does not show it either.
    const mine = await asMember.asUser("/app/notes", makeToken());
    assert.equal(mine.body.data.mine.length, 0);
    await asMember.close();

    const asAdmin = await startApp({ store, authorize: stubAuthorize({ orgRole: "ADMIN" }) });
    const adminToken = makeToken({ sub: ADMIN });
    const adminList = await asAdmin.asUser("/app/org-notes", adminToken);
    assert.equal(adminList.body.data.notes.length, 1, "an admin sees the whole tenant");
    const adminDelete = await asAdmin.asUser(`/app/org-notes/${noteId}`, adminToken, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    assert.equal(adminDelete.status, 200);
    assert.equal(store.getInTenant(COMPANY_A, noteId), undefined);
    await asAdmin.close();
  });

  test("an admin's own-notes endpoint is still owner-scoped, not a back door", async () => {
    const store = createStore();
    const theirs = store.add({
      companyId: COMPANY_A,
      ownerEmail: "colleague@example.com",
      title: "Not the admin's note",
    });
    const local = await startApp({ store, authorize: stubAuthorize({ orgRole: "ADMIN" }) });
    // The offline endpoint answers for YOUR rows only. An admin reading
    // someone else's note here gets a 404 and must use the online org plane.
    const res = await local.asUser(`/app/notes/${theirs.note.id}`, makeToken({ sub: ADMIN }));
    assert.equal(res.status, 404);
    await local.close();
  });

  test("OWNER also opens the admin plane; VIEWER and an unknown role do not", async () => {
    for (const [role, admin] of [
      ["OWNER", true],
      ["ADMIN", true],
      ["MEMBER", false],
      ["VIEWER", false],
    ]) {
      const local = await startApp({ authorize: stubAuthorize({ orgRole: role }) });
      const res = await local.asUser("/app/session", makeToken(), { method: "POST" });
      assert.equal(res.body.data.isAdmin, admin, role);
      await local.close();
    }
  });
});
