#!/usr/bin/env node
/* eslint-disable no-console -- a runnable fixture: stdout is its interface. */
/**
 * sdui-todo — the RUNNABLE fixture service for the developer platform.
 *
 * `examples/sdui-todo/*.ts` is reference code: it shows the shape, but it is
 * not a server, so it cannot be registered, certified or proxied. This file is
 * the service you can actually register end to end: zero dependencies, one process, every
 * endpoint the contract requires, and tenant isolation done the way the
 * certification harness checks it.
 *
 *   node examples/sdui-todo/server.mjs            # http://localhost:4801
 *   PORT=4801 EMBED_KEY=xre_… WORKSPACE_API_KEY=xrk_… SERVICE_SLUG=sduitodo …
 *
 * Contract (docs/contract.md in this repository):
 *   GET  /api/v1/health | /ready | /version | /manifest     — public, no redirects
 *   GET  /api/v1/resources, /api/v1/resources/{id}           — private, certified
 *   GET  /api/v1/pages, /api/v1/pages/{id}                   — private, server-driven UI
 *   POST /api/v1/actions/{actionId}                          — private, Idempotency-Key
 *   GET  /api/v1/search?q=&limit=                            — private, ⌘K search
 *   POST /api/v1/subject/merge                               — private, scope `merge`
 *
 * ── Identity: signed, or not served at all
 *
 * The four endpoints above the line are PUBLIC. Everything else is PRIVATE and
 * requires BOTH halves of what the workspace sends:
 *
 *   X-Workspace-Api-Key  the shared service key — proves the caller is
 *                        the workspace.
 *   X-Workspace-Token    an HS256 identity token — iss
 *                        workspace.xray.tech, aud = our slug, sub = the user's
 *                        email — proves WHO the call is for. Verified against
 *                        EMBED_KEY exactly as docs/contract.md says.
 *
 * A `?email=` / `?companyId=` query string is a ROUTING HINT and nothing more.
 * It is never an identity: with no valid token this service answers 401, and a
 * hint that contradicts the token is 403 — never quietly honoured. An earlier
 * version of this fixture scoped reads by the bare hint so the old
 * certification harness (which carried no credentials) could probe it; that
 * taught the exact defect the platform must not ship, and it is gone.
 *
 * With EMBED_KEY or WORKSPACE_API_KEY unset, the private paths FAIL CLOSED
 * (401) rather than degrading to hint-scoped reads. The public four still
 * answer, so a bare `node server.mjs` remains useful for a smoke test.
 *
 * Data is scoped by the verified `sub`, so identity A can never list or read
 * identity B's records — which is what `cross_tenant_list` and
 * `cross_tenant_record` prove.
 *
 * ── One fixture affordance, stated plainly
 *
 * `listFor()` seeds three to-dos the first time an identity is seen, so the
 * harness always has a record to run the isolation probes against. That is a
 * FIXTURE convenience. A production app is expected to provision its own data
 * for the canary tenants certification uses; the harness will not certify an
 * app whose authenticated list comes back empty (it reports insufficient
 * evidence rather than a pass), and it must never be given a public or
 * probe-only resource that exists solely to turn a probe green.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 4801);
// Service ids are lowercase letters and digits only (3–32): no hyphen.
const SLUG = process.env.SERVICE_SLUG ?? "sduitodo";
const EMBED_KEY = process.env.EMBED_KEY ?? null;
const WORKSPACE_API_KEY = process.env.WORKSPACE_API_KEY ?? null;
const ISSUER = "workspace.xray.tech";
const VERSION = "1.0.0";
const SKEW_SECONDS = 30;

// ── identity ────────────────────────────────────────────────────────────────

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** The identity token: HS256 only, signature with the embed key, iss/aud/exp/iat checked. */
export function verifyWorkspaceToken(
  token,
  key,
  { now = Math.floor(Date.now() / 1000), aud = SLUG } = {},
) {
  if (typeof token !== "string") return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header?.alg !== "HS256") return { ok: false, reason: "alg" };
  const expected = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(s));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature" };
  if (claims.iss !== ISSUER) return { ok: false, reason: "iss" };
  if (claims.aud !== aud) return { ok: false, reason: "aud" };
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now)
    return { ok: false, reason: "exp" };
  if (typeof claims.iat === "number" && claims.iat - SKEW_SECONDS > now)
    return { ok: false, reason: "iat" };
  if (typeof claims.sub !== "string" || !claims.sub.includes("@"))
    return { ok: false, reason: "sub" };
  return { ok: true, email: claims.sub.trim().toLowerCase(), claims };
}

/** For tests and local demos: mint a token the way the workspace does. */
export function mintTestToken(
  key,
  {
    sub,
    aud = SLUG,
    companyId,
    scope = ["read"],
    now = Math.floor(Date.now() / 1000),
    ttl = 300,
    alg = "HS256",
  } = {},
) {
  const h = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const claims = { iss: ISSUER, aud, sub, scope, iat: now, exp: now + ttl, jti: randomUUID() };
  if (companyId) claims.companyId = companyId;
  const p = b64url(JSON.stringify(claims));
  const s = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

/**
 * Resolve the caller's identity from the SIGNED token only.
 *
 * A hint that agrees with the token is ignored (it adds nothing); a hint that
 * disagrees is refused outright with 403, so the answer to "whose data is
 * this?" can never be two different things at once. Returning the token's data
 * anyway would also be defensible — refusing is louder, and it is the shape the
 * other reference app uses, so a developer reading either sees one contract.
 */
function resolveIdentity(req, url, { embedKey, slug }) {
  const token = req.headers["x-workspace-token"];
  if (typeof token !== "string" || token.length === 0) {
    return { error: "no identity token", status: 401, code: "UNAUTHENTICATED" };
  }
  const verified = verifyWorkspaceToken(token, embedKey, { aud: slug });
  if (!verified.ok) {
    return { error: `token rejected (${verified.reason})`, status: 401, code: "UNAUTHENTICATED" };
  }

  const emailHint = url.searchParams.get("email")?.trim().toLowerCase();
  if (emailHint && emailHint !== verified.email) {
    return {
      error: "the query hint names a different subject than the signed token",
      status: 403,
      code: "IDENTITY_MISMATCH",
    };
  }
  const companyHint = url.searchParams.get("companyId")?.trim();
  if (companyHint && verified.claims.companyId && companyHint !== verified.claims.companyId) {
    return {
      error: "the query hint names a different company than the signed token",
      status: 403,
      code: "IDENTITY_MISMATCH",
    };
  }
  return {
    email: verified.email,
    companyId: verified.claims.companyId ?? null,
    scope: verified.claims.scope,
  };
}

function apiKeyOk(req, apiKey) {
  const sent = req.headers["x-workspace-api-key"];
  if (typeof sent !== "string") return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── data: one to-do list per identity ───────────────────────────────────────

const lists = new Map(); // email → Map<id, todo>
/** Ids of the seeded starter to-dos: each person has at most one of each. */
const starterIds = new Set();

/**
 * Seed three to-dos the first time an identity is seen. FIXTURE AFFORDANCE —
 * see the header note: it exists so the harness always has a record to prove
 * isolation against, not as a pattern a production app should copy. It is not
 * a probe-only branch: every identity takes this path, so a service cannot use
 * it to recognise certification.
 */
function listFor(email) {
  if (!lists.has(email)) {
    const seeded = new Map();
    for (const title of ["Read the manifest contract", "Run certification", "Submit for review"]) {
      const id = randomUUID();
      seeded.set(id, { id, title, done: false, createdAt: new Date().toISOString() });
      starterIds.add(id);
    }
    lists.set(email, seeded);
  }
  return lists.get(email);
}

// ── responses ───────────────────────────────────────────────────────────────

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}
const ok = (res, data, status = 200) => send(res, status, { data });
const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

export const manifest = {
  service: SLUG,
  displayName: "SDUI To-do",
  contractVersion: "v1",
  tagline: "A to-do list rendered entirely by the workspace",
  description:
    "The developer platform's runnable fixture: every required endpoint, server-driven pages, one form action, tenant isolation by identity.",
  requiredTier: "free",
  // `search`: every service serves search, so the workspace's ⌘K finds its
  // records. `GET /api/v1/search` below; certification probes it.
  // `merge`: every service can fold one person into another when the
  // workspace links their emails or unifies two accounts.
  // `POST /api/v1/subject/merge` below; certification probes it.
  capabilities: { pages: true, events: false, search: true, merge: true },
  requestedGrants: {
    identity: { companyId: false, tier: false, tools: false },
    facts: [],
    events: [],
    embed: false,
    byokRelayPaths: [],
  },
  certification: {
    healthPath: "/api/v1/health",
    resourcePath: "/api/v1/resources",
    recordPathTemplate: "/api/v1/resources/{id}",
  },
};

function pageDocument(email) {
  const todos = [...listFor(email).values()];
  const open = todos.filter((t) => !t.done);
  return {
    blockVersion: "v1",
    title: "My to-dos",
    // The line under the workspace's top bar (which shows `title`).
    subtitle: `Your to-dos, as ${email}`,
    blocks: [
      { type: "heading", text: "Today", level: 2 },
      {
        type: "stat",
        label: "Open",
        value: String(open.length),
        emphasis: open.length ? "strong" : "muted",
      },
      {
        type: "table",
        columns: [
          { key: "title", label: "Task" },
          { key: "state", label: "State" },
        ],
        rows: todos.map((t) => ({ title: t.title, state: t.done ? "Done" : "Open" })),
      },
      {
        type: "form",
        fields: [{ type: "text", name: "title", label: "What needs doing?", required: true }],
        submit: { id: "add-todo", label: "Add", style: "primary" },
      },
    ],
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const idempotencySeen = new Map(); // key → result

// ── subject merge (MICROSERVICE-API-SPEC §6.6) ──────────────────────────────

const MERGE_REASONS = new Set(["linked_email", "account_unify", "support"]);
const MAX_MERGE_EMAILS = 11; // a primary and up to 10 linked addresses
/**
 * The audit trail and the idempotency record: requestId → the answer given.
 * A real service keeps it durably; there is no unmerge endpoint, so support
 * reverses a mistaken merge from it.
 */
const merges = new Map();
/** absorbed email → survivor email. */
const foldedInto = new Map();

const isEmail = (value) =>
  typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value.trim());
const isEmailList = (value) =>
  Array.isArray(value) && value.length <= MAX_MERGE_EMAILS && value.every(isEmail);
const hasOnly = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

/** The §6.6 request shape, strictly: an unknown key is a 400, not ignored. */
export function parseMergeRequest(body) {
  if (!hasOnly(body, ["requestId", "from", "to", "reason"])) return null;
  const { requestId, from, to, reason } = body;
  if (typeof requestId !== "string" || !requestId.trim() || requestId.trim().length > 64)
    return null;
  if (!hasOnly(from, ["emails"]) || !isEmailList(from.emails) || from.emails.length === 0)
    return null;
  if (!hasOnly(to, ["email", "emails"]) || !isEmail(to.email) || !isEmailList(to.emails))
    return null;
  if (!MERGE_REASONS.has(reason)) return null;
  const normal = (email) => email.trim().toLowerCase();
  return {
    requestId: requestId.trim(),
    reason,
    fromEmails: [...new Set(from.emails.map(normal))],
    toEmail: normal(to.email),
  };
}

/**
 * Fold `fromEmails` into `toEmail`. To-dos are keyed by email alone, so the
 * whole list moves. The survivor wins collisions: an absorbed starter to-do
 * the survivor already has is dropped and reported in `conflicts`. Nothing
 * else is dropped — a merge moves data, it does not erase it.
 *
 * Reads `lists` directly, never `listFor`: a merge must not seed a starter
 * list for someone this app has never seen.
 */
function mergeSubjects({ requestId, fromEmails, toEmail }) {
  const seen = merges.get(requestId);
  if (seen) return { answer: seen };
  if (foldedInto.has(toEmail)) return { conflict: true };

  const survivor = lists.get(toEmail) ?? new Map();
  const survivorTitles = new Set(
    [...survivor.values()].filter((t) => starterIds.has(t.id)).map((t) => t.title),
  );
  let moved = 0;
  let dropped = 0;
  for (const email of fromEmails) {
    const absorbed = lists.get(email);
    if (!absorbed) continue;
    for (const todo of absorbed.values()) {
      if (starterIds.has(todo.id) && survivorTitles.has(todo.title)) {
        starterIds.delete(todo.id);
        dropped += 1;
        continue;
      }
      if (starterIds.has(todo.id)) survivorTitles.add(todo.title);
      survivor.set(todo.id, todo);
      moved += 1;
    }
    lists.delete(email);
  }
  const changed = moved + dropped > 0;
  if (changed) lists.set(toEmail, survivor);

  const alreadyFolded = fromEmails.every((email) => foldedInto.get(email) === toEmail);
  const status = changed || alreadyFolded ? "done" : "nothing_to_merge";
  if (status === "done") {
    for (const email of fromEmails) foldedInto.set(email, toEmail);
    // A chain never leaves anyone pointing at an absorbed address.
    for (const [email, into] of foldedInto) {
      if (fromEmails.includes(into)) foldedInto.set(email, toEmail);
    }
  }
  const answer = {
    requestId,
    status,
    moved: changed ? { todos: moved } : {},
    conflicts: dropped > 0 ? [{ label: "starter_todos", kept: "to", count: dropped }] : [],
  };
  merges.set(requestId, answer);
  return { answer };
}

export function createApp({ slug = SLUG, embedKey = EMBED_KEY, apiKey = WORKSPACE_API_KEY } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    // The required four, public, never redirected.
    if (method === "GET" && path === "/api/v1/health") return ok(res, { status: "ok" });
    if (method === "GET" && path === "/api/v1/ready") return ok(res, { status: "ready" });
    if (method === "GET" && path === "/api/v1/version") return ok(res, { version: VERSION });
    if (method === "GET" && path === "/api/v1/manifest") return ok(res, manifest);

    if (!path.startsWith("/api/v1/")) return fail(res, 404, "NOT_FOUND", "Not found.");

    // ── Everything below this line is PRIVATE ────────────────────────────────
    // Fail closed when this instance has no way to verify a caller: an
    // unconfigured service serves nothing rather than serving everything.
    if (!embedKey || !apiKey) {
      return fail(
        res,
        401,
        "UNAUTHENTICATED",
        "This instance has no service key or embed key configured, so private paths are closed.",
      );
    }
    // The service key: proves the caller is the workspace. Checked before the token so a caller
    // that is not the workspace never reaches the identity layer at all.
    if (!apiKeyOk(req, apiKey)) {
      return fail(res, 401, "UNAUTHENTICATED", "Bad or missing service key.");
    }
    // The identity token: who the call is for. Signed, or refused.
    const identity = resolveIdentity(req, url, { embedKey, slug });
    if (identity.error) return fail(res, identity.status, identity.code, identity.error);
    const { email } = identity;

    if (method === "GET" && path === "/api/v1/resources") {
      const items = [...listFor(email).values()];
      return ok(res, { items });
    }
    const record = path.match(/^\/api\/v1\/resources\/([^/]+)$/);
    if (method === "GET" && record) {
      // Another identity's id is simply not found here: that is the isolation.
      const todo = listFor(email).get(record[1]);
      return todo ? ok(res, todo) : fail(res, 404, "NOT_FOUND", "No such record.");
    }

    // Search, for the workspace's ⌘K: this identity's own
    // to-dos and nothing else — the same rows `/api/v1/resources` serves. `q`
    // and `limit` only; who is asking is the signed token's answer. Results
    // link inside this app, to the page that lists them.
    if (method === "GET" && path === "/api/v1/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (q.length < 2 || q.length > 200) {
        return fail(res, 400, "VALIDATION_ERROR", "q must be 2 to 200 characters.");
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 10);
      const words = q.split(/\s+/).filter(Boolean);
      const results = [...listFor(email).values()]
        .filter((todo) => words.every((word) => todo.title.toLowerCase().includes(word)))
        .slice(0, limit)
        .map((todo) => ({
          id: todo.id,
          service: slug,
          type: "todo",
          title: todo.title,
          snippet: todo.done ? "Done" : "To do",
          deepLink: `/svc/${slug}/today`,
          score: todo.title.toLowerCase().startsWith(q) ? 0.9 : 0.6,
        }));
      return ok(res, { results });
    }

    // Subject merge: the workspace folds one person into another. The same
    // two credentials, with a token of scope `merge` whose `sub` is the
    // survivor; who is absorbed rides in the body, never the URL. Idempotent
    // on `requestId`.
    if (method === "POST" && path === "/api/v1/subject/merge") {
      const scope = identity.scope;
      if (!Array.isArray(scope) || !scope.includes("merge")) {
        return fail(
          res,
          403,
          "SCOPE_INSUFFICIENT",
          "A subject merge needs a token of scope merge.",
        );
      }
      const request = parseMergeRequest(await readJson(req));
      if (!request) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          "Send requestId, from.emails, to.email, to.emails and reason.",
        );
      }
      if (request.fromEmails.includes(request.toEmail)) {
        return fail(res, 400, "VALIDATION_ERROR", "The survivor cannot also be absorbed.");
      }
      if (request.toEmail !== email) {
        return fail(res, 403, "IDENTITY_MISMATCH", "to.email does not match the signed token.");
      }
      const result = mergeSubjects(request);
      if (result.conflict) {
        return fail(res, 409, "MERGE_CONFLICT", "to has itself been merged into another person.");
      }
      return ok(res, result.answer);
    }

    if (method === "GET" && path === "/api/v1/pages") {
      return ok(res, { pages: [{ id: "today", title: "My to-dos" }] });
    }
    const page = path.match(/^\/api\/v1\/pages\/([^/]+)$/);
    if (method === "GET" && page) {
      return page[1] === "today"
        ? ok(res, pageDocument(email))
        : fail(res, 404, "NOT_FOUND", "No such page.");
    }
    const action = path.match(/^\/api\/v1\/actions\/([^/]+)$/);
    if (method === "POST" && action) {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8) {
        return fail(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header.");
      }
      const seenKey = `${email}:${key}`;
      if (idempotencySeen.has(seenKey)) return ok(res, idempotencySeen.get(seenKey));
      const body = await readJson(req);
      if (body === null) return fail(res, 400, "INVALID_JSON", "Body must be JSON.");
      let result;
      if (action[1] === "add-todo") {
        const title = String(body?.values?.title ?? body?.title ?? "").trim();
        if (!title) result = { ok: false, message: "Give the task a title." };
        else {
          const id = randomUUID();
          listFor(email).set(id, { id, title, done: false, createdAt: new Date().toISOString() });
          result = { ok: true, message: `Added "${title}".`, refresh: true };
        }
      } else {
        result = { ok: false, message: "Unknown action." };
      }
      idempotencySeen.set(seenKey, result);
      return ok(res, result);
    }

    return fail(res, 404, "NOT_FOUND", "Not found.");
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const server = createApp();
  server.listen(PORT, () => {
    // Report the port actually bound, so `PORT=0` (an ephemeral port, which is
    // how the end-to-end test starts this) is usable.
    const bound = server.address()?.port ?? PORT;
    console.log(`sdui-todo fixture listening on http://localhost:${bound} as "${SLUG}"`);
    console.log(
      EMBED_KEY && WORKSPACE_API_KEY
        ? "identity: requiring X-Workspace-Api-Key + a verified X-Workspace-Token"
        : "identity: NOT CONFIGURED — private paths are closed (set WORKSPACE_API_KEY and EMBED_KEY)",
    );
  });
}
