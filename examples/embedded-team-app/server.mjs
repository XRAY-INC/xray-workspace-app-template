#!/usr/bin/env node
/* eslint-disable no-console -- a runnable fixture: stdout is its interface. */
/**
 * embedded-team-app — a runnable reference for a FULL-PAGE embedded service.
 *
 *   node examples/embedded-team-app/server.mjs
 *
 * The other fixture, `examples/sdui-todo`, is the server-driven-UI shape: the
 * workspace renders your blocks. This one is the other shape, the full-page
 * embed: the workspace frames YOUR page, cross-origin and sandboxed, and your
 * page has to establish who the viewer is without ever getting a session.
 *
 * Read the three boundaries in order — they are the whole example:
 *
 *  1. `public/protocol.mjs` — the handshake. We announce `xray:embed:ready`;
 *     we accept `xray:embed:token` only from the configured workspace origin
 *     AND from `window.parent`. The token lives in a variable in the page. It
 *     never touches the URL, `localStorage`, or a log line.
 *
 *  2. `identity-token.mjs` — the identity token. HS256 only, signature checked in
 *     constant time, issuer pinned to workspace.xray.tech, audience pinned to
 *     our slug, and exp/iat/jti/sub/scope/companyId all mandatory with the
 *     ≤300s lifetime ceiling enforced here, not just at mint.
 *
 *  3. `authorize.mjs` — current authorization. Before anything protected we
 *     ask the workspace what is true NOW. That call carries the service API
 *     key, which lives only in this process; the browser never sees it, and
 *     the browser's bearer token is never a substitute for it.
 *
 * The service credential and the user identity are two different facts. A
 * request holding only `X-Workspace-Api-Key` is a request from the platform,
 * not from a person, and it can read nothing user-scoped here.
 *
 * EXPERIMENTAL by design: no real user data, in-memory storage, one process.
 * See README.md for what a real deployment has to add.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { parseExampleConfig } from "./config.mjs";
import { isRealTenant, verifyIdentityToken } from "./identity-token.mjs";
import { authorizeRequest } from "./authorize.mjs";
import { createStore } from "./store.mjs";
import { themeFromSearch } from "./public/protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 8 * 1024;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "DELETE"]);
/**
 * Scopes that may change data. `read` is not one of them: the workspace mints
 * a read-scoped token for proxy reads, and it must not be spendable on a
 * mutation. `embed` is here because the framed app is the interactive surface
 * — which is a licence to act as yourself, not a licence to act as an admin.
 */
const WRITE_SCOPES = Object.freeze(["write", "embed"]);

// ── request schemas ─────────────────────────────────────────────────────────
// `.strict()` is doing real work here. It is what makes a body carrying
// `companyId`, `email` or `orgRole` a 400 rather than a silent ignore: this
// app takes identity from the verified token and the callback, never from
// something the caller typed. A rejected extra key is a loud "you cannot say
// who you are"; a stripped one teaches the wrong lesson.
const addNoteSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();
const noteIdSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(128);

// ── responses ───────────────────────────────────────────────────────────────

function send(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Length": Buffer.byteLength(json),
    ...extraHeaders,
  });
  res.end(json);
}
const ok = (res, data, status = 200) => send(res, status, { data });
/**
 * Every error a client sees is one of a fixed set of codes and a sentence
 * written by us. No exception message, no stack, no path, no upstream detail —
 * the denial reason from the callback is for OUR log, not for the caller.
 */
const fail = (res, status, code, message, extraHeaders) =>
  send(res, status, { error: { code, message } }, extraHeaders);

function logEvent(level, event, fields = {}) {
  // Structured, and deliberately incapable of carrying a token: only the
  // fields named here are ever emitted.
  console[level === "error" ? "error" : "log"](JSON.stringify({ level, event, ...fields }));
}

// ── static assets, read once, served by exact name ──────────────────────────
// A fixed table instead of a path join: there is no filename a request can
// supply, so there is no traversal to defend against.
const ASSETS = new Map([
  ["/embed/protocol.mjs", ["public/protocol.mjs", "text/javascript; charset=utf-8"]],
  ["/embed/app.mjs", ["public/app.mjs", "text/javascript; charset=utf-8"]],
  ["/embed/app.css", ["public/app.css", "text/css; charset=utf-8"]],
]);
const assetCache = new Map();
function asset(path) {
  if (!assetCache.has(path)) {
    const [file, type] = ASSETS.get(path);
    assetCache.set(path, { body: readFileSync(join(HERE, file)), type });
  }
  return assetCache.get(path);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * The frame page's CSP.
 *
 * `frame-ancestors` names the ONE origin allowed to frame us — the
 * certification harness checks exactly this, and it is what stops any other
 * site from wrapping this page and phishing the handshake. Everything else is
 * `'self'`: our script and our stylesheet are files this process serves, so
 * there is no `'unsafe-inline'`, no `'unsafe-eval'`, and no CDN anywhere in
 * the example. `X-Frame-Options` is deliberately NOT set — it has no
 * allow-list, so setting it would override `frame-ancestors` with DENY.
 */
function embedCsp(workspaceOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${workspaceOrigin}`,
  ].join("; ");
}

function embedHtml(config, theme = null) {
  // The workspace origin is public configuration, not a secret — it is in the
  // CSP header on this very response. It reaches the script as a meta
  // attribute so the page still needs no inline <script>.
  //
  // `theme` is the workspace's mode from the frame URL (`?theme=`, theme
  // handoff v1), already narrowed to "light" or "dark" by `themeFromSearch`.
  // Rendering it into the markup is what lets the FIRST paint be right: a
  // module script runs too late to stop a flash of the OS palette.
  const themeAttribute = theme ? ` data-theme="${theme}"` : "";
  return `<!doctype html>
<html lang="en"${themeAttribute}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="xray-workspace-origin" content="${escapeHtml(config.workspaceOrigin)}" />
    <title>Team notes</title>
    <link rel="stylesheet" href="/embed/app.css" />
    <script type="module" src="/embed/app.mjs"></script>
  </head>
  <body>
    <main id="app">
      <!-- The workspace names this page: its top bar shows the app's
           displayName and the line under it is the manifest's tagline, above
           this frame. So the page's
           <h1> is for screen readers only — a visible one would be the same
           title twice — and the content starts right under the workspace's
           header. -->
      <h1 class="sr-only">Team notes</h1>
      <p id="status" role="status">Connecting to your workspace&hellip;</p>
      <div id="alert" role="alert" hidden></div>

      <section id="signed-in" hidden>
        <h2>Add a note</h2>
        <form id="add-form">
          <label for="note-title">Note</label>
          <input id="note-title" name="title" type="text" maxlength="200" required
                 autocomplete="off" />
          <button type="submit">Add note</button>
        </form>

        <h2>My notes</h2>
        <ul id="my-notes"></ul>
        <p id="my-notes-empty" hidden>You have not written a note yet.</p>

        <section id="admin-plane" hidden>
          <h2>Everyone&rsquo;s notes</h2>
          <p>Owners and admins can remove any note in the organisation.</p>
          <ul id="org-notes"></ul>
        </section>
      </section>

      <details id="handshake-log">
        <summary>Handshake log</summary>
        <p>What this page accepted or ignored, and why. Tokens are never shown.</p>
        <ul id="handshake-log-items"></ul>
      </details>
    </main>
  </body>
</html>
`;
}

// ── manifest ────────────────────────────────────────────────────────────────

export function buildManifest(config) {
  return {
    service: config.slug,
    displayName: "Embedded Team Notes",
    contractVersion: "v1",
    tagline: "A full-page embedded app that proves who its viewer is",
    description:
      "Reference implementation of the XRAY Workspace embed handshake: postMessage token exchange, identity-token verification, and a current-authorization callback before sensitive operations.",
    requiredTier: "free",
    capabilities: {
      pages: true,
      events: false,
      // The path the reviewer ticks when approving the embed. Must be the
      // path whose CSP names the workspace in frame-ancestors.
      embed: { path: "/embed" },
      // Every service serves search, so the workspace's ⌘K finds its records.
      // `GET /api/v1/search` below; certification probes it.
      search: true,
    },
    requestedGrants: {
      identity: {
        // Required: this app is tenant-scoped, and the tenant IS companyId.
        companyId: true,
        tier: false,
        tools: false,
        // Required for the role data the admin plane depends on. The
        // workspace also needs FEATURE_ACCESS_CLAIMS on for access data to be
        // resolved at all — without either, the callback returns no usable
        // role and this app's admin plane simply never opens (fail closed).
        access: true,
      },
      facts: [],
      events: [],
      embed: true,
      byokRelayPaths: [],
    },
    certification: {
      healthPath: "/api/v1/health",
      resourcePath: "/api/v1/resources",
      recordPathTemplate: "/api/v1/resources/{id}",
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True only for the platform's own calls. Proves a caller, never a person. */
function hasServiceKey(req, config) {
  const sent = req.headers["x-workspace-api-key"];
  return typeof sent === "string" && constantTimeEquals(sent, config.workspaceApiKey);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) return { error: "too_large" };
    chunks.push(chunk);
  }
  if (total === 0) return { value: {} };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "not_object" };
    }
    return { value: parsed };
  } catch {
    return { error: "malformed" };
  }
}

/**
 * ── Two gates, and where the line between them sits ─────────────────────────
 *
 * Not every request can afford the same check, and pretending otherwise
 * breaks something real in both directions.
 *
 * OFFLINE (verify the token, do not call the workspace):
 *   Reading your OWN rows. The token is signed, unexpired and ≤300s old, and
 *   that is a bounded, stated staleness: after a revocation, someone can read
 *   their own notes for up to five more minutes. That window is the price of
 *   two things worth having — a page that works when the workspace is slow,
 *   and a service that can be CERTIFIED at all (see below).
 *
 * ONLINE (call `/api/v1/registry/{slug}/authorize` first, fail closed):
 *   Everything sensitive. Writes. Anything that touches another person's
 *   rows. Anything that reports a role. These never run on a stale claim.
 *
 * ── Why the certification surface cannot be online-gated ────────────────────
 *
 * Certification runs BEFORE the service is LIVE and before any org has
 * installed it — the exact state the authorize callback refuses. A resource
 * handler that called authorize would be uncertifiable: the harness could
 * never get a 200, and the service could never reach the LIVE state that
 * would let it. The answer is NOT to soften authorize, and it is NOT to build
 * a probe-only surface either.
 *
 * Certification is explicit that the harness probes the REAL handlers with
 * identities indistinguishable from real users, precisely so a service cannot
 * behave honestly for the probe and leak at runtime. `/api/v1/resources`
 * therefore reads the SAME rows, through the SAME owner-scoped accessors, as
 * everything else. There is no certification code path.
 *
 * ── Offline does not mean unauthenticated ───────────────────────────────────
 *
 * Skipping the callback is NOT the same as skipping authentication, and the
 * distinction is the whole point. Every request to `/api/v1/resources` must
 * carry BOTH:
 *
 *   · `X-Workspace-Api-Key` — proves the CALLER is the platform (or the
 *     harness acting as it), and
 *   · a signed identity token — proves WHO the request is for.
 *
 * Neither alone is sufficient: the service key is a caller credential and
 * says nothing about a person, and a token arriving from an unknown caller is
 * not something this surface serves.
 *
 * `?email=` is a ROUTING HINT and nothing more. It can never introduce,
 * change or widen a signed identity: if it disagrees with the token's `sub`,
 * the request is refused outright rather than quietly resolved in either
 * direction. An earlier draft of this fixture served the hint alone, on the
 * grounds that the certification harness sent nothing else. That was a
 * defect in the harness, not a property of the contract, and it is being
 * fixed there — a public read path is never the right answer.
 *
 * The browser's own endpoints (`/app/*`) are bearer-only by design: they are
 * called from the framed page, which has a token and must never hold the
 * service key.
 */
function bearerToken(req) {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * A person's first read provisions their starter note.
 *
 * This is ordinary first-use behaviour — a new member's notes are not empty —
 * and it is the SAME code path for everyone. It also happens to be what lets
 * the harness run its isolation checks at all: an empty list gives it no
 * record to probe with, and it treats that as a non-pass rather than letting
 * a service dodge the negative test by answering `[]`.
 */
const STARTER_NOTE = "Welcome to Team Notes";

// ── the app ─────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {object} options.config           parsed example config
 * @param {Function} [options.authorize]    the online boundary; stub it in tests
 * @param {() => number} [options.now]      injectable clock (ms)
 */
export function createApp(options) {
  const config = options.config;
  const store = options.store ?? createStore();
  const now = options.now ?? (() => Date.now());
  // The clock is handed down as a FUNCTION, never as a pre-await snapshot.
  const authorize = options.authorize ?? ((args) => authorizeRequest({ ...args, config }));
  const manifest = buildManifest(config);
  /** key → {status, body}. Bounded; a fixture, not a durable ledger. */
  const idempotency = new Map();

  /**
   * Turn a bearer token into a decision. Three checks, all mandatory, in this
   * order: verify the signature and bounds ourselves; enforce the SCOPE the
   * workspace minted the token with; then ask the workspace what is true now.
   * Fails closed at every branch.
   *
   * The three are independent and none substitutes for another:
   *   · The signature says the token is ours and unaltered.
   *   · The scope says what this token was minted TO DO. A read-scoped proxy
   *     token is not a licence to mutate, however senior its holder is, and a
   *     successful callback does not launder it into one — the callback
   *     answers "who, and what role, right now", not "ignore the scope".
   *   · The role says what this person may do, and it comes from the callback
   *     only. `embed` scope opens the app; it does not confer an admin grant.
   *
   * `intent.sensitive` decides whether the third check runs. See the long
   * note above `bearerToken`: reading your own rows is offline and bounded by
   * the ≤300s token lifetime; everything sensitive is online and fails
   * closed. `mutating` implies `sensitive` — a write is never offline.
   *
   * @param {import("node:http").IncomingMessage} req
   * @param {{mutating?: boolean, sensitive?: boolean}} [intent]
   */
  async function authenticate(req, intent = {}) {
    const token = bearerToken(req);
    if (!token) {
      return {
        error: [401, "UNAUTHENTICATED", "Send the workspace identity token as a bearer token."],
      };
    }

    const verified = verifyIdentityToken(token, {
      secrets: config.embedKeys,
      audience: config.slug,
      now: Math.floor(now() / 1000),
      // No `requireScope` here: the scope gate is per OPERATION, below. A
      // read-scoped token is a legitimate token — it just cannot write.
    });
    if (!verified.ok) {
      logEvent("warn", "token_rejected", { reason: verified.reason });
      // Only a genuinely expired token earns the code that tells the browser
      // to re-handshake. Every other rejection is just "no".
      return verified.reason === "expired"
        ? { error: [401, "TOKEN_EXPIRED", "That workspace token has expired."] }
        : { error: [401, "UNAUTHENTICATED", "That workspace token was not accepted."] };
    }
    const identity = verified.identity;

    // Scope, per operation. Checked BEFORE the callback, so a read-only token
    // never even causes a write to be considered.
    if (intent.mutating && !WRITE_SCOPES.some((scope) => identity.scope.includes(scope))) {
      logEvent("warn", "scope_insufficient", { scope: identity.scope.join(",") });
      return {
        error: [
          403,
          "SCOPE_INSUFFICIENT",
          "This workspace token may only read. Open the app from the workspace to make changes.",
        ],
      };
    }

    // The tenant has to be a real org before we will store or read anything
    // under it. The workspace already refuses demo Subjects an embed token;
    // this is the second lock.
    if (!isRealTenant(identity.companyId)) {
      logEvent("warn", "synthetic_tenant_refused", {});
      return {
        error: [
          403,
          "TENANT_NOT_ELIGIBLE",
          "This app does not serve demo or synthetic organisations.",
        ],
      };
    }

    // OFFLINE path: reading your own rows. No callback, and therefore no
    // role — `isAdmin` is false by construction, so nothing that needs a role
    // can accidentally be served from here.
    if (!intent.sensitive && !intent.mutating) {
      return {
        identity,
        access: Object.freeze({
          email: identity.email,
          companyId: identity.companyId,
          orgRole: "UNVERIFIED",
          isAdmin: false,
          deptSlugs: [],
          roleSlugs: [],
          permissions: [],
          expiresAtMs: identity.expiresAt * 1000,
        }),
      };
    }

    const decision = await authorize({ token, identity, clock: now });
    if (!decision.ok) {
      logEvent("warn", "authorize_denied", { reason: decision.reason });
      if (decision.reason === "expired") {
        return { error: [401, "TOKEN_EXPIRED", "That workspace token has expired."] };
      }
      if (decision.reason === "forbidden") {
        return {
          error: [
            403,
            "NOT_AUTHORIZED",
            "Your workspace access to this app has changed. Re-open it from the workspace.",
          ],
        };
      }
      // Timeout, network, redirect, bad shape, mismatch — all the same to the
      // caller, and all a denial.
      return {
        error: [503, "AUTHORIZATION_UNAVAILABLE", "Could not confirm your access. Try again."],
      };
    }
    return { access: decision.access, identity };
  }

  /**
   * Is this authorization STILL good, right now?
   *
   * Authenticating is not a moment, it is the start of one. Between the
   * callback returning and the operation running there is an `await` on the
   * request body — time a client controls completely. A client that dribbles
   * out eight kilobytes over six minutes has an authorization decision made
   * before its token expired and a write attempted long after, and nothing
   * upstream will notice.
   *
   * So the decision is re-checked at the last possible instant: immediately
   * before a store mutation, before a privileged read is serialised, and
   * before an idempotency replay hands back a recorded answer. Cheap — one
   * comparison against a timestamp already computed — and it closes the whole
   * class of "slow body outlives authorization".
   *
   * `access.expiresAtMs` is already `min(token exp, callback expiry)`, so this
   * honours whichever runs out first.
   */
  function stillValid(access) {
    return now() < access.expiresAtMs;
  }
  const expiredNow = (res) =>
    fail(res, 401, "TOKEN_EXPIRED", "That workspace token expired before this could be completed.");

  /** Replay-safe mutation. Same key, same tenant, same person → same answer. */
  function withIdempotency(req, res, access, path, run) {
    const raw = req.headers["idempotency-key"];
    const key = idempotencyKeySchema.safeParse(raw);
    if (!key.success) {
      return fail(
        res,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Send an Idempotency-Key header of at least 8 characters.",
      );
    }
    // Last check before anything is written, or any recorded answer replayed.
    if (!stillValid(access)) return expiredNow(res);
    const scoped = JSON.stringify([access.companyId, access.email, req.method, path, key.data]);
    const seen = idempotency.get(scoped);
    if (seen) return send(res, seen.status, seen.body);
    const record = (status, body) => {
      if (idempotency.size > 5_000) idempotency.clear();
      idempotency.set(scoped, { status, body });
      return send(res, status, body);
    };
    return run(record);
  }

  const noteView = (note) => ({
    id: note.id,
    title: note.title,
    owner: note.ownerEmail,
    dept: note.dept ?? null,
    createdAt: note.createdAt,
  });

  /**
   * Identity for the resource surface: service key AND signed token, both
   * mandatory. See the long note above `bearerToken` for why, and for what
   * `?email=` is and is not.
   */
  function resolveResourceIdentity(req, url) {
    if (!hasServiceKey(req, config)) return { status: 401, code: "UNAUTHENTICATED" };

    const raw = req.headers["x-workspace-token"] ?? bearerToken(req);
    if (typeof raw !== "string" || raw.length === 0) {
      return { status: 401, code: "UNAUTHENTICATED" };
    }
    const verified = verifyIdentityToken(raw, {
      secrets: config.embedKeys,
      audience: config.slug,
      now: Math.floor(now() / 1000),
      // Any scope the workspace mints is fine for an owner-scoped read; the
      // certification harness signs its canary tokens with `read`.
    });
    if (!verified.ok) {
      logEvent("warn", "resource_token_rejected", { reason: verified.reason });
      return { status: 401, code: "UNAUTHENTICATED" };
    }

    // The hint may only AGREE with the signature. A disagreement is refused
    // outright — not resolved in favour of the token, and certainly not in
    // favour of the hint — because a caller that sends a contradictory hint
    // is asking for something it should not get, and silently answering the
    // "safe" half of the question teaches the wrong lesson.
    const hint = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (hint.length > 0 && hint !== verified.identity.email) {
      logEvent("warn", "resource_hint_mismatch", {});
      return { status: 403, code: "IDENTITY_MISMATCH" };
    }

    return { email: verified.identity.email, companyId: verified.identity.companyId };
  }

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return fail(res, 400, "BAD_REQUEST", "Unreadable request.");
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (!ALLOWED_METHODS.has(method)) {
      return fail(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
        Allow: "GET, HEAD, POST, DELETE",
      });
    }

    try {
      // ── the registered-service contract: public, never redirected ────────
      if (method === "GET" && path === "/api/v1/health") return ok(res, { status: "ok" });
      if (method === "GET" && path === "/api/v1/ready") return ok(res, { status: "ready" });
      if (method === "GET" && path === "/api/v1/manifest") return ok(res, manifest);

      // ── the framed page and its own assets ───────────────────────────────
      if (method === "GET" && path === "/embed") {
        const html = embedHtml(config, themeFromSearch(url.search));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": embedCsp(config.workspaceOrigin),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Length": Buffer.byteLength(html),
        });
        return res.end(html);
      }
      if (method === "GET" && ASSETS.has(path)) {
        const file = asset(path);
        res.writeHead(200, {
          "Content-Type": file.type,
          "Content-Security-Policy": "default-src 'none'",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Length": file.body.length,
        });
        return res.end(file.body);
      }

      // ── the real resource handlers (also what certification probes) ──────
      // Owner-scoped reads of the SAME rows the app writes. Service key AND
      // signed token, both required; no callback, so this works before the
      // service is live. See the long note above `bearerToken`.
      if (method === "GET" && path.startsWith("/api/v1/resources")) {
        const who = resolveResourceIdentity(req, url);
        if (who.code) {
          return fail(
            res,
            who.status,
            who.code,
            who.code === "IDENTITY_MISMATCH"
              ? "The requested identity does not match the signed token."
              : "This endpoint needs the service key and a signed identity token.",
          );
        }
        const record = path.match(/^\/api\/v1\/resources\/([^/]+)$/);
        if (record) {
          // Another identity's row is simply absent here — not forbidden,
          // absent. Existence does not leak across the boundary.
          const note = store.getForOwner(who.companyId, who.email, record[1]);
          return note ? ok(res, noteView(note)) : fail(res, 404, "NOT_FOUND", "No such record.");
        }
        if (path !== "/api/v1/resources") return fail(res, 404, "NOT_FOUND", "Not found.");
        // Lazy first-use provisioning, for ANY verified subject. Deliberately
        // not a canary branch: the harness's identities must be
        // indistinguishable from real users, so they take exactly
        // this path and get exactly these rows.
        const own = store.listOwn(who.companyId, who.email);
        if (own.length === 0) {
          const added = store.add({
            companyId: who.companyId,
            ownerEmail: who.email,
            title: STARTER_NOTE,
          });
          if (added.ok) own.push(added.note);
        }
        return ok(res, { items: own.map(noteView) });
      }

      // ── search: the workspace's ⌘K asks every app ──────────────────────
      // The same gate as the resources (service
      // key AND signed token), and the same rows: what this person can read
      // here is exactly what they can find from the workspace. `q` and
      // `limit` only — identity is the token's, never the URL's. Each result
      // links INSIDE this app (`/svc/<slug>`): `?at=` opens the frame at the
      // note.
      if (method === "GET" && path === "/api/v1/search") {
        const who = resolveResourceIdentity(req, url);
        if (who.code) {
          return fail(
            res,
            who.status,
            who.code,
            who.code === "IDENTITY_MISMATCH"
              ? "The requested identity does not match the signed token."
              : "This endpoint needs the service key and a signed identity token.",
          );
        }
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        if (q.length < 2 || q.length > 200) {
          return fail(res, 400, "VALIDATION_ERROR", "q must be 2 to 200 characters.");
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 10);
        const words = q.split(/\s+/).filter(Boolean);
        const results = store
          .listOwn(who.companyId, who.email)
          .filter((note) => words.every((word) => note.title.toLowerCase().includes(word)))
          .slice(0, limit)
          .map((note) => ({
            id: note.id,
            service: config.slug,
            type: "note",
            title: note.title,
            snippet: note.dept ? `Team note · ${note.dept}` : "Team note",
            deepLink: `/svc/${config.slug}?at=${encodeURIComponent(`/embed?note=${note.id}`)}`,
            score: note.title.toLowerCase().startsWith(q) ? 0.9 : 0.6,
          }));
        return ok(res, { results });
      }

      // ── server-driven pages: the platform's own call, service key only ───
      if (method === "GET" && path === "/api/v1/pages") {
        if (!hasServiceKey(req, config)) {
          return fail(res, 401, "UNAUTHENTICATED", "Missing or invalid service key.");
        }
        return ok(res, {
          pages: [{ id: "open", title: "Team notes", embedPath: "/embed" }],
        });
      }
      const pageMatch = path.match(/^\/api\/v1\/pages\/([^/]+)$/);
      if (method === "GET" && pageMatch) {
        if (!hasServiceKey(req, config)) {
          return fail(res, 401, "UNAUTHENTICATED", "Missing or invalid service key.");
        }
        if (pageMatch[1] !== "open") return fail(res, 404, "NOT_FOUND", "No such page.");
        // Deliberately carries no user data: this endpoint is authenticated by
        // a SERVICE credential, which says nothing about who is looking.
        return ok(res, {
          blockVersion: "v1",
          title: "Team notes",
          blocks: [
            { type: "heading", text: "Team notes", level: 2 },
            {
              type: "text",
              text: "This app renders its own page. Open it to sign in with your workspace identity.",
            },
          ],
        });
      }

      // ── the embedded page's own backend ──────────────────────────────────
      //
      // The routing table IS the security policy, so it is written out once
      // here rather than decided inside each handler. `sensitive` means the
      // authorization callback runs; without it the request is served from
      // the verified token alone, bounded by its ≤300s lifetime.
      //
      //   POST   /app/session        sensitive   reports a role
      //   GET    /app/notes          offline     your own rows
      //   GET    /app/notes/{id}     offline     your own row
      //   POST   /app/notes          sensitive   a write
      //   GET    /app/org-notes      sensitive   other people's rows, admin
      //   DELETE /app/org-notes/{id} sensitive   a write on another's row, admin
      if (path === "/app" || path.startsWith("/app/")) {
        const orgPlane = path === "/app/org-notes" || path.startsWith("/app/org-notes/");
        const mutating = method === "DELETE" || (method === "POST" && path !== "/app/session");
        const sensitive = mutating || orgPlane || path === "/app/session";
        const auth = await authenticate(req, { mutating, sensitive });
        if (auth.error) return fail(res, ...auth.error);
        const { access } = auth;

        if (method === "POST" && path === "/app/session") {
          // Everything the page is allowed to know about its viewer. Note
          // what is NOT here: the token, the service key, any other member.
          return ok(res, {
            email: access.email,
            companyId: access.companyId,
            orgRole: access.orgRole,
            isAdmin: access.isAdmin,
            deptSlugs: access.deptSlugs ?? [],
            roleSlugs: access.roleSlugs ?? [],
            permissions: access.permissions ?? [],
            expiresAt: new Date(access.expiresAtMs).toISOString(),
          });
        }

        // ── your own rows: offline, bounded by the token's lifetime ────────
        if (method === "GET" && path === "/app/notes") {
          return ok(res, { mine: store.listOwn(access.companyId, access.email).map(noteView) });
        }
        const noteMatch = path.match(/^\/app\/notes\/([^/]+)$/);
        if (method === "GET" && noteMatch) {
          const id = noteIdSchema.safeParse(noteMatch[1]);
          if (!id.success) return fail(res, 404, "NOT_FOUND", "No such note.");
          // Tenant-and-owner-scoped, not org-wide: this endpoint answers for your
          // own rows only. Someone else's note lives on the org plane, which
          // is online-gated. An admin reading it here still gets a 404.
          const note = store.getForOwner(access.companyId, access.email, id.data);
          return note ? ok(res, noteView(note)) : fail(res, 404, "NOT_FOUND", "No such note.");
        }

        // ── a write: online, and it needs write or embed scope ─────────────
        if (method === "POST" && path === "/app/notes") {
          const body = await readBody(req);
          if (body.error === "too_large") {
            return fail(res, 413, "PAYLOAD_TOO_LARGE", "That request body is too large.");
          }
          if (body.error) return fail(res, 400, "VALIDATION_ERROR", "Body must be a JSON object.");
          const parsed = addNoteSchema.safeParse(body.value);
          if (!parsed.success) {
            // Includes the interesting case: a body that tried to supply
            // companyId, email or orgRole. Identity is not user input.
            return fail(res, 400, "VALIDATION_ERROR", "Send only a note title, 1–200 characters.");
          }
          return withIdempotency(req, res, access, path, (record) => {
            const added = store.add({
              companyId: access.companyId,
              ownerEmail: access.email,
              title: parsed.data.title,
              dept: access.deptSlugs?.[0] ?? null,
            });
            if (!added.ok) {
              return record(409, {
                error: { code: "QUOTA_EXCEEDED", message: "You have enough notes." },
              });
            }
            logEvent("info", "note_added", { companyId: access.companyId });
            return record(201, { data: noteView(added.note) });
          });
        }

        // ── the organisation plane: other people's rows, admin only ────────
        // The role comes from the callback — what the workspace says NOW —
        // not from the token's `orole` claim, and not from the `pa`
        // platform-admin claim, which is an XRAY-staff fact and not an
        // org-role grant.
        if (orgPlane) {
          if (!access.isAdmin) {
            return fail(
              res,
              403,
              "ADMIN_REQUIRED",
              "Only an organisation owner or admin can see or remove other people's notes.",
            );
          }
          if (method === "GET" && path === "/app/org-notes") {
            // A privileged read of other people's rows: re-check before it is
            // serialised, not merely before it was decided.
            if (!stillValid(access)) return expiredNow(res);
            return ok(res, { notes: store.listTenant(access.companyId).map(noteView) });
          }
          const orgMatch = path.match(/^\/app\/org-notes\/([^/]+)$/);
          if (method === "DELETE" && orgMatch) {
            const id = noteIdSchema.safeParse(orgMatch[1]);
            if (!id.success) return fail(res, 404, "NOT_FOUND", "No such note.");
            return withIdempotency(req, res, access, path, (record) => {
              // Scoped by tenant, so an id from another org is a 404 — the
              // same answer as an id that never existed.
              const removed = store.removeInTenant(access.companyId, id.data);
              if (!removed) {
                return record(404, { error: { code: "NOT_FOUND", message: "No such note." } });
              }
              logEvent("info", "note_removed", { companyId: access.companyId });
              return record(200, { data: { removed: true } });
            });
          }
        }

        return fail(res, 404, "NOT_FOUND", "Not found.");
      }

      return fail(res, 404, "NOT_FOUND", "Not found.");
    } catch (error) {
      // The only place an unexpected throw can reach the client, and it
      // reaches it as five fixed words.
      logEvent("error", "unhandled", {
        path,
        method,
        kind: error instanceof Error ? error.name : "unknown",
      });
      if (!res.headersSent) return fail(res, 500, "INTERNAL_ERROR", "Something went wrong.");
      return res.end();
    }
  });
}

// ── entrypoint ──────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const parsed = parseExampleConfig(process.env);
  if (!parsed.ok) {
    console.error("embedded-team-app: refusing to start.");
    for (const issue of parsed.issues) console.error(`  · ${issue}`);
    console.error("See examples/embedded-team-app/.env.example.");
    process.exit(1);
  }
  const config = parsed.config;
  createApp({ config }).listen(config.port, () => {
    console.log(`embedded-team-app listening on http://127.0.0.1:${config.port}`);
    console.log(`  slug              ${config.slug}`);
    console.log(`  workspace origin  ${config.workspaceOrigin}`);
    console.log(`  embed page        /embed  (frame-ancestors ${config.workspaceOrigin})`);
    console.log(`  verification keys ${config.embedKeys.length}`);
  });
}
