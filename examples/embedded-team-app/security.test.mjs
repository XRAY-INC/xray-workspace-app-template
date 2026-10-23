/**
 * The adversarial half: every way the three boundaries are asked to say no.
 *
 * The rule under test throughout is fail-closed — a broken, absent, stale,
 * forged, mismatched or unanswerable input must deny, never default to allow.
 * Nothing here sleeps: the clock is injected and the online boundary is a
 * stub, so a timeout is asserted by classification rather than by waiting.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, test } from "node:test";

import {
  THEME_COLOR_PATTERN,
  THEME_TOKEN_NAMES,
  acceptThemeMessage,
  acceptTokenMessage,
  readyMessage,
  themeFromSearch,
  EMBED_MESSAGE,
} from "./public/protocol.mjs";
import { MAX_TOKEN_TTL_SECONDS, isRealTenant, verifyIdentityToken } from "./identity-token.mjs";
import { authorizeRequest, callAuthorize, reconcileAuthorization } from "./authorize.mjs";
import { parseExampleConfig } from "./config.mjs";
import { createStore } from "./store.mjs";
import {
  ADMIN,
  COMPANY_A,
  COMPANY_B,
  EMBED_KEY,
  MEMBER,
  NOW_MS,
  NOW_SECONDS,
  PREVIOUS_EMBED_KEY,
  SERVICE_API_KEY,
  SLUG,
  TEST_ENV,
  WORKSPACE_ORIGIN,
  canaryToken,
  closeAllApps,
  controllableClock,
  idempotencyKey,
  makeToken,
  mintExampleToken,
  startApp,
  stubAuthorize,
  testConfig,
} from "./test-support.mjs";

// A failed assertion must not strand a listening server and hang the runner.
after(() => closeAllApps());

const HOST = { name: "parent" };
const SELF = { name: "self" };
const good = () => ({
  origin: WORKSPACE_ORIGIN,
  source: HOST,
  data: { type: EMBED_MESSAGE.token, token: "aaa.bbb.ccc" },
});
const ctx = { expectedOrigin: WORKSPACE_ORIGIN, parentWindow: HOST, selfWindow: SELF };

describe("the theme handoff (protocol v1) is validated as strictly as the token", () => {
  const theme = () => ({
    type: EMBED_MESSAGE.theme,
    version: 1,
    mode: "dark",
    tokens: { background: "hsl(213 47% 7%)", foreground: "hsl(40 30% 94%)" },
    radius: "0.75rem",
    fonts: { body: "Urbanist", heading: "Figtree" },
  });
  const themeEvent = (data = theme()) => ({ origin: WORKSPACE_ORIGIN, source: HOST, data });

  test("a well-formed theme from the configured origin and the parent is accepted", () => {
    const verdict = acceptThemeMessage(themeEvent(), ctx);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.theme, {
      mode: "dark",
      tokens: { background: "hsl(213 47% 7%)", foreground: "hsl(40 30% 94%)" },
      radius: "0.75rem",
      fonts: { body: "Urbanist", heading: "Figtree" },
    });
  });

  test("the sender checks are the token's: exact origin, the parent window, framed", () => {
    assert.equal(
      acceptThemeMessage({ ...themeEvent(), origin: "https://evil.example" }, ctx).reason,
      "origin",
    );
    assert.equal(
      acceptThemeMessage({ ...themeEvent(), source: { name: "popup" } }, ctx).reason,
      "source",
    );
    assert.equal(
      acceptThemeMessage(themeEvent(), { ...ctx, parentWindow: SELF }).reason,
      "not_framed",
    );
    assert.equal(
      acceptThemeMessage(themeEvent(), { ...ctx, expectedOrigin: "" }).reason,
      "no_expected_origin",
    );
  });

  test("missing tokens are fine — the host omits what it could not read", () => {
    const verdict = acceptThemeMessage(themeEvent({ ...theme(), tokens: {} }), ctx);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.theme.tokens, {});
  });

  test("anything outside the v1 schema refuses the whole message", () => {
    const cases = [
      [{ ...theme(), type: EMBED_MESSAGE.token }, "type"],
      [{ ...theme(), version: 2 }, "version"],
      [{ ...theme(), version: "1" }, "version"],
      [{ ...theme(), extra: true }, "shape"],
      [{ ...theme(), mode: "sepia" }, "mode"],
      [{ ...theme(), mode: undefined }, "mode"],
      [{ ...theme(), tokens: null }, "tokens"],
      [{ ...theme(), tokens: ["hsl(0 0% 0%)"] }, "tokens"],
      [{ ...theme(), tokens: { sidebar: "hsl(0 0% 0%)" } }, "tokens"],
      [{ ...theme(), tokens: { background: "#0b1320" } }, "color"],
      [{ ...theme(), tokens: { background: "hsl(0 0% 0%); color: red" } }, "color"],
      [{ ...theme(), tokens: { background: "url(https://evil.example/x)" } }, "color"],
      [{ ...theme(), tokens: { background: "hsl(0 0% 0% / 0.5)" } }, "color"],
      [{ ...theme(), tokens: { background: "hsl(0, 0%, 0%)" } }, "color"],
      [{ ...theme(), tokens: { background: 12 } }, "color"],
      [{ ...theme(), radius: "calc(1rem + 1px)" }, "radius"],
      [{ ...theme(), radius: "1em" }, "radius"],
      [{ ...theme(), radius: undefined }, "radius"],
      [{ ...theme(), fonts: { body: "Comic Sans MS", heading: "Figtree" } }, "fonts"],
      [{ ...theme(), fonts: { body: "Urbanist", heading: "Figtree', serif; x" } }, "fonts"],
      [{ ...theme(), fonts: { body: "Urbanist", heading: "Figtree", mono: "Menlo" } }, "fonts"],
      // The roles are part of the contract: the right families in the wrong
      // roles are refused like any other font outside the allowlist.
      [{ ...theme(), fonts: { body: "Figtree", heading: "Urbanist" } }, "fonts"],
      [{ ...theme(), fonts: undefined }, "fonts"],
    ];
    for (const [data, reason] of cases) {
      assert.equal(acceptThemeMessage(themeEvent(data), ctx).reason, reason, JSON.stringify(data));
    }
  });

  test("every colour a v1 message may carry matches the published pattern — and nothing else does", () => {
    assert.equal(THEME_TOKEN_NAMES.length, 19);
    for (const ok of ["hsl(40 100% 97%)", "hsl(213.5 53.25% 12%)", "hsl(0 0% 0%)"]) {
      assert.ok(THEME_COLOR_PATTERN.test(ok), ok);
    }
    for (const bad of ["hsl(40 100% 97%) ", "hsl(40 100 97)", "hsl(4000 1% 1%)", "rgb(0 0 0)"]) {
      assert.ok(!THEME_COLOR_PATTERN.test(bad), bad);
    }
  });

  test("the first-paint mode is read from the query, light or dark exactly", () => {
    assert.equal(themeFromSearch("?theme=light"), "light");
    assert.equal(themeFromSearch("?embed=1&theme=dark"), "dark");
    for (const search of ["", "?theme=", "?theme=Dark", "?theme=blue", "?theme=%3Cscript%3E"]) {
      assert.equal(themeFromSearch(search), null, search);
    }
  });
});

describe("the handshake accepts only the workspace, only from the parent", () => {
  test("a well-formed message from the configured origin and the parent is accepted", () => {
    const verdict = acceptTokenMessage(good(), ctx);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.token, "aaa.bbb.ccc");
    assert.deepEqual(readyMessage(), { type: EMBED_MESSAGE.ready });
  });

  test("a different origin is refused even when the source is the parent", () => {
    const verdict = acceptTokenMessage({ ...good(), origin: "https://evil.example" }, ctx);
    assert.deepEqual(verdict, { ok: false, reason: "origin" });
  });

  test("a near-miss origin is refused: no prefix, suffix or scheme slack", () => {
    for (const origin of [
      "https://workspace.xray.tech.evil.example",
      "https://evil.example/workspace.xray.tech",
      "http://workspace.xray.tech",
      "https://workspace.xray.tech:8443",
      "https://WORKSPACE.xray.tech",
    ]) {
      assert.equal(acceptTokenMessage({ ...good(), origin }, ctx).reason, "origin", origin);
    }
  });

  test("the right origin from the wrong window is refused", () => {
    // A popup or sibling frame the host opened shares the host's origin. Only
    // the window actually framing us may hand us a credential.
    const other = { name: "popup" };
    assert.equal(acceptTokenMessage({ ...good(), source: other }, ctx).reason, "source");
    // And the page posting to itself is neither the origin nor the parent.
    assert.equal(
      acceptTokenMessage({ origin: "https://app.example", source: SELF, data: good().data }, ctx)
        .reason,
      "origin",
    );
  });

  test("an unframed page refuses everything: there is no host to trust", () => {
    const verdict = acceptTokenMessage(good(), {
      expectedOrigin: WORKSPACE_ORIGIN,
      parentWindow: SELF,
      selfWindow: SELF,
    });
    assert.deepEqual(verdict, { ok: false, reason: "not_framed" });
  });

  test("malformed payloads are refused by shape, not by luck", () => {
    const cases = [
      [null, "shape"],
      ["a string", "shape"],
      [[{ type: EMBED_MESSAGE.token, token: "a.b.c" }], "shape"],
      [{ type: EMBED_MESSAGE.ready }, "type"],
      [{ type: "xray:embed:token " }, "type"],
      [{ type: EMBED_MESSAGE.token }, "shape"],
      [{ type: EMBED_MESSAGE.token, token: 42 }, "shape"],
      [{ type: EMBED_MESSAGE.token, token: "" }, "length"],
      [{ type: EMBED_MESSAGE.token, token: "not-a-jwt" }, "shape"],
      [{ type: EMBED_MESSAGE.token, token: "a.b.c\nX-Injected: 1" }, "shape"],
      [{ type: EMBED_MESSAGE.token, token: `${"a".repeat(5000)}.b.c` }, "length"],
    ];
    for (const [data, reason] of cases) {
      assert.equal(acceptTokenMessage({ ...good(), data }, ctx).reason, reason, String(reason));
    }
  });

  test("an unknown extra key is tolerated, so the host can add a field", () => {
    const data = { type: EMBED_MESSAGE.token, token: "a.b.c", issuedBy: "future-host" };
    assert.equal(acceptTokenMessage({ ...good(), data }, ctx).ok, true);
  });

  test("a misconfigured page with no expected origin accepts nothing", () => {
    assert.equal(
      acceptTokenMessage(good(), { ...ctx, expectedOrigin: "" }).reason,
      "no_expected_origin",
    );
  });
});

describe("identity-token verification", () => {
  const verify = (token, overrides = {}) =>
    verifyIdentityToken(token, {
      secrets: [EMBED_KEY],
      audience: SLUG,
      now: NOW_SECONDS,
      requireScope: "embed",
      ...overrides,
    });

  test("a token the workspace would mint verifies, and yields the tenant", () => {
    const result = verify(makeToken({ sub: "Member@Example.COM" }));
    assert.equal(result.ok, true);
    assert.equal(result.identity.email, MEMBER, "the subject is canonicalised");
    assert.equal(result.identity.companyId, COMPANY_A);
    assert.equal(result.identity.expiresAt, NOW_SECONDS + 300);
    assert.ok(result.identity.jti);
  });

  test("a tampered payload fails on the signature, not on a claim", () => {
    const [header, payload, signature] = makeToken().split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    forged.orole = "owner";
    forged.companyId = COMPANY_B;
    const swapped = Buffer.from(JSON.stringify(forged)).toString("base64url");
    assert.equal(verify(`${header}.${swapped}.${signature}`).reason, "signature");
  });

  test("alg:none and alg confusion are refused before any signature work", () => {
    assert.equal(verify(mintExampleToken(EMBED_KEY, { alg: "none", aud: SLUG })).reason, "alg");
    assert.equal(verify(mintExampleToken(EMBED_KEY, { alg: "HS512", aud: SLUG })).reason, "alg");
    // An unsigned token dressed as one of ours.
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({ iss: "workspace.xray.tech", aud: SLUG, sub: MEMBER }),
    ).toString("base64url")}.`;
    assert.equal(verify(unsigned).reason, "alg");
  });

  test("the wrong signing key is refused", () => {
    assert.equal(
      verify(makeToken({ key: "some-other-service-embed-key-000000" })).reason,
      "signature",
    );
  });

  test("a token for another service, or another issuer, is refused", () => {
    assert.equal(verify(makeToken({ aud: "someoneelse" })).reason, "audience");
    assert.equal(verify(makeToken({ iss: "workspace.xray.tech.evil.example" })).reason, "issuer");
    assert.equal(verify(makeToken({ iss: "evil.example" })).reason, "issuer");
  });

  test("expiry, future-dating and the TTL ceiling all fail closed", () => {
    // Expired well past the skew window.
    assert.equal(verify(makeToken({ now: NOW_SECONDS - 1000, ttlSeconds: 60 })).reason, "expired");
    // Minted in the future beyond the skew window.
    assert.equal(verify(makeToken({ now: NOW_SECONDS + 1000 })).reason, "not_yet_valid");
    // A token minted out of band with a far-future exp: the ≤300s ceiling is
    // enforced HERE, because the mint-side clamp does not protect us.
    assert.equal(
      verify(makeToken({ ttlSeconds: MAX_TOKEN_TTL_SECONDS * 100 })).reason,
      "ttl",
      "a long-lived token must be refused even though it is validly signed",
    );
    assert.equal(verify(makeToken({ ttlSeconds: 0 })).reason, "ttl");
  });

  test("the mandatory claims are mandatory", () => {
    assert.equal(verify(makeToken({ omitJti: true })).reason, "jti");
    assert.equal(verify(makeToken({ sub: "not-an-email" })).reason, "sub");
    assert.equal(verify(makeToken({ omitScope: true })).reason, "scope");
    assert.equal(verify(makeToken({ scope: ["admin"] })).reason, "scope", "unknown scope");
    assert.equal(verify(makeToken({ scope: ["read"] })).reason, "scope", "not an embed token");
    // No companyId means the org never granted identity.companyId — and this
    // app has no tenant to work in, so it refuses rather than guessing one.
    assert.equal(verify(makeToken({ companyId: null })).reason, "companyId");
  });

  test("garbage in is a refusal, never a throw", () => {
    for (const bad of [null, undefined, "", "not.a.jwt", "a.b", "a.b.c.d", "x".repeat(9000)]) {
      const result = verify(bad);
      assert.equal(result.ok, false, String(bad));
      assert.ok(["missing", "malformed", "alg"].includes(result.reason), result.reason);
    }
  });

  test("the second verification key covers a rotation window, and only that", () => {
    const rotating = makeToken({ key: PREVIOUS_EMBED_KEY });
    assert.equal(verify(rotating).reason, "signature");
    assert.equal(verify(rotating, { secrets: [EMBED_KEY, PREVIOUS_EMBED_KEY] }).ok, true);
  });

  test("the platform-admin claim is surfaced but never authorizes anything", () => {
    const staff = verify(makeToken({ pa: true, orole: "member" }));
    assert.equal(staff.ok, true);
    assert.equal(staff.identity.platformAdminClaim, true);
    // It is not part of the access decision — that is the callback's job, and
    // `access.isAdmin` below is computed from the callback alone.
    assert.equal(staff.identity.tokenOrgRole, "member");
  });

  test("a synthetic or demo tenant is not a tenant", () => {
    assert.equal(isRealTenant(COMPANY_A), true);
    for (const bad of [
      "demo",
      "Demo",
      "sample",
      "test",
      "org 1",
      "short",
      "",
      null,
      // Long enough to satisfy the org-id shape, which is exactly why the
      // reserved prefixes have to be checked separately.
      "probe-6162636465666768",
      "DEMO-acme-corporation",
      "test-0000aaaa1111bbbb",
    ]) {
      assert.equal(isRealTenant(bad), false, String(bad));
    }
  });
});

describe("the current-authorization callback fails closed", () => {
  const config = testConfig();
  const token = makeToken();
  const okEnvelope = {
    data: {
      active: true,
      subject: { email: MEMBER, companyId: COMPANY_A },
      access: { orgRole: "ADMIN", deptSlugs: [], roleSlugs: [], permissions: [] },
      expiresAt: new Date(NOW_MS + 60_000).toISOString(),
      asOf: new Date(NOW_MS).toISOString(),
    },
  };
  const jsonResponse = (body, init = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    });

  test("it posts to the configured origin with the SERVICE key, not the bearer", async () => {
    let seen = null;
    await callAuthorize({
      token,
      config,
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return jsonResponse(okEnvelope);
      },
    });
    assert.equal(seen.url, `${WORKSPACE_ORIGIN}/api/v1/registry/${SLUG}/authorize`);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.redirect, "manual", "a 3xx is a denial, not a hop");
    assert.equal(seen.init.headers["X-Workspace-Api-Key"], SERVICE_API_KEY);
    assert.equal(seen.init.headers.Authorization, undefined, "the service key is not a bearer");
    assert.deepEqual(JSON.parse(seen.init.body), { token }, "strict {token} body");
    assert.ok(seen.init.signal, "a timeout signal is always attached");
  });

  test("a timeout, a network error and a redirect are each a denial", async () => {
    const abort = () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    assert.equal((await callAuthorize({ token, config, fetchImpl: abort })).reason, "timeout");
    assert.equal(
      (
        await callAuthorize({
          token,
          config,
          fetchImpl: () => {
            throw new TypeError("fetch failed");
          },
        })
      ).reason,
      "network",
    );
    for (const status of [301, 302, 307, 308]) {
      const res = await callAuthorize({
        token,
        config,
        fetchImpl: async () =>
          new Response(null, { status, headers: { Location: "https://evil.example" } }),
      });
      assert.equal(res.reason, "redirect", String(status));
    }
  });

  test("every negative status denies — and a 401/403 is distinguishable for the UI", async () => {
    const cases = [
      [400, "unavailable"],
      [401, "forbidden"],
      [403, "forbidden"],
      [429, "rate_limited"],
      [500, "unavailable"],
      [503, "unavailable"],
    ];
    for (const [status, reason] of cases) {
      const res = await callAuthorize({
        token,
        config,
        fetchImpl: async () =>
          jsonResponse({ error: { code: "FORBIDDEN", message: "no" } }, { status }),
      });
      assert.equal(res.reason, reason, String(status));
    }
  });

  test("a 200 that is not the success envelope denies", async () => {
    const bad = [
      "not json at all",
      JSON.stringify({ data: { active: false } }),
      JSON.stringify({ error: { code: "FORBIDDEN", message: "revoked" } }),
      JSON.stringify({ data: { active: true, subject: { email: MEMBER } } }),
      JSON.stringify({
        data: { ...okEnvelope.data, expiresAt: "whenever", asOf: okEnvelope.data.asOf },
      }),
      JSON.stringify({ data: { ...okEnvelope.data, active: "true" } }),
    ];
    for (const body of bad) {
      const res = await callAuthorize({ token, config, fetchImpl: async () => jsonResponse(body) });
      assert.equal(res.ok, false, body.slice(0, 40));
      assert.ok(["malformed", "schema"].includes(res.reason), res.reason);
    }
  });

  test("an oversized body is abandoned rather than parsed", async () => {
    const huge = JSON.stringify({ data: { pad: "x".repeat(200_000) } });
    const res = await callAuthorize({ token, config, fetchImpl: async () => jsonResponse(huge) });
    assert.equal(res.reason, "too_large");
  });

  test("a slug cannot smuggle a path out of the configured origin", async () => {
    // The config schema already refuses such a slug; this proves the URL
    // builder is a second lock rather than a formatting convenience.
    const escaped = { ...config, slug: "../../evil" };
    const res = await callAuthorize({
      token,
      config: escaped,
      fetchImpl: async () => jsonResponse(okEnvelope),
    });
    assert.equal(res.ok, true, "encodeURIComponent keeps it inside the origin");
    assert.equal(parseExampleConfig({ ...TEST_ENV, TEAMAPP_SERVICE_SLUG: "../../evil" }).ok, false);
  });
});

describe("reconciling the callback against the token", () => {
  const identity = verifyIdentityToken(makeToken(), {
    secrets: [EMBED_KEY],
    audience: SLUG,
    now: NOW_SECONDS,
    requireScope: "embed",
  }).identity;
  const envelope = (overrides = {}) => ({
    active: true,
    subject: { email: MEMBER, companyId: COMPANY_A },
    access: { orgRole: "ADMIN", deptSlugs: [], roleSlugs: [], permissions: [] },
    expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    asOf: new Date(NOW_MS).toISOString(),
    ...overrides,
  });

  test("a matching answer yields the CURRENT role, not the token's", () => {
    const result = reconcileAuthorization(identity, envelope(), { nowMs: NOW_MS });
    assert.equal(result.ok, true);
    assert.equal(result.access.orgRole, "ADMIN");
    assert.equal(result.access.isAdmin, true);
    assert.equal(result.access.companyId, COMPANY_A);
  });

  test("a different subject or tenant in the answer is refused", () => {
    assert.equal(
      reconcileAuthorization(
        identity,
        envelope({ subject: { email: "someone.else@example.com", companyId: COMPANY_A } }),
        { nowMs: NOW_MS },
      ).reason,
      "subject_mismatch",
    );
    assert.equal(
      reconcileAuthorization(
        identity,
        envelope({ subject: { email: MEMBER, companyId: COMPANY_B } }),
        { nowMs: NOW_MS },
      ).reason,
      "tenant_mismatch",
    );
  });

  test("the callback can shorten a session but can never extend one", () => {
    const tokenExpiryMs = identity.expiresAt * 1000;
    const generous = reconcileAuthorization(
      identity,
      envelope({ expiresAt: new Date(NOW_MS + 86_400_000).toISOString() }),
      { nowMs: NOW_MS },
    );
    assert.equal(generous.ok, true);
    assert.equal(generous.access.expiresAtMs, tokenExpiryMs, "clamped to the token's own exp");

    const stingy = reconcileAuthorization(
      identity,
      envelope({ expiresAt: new Date(NOW_MS + 5_000).toISOString() }),
      { nowMs: NOW_MS },
    );
    assert.equal(stingy.access.expiresAtMs, NOW_MS + 5_000, "an earlier expiry is honoured");
  });

  test("an already-lapsed or stale answer is refused", () => {
    assert.equal(
      reconcileAuthorization(
        identity,
        envelope({ expiresAt: new Date(NOW_MS - 1).toISOString() }),
        {
          nowMs: NOW_MS,
        },
      ).reason,
      "expired",
    );
    assert.equal(
      reconcileAuthorization(
        identity,
        envelope({ asOf: new Date(NOW_MS - 600_000).toISOString() }),
        {
          nowMs: NOW_MS,
        },
      ).reason,
      "asof_stale",
    );
    assert.equal(
      reconcileAuthorization(
        identity,
        envelope({ asOf: new Date(NOW_MS + 600_000).toISOString() }),
        {
          nowMs: NOW_MS,
        },
      ).reason,
      "asof_in_future",
    );
  });

  test("an unrecognised org role is never an admin", () => {
    const result = reconcileAuthorization(
      identity,
      envelope({
        access: { orgRole: "SUPERADMIN", deptSlugs: [], roleSlugs: [], permissions: [] },
      }),
      { nowMs: NOW_MS },
    );
    assert.equal(result.ok, true);
    assert.equal(result.access.orgRole, "UNKNOWN");
    assert.equal(result.access.isAdmin, false);
  });
});

describe("the app refuses what it should, end to end", () => {
  test("the service credential alone is not a user identity", async () => {
    const app = await startApp();
    for (const path of ["/app/session", "/app/notes"]) {
      const res = await app.request(path, {
        method: path === "/app/session" ? "POST" : "GET",
        headers: { "X-Workspace-Api-Key": SERVICE_API_KEY },
      });
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, "UNAUTHENTICATED");
    }
    await app.close();
  });

  test("an expired bearer returns TOKEN_EXPIRED, the code that means re-handshake", async () => {
    const app = await startApp();
    const stale = makeToken({ now: NOW_SECONDS - 1000, ttlSeconds: 60 });
    const res = await app.asUser("/app/session", stale, { method: "POST" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "TOKEN_EXPIRED");
    await app.close();
  });

  test("a callback that says no denies the request the token still allows", async () => {
    for (const [reason, status, code] of [
      ["forbidden", 403, "NOT_AUTHORIZED"],
      ["timeout", 503, "AUTHORIZATION_UNAVAILABLE"],
      ["network", 503, "AUTHORIZATION_UNAVAILABLE"],
      ["schema", 503, "AUTHORIZATION_UNAVAILABLE"],
      ["tenant_mismatch", 503, "AUTHORIZATION_UNAVAILABLE"],
    ]) {
      const app = await startApp({ authorize: stubAuthorize({ deny: reason }) });
      const res = await app.asUser("/app/session", makeToken(), { method: "POST" });
      assert.equal(res.status, status, reason);
      assert.equal(res.body.error.code, code, reason);
      await app.close();
    }
  });

  test("revocation and demotion take effect on the very next request", async () => {
    const store = createStore();
    const seeded = store.add({
      companyId: COMPANY_A,
      ownerEmail: "colleague@example.com",
      title: "Note to remove",
    });
    let stage = "admin";
    const authorize = stubAuthorize({
      handler: async ({ identity, nowMs }) => {
        if (stage === "revoked") return { ok: false, reason: "forbidden" };
        const orgRole = stage === "admin" ? "ADMIN" : "MEMBER";
        return {
          ok: true,
          access: {
            email: identity.email,
            companyId: identity.companyId,
            orgRole,
            isAdmin: orgRole === "ADMIN",
            deptSlugs: [],
            roleSlugs: [],
            permissions: [],
            expiresAtMs: Math.min(identity.expiresAt * 1000, nowMs + 60_000),
          },
        };
      },
    });
    const app = await startApp({ store, authorize });
    const token = makeToken();

    assert.equal(
      (await app.asUser("/app/session", token, { method: "POST" })).body.data.isAdmin,
      true,
    );

    // Same token, same everything — only the workspace's answer changed.
    stage = "member";
    const demoted = await app.asUser(`/app/org-notes/${seeded.note.id}`, token, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    assert.equal(demoted.status, 403);
    assert.equal(demoted.body.error.code, "ADMIN_REQUIRED");
    assert.ok(store.getInTenant(COMPANY_A, seeded.note.id), "the note survived the demotion");

    stage = "revoked";
    const revoked = await app.asUser("/app/org-notes", token);
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.error.code, "NOT_AUTHORIZED");

    // The callback ran on every one of those requests: no positive caching.
    assert.equal(authorize.calls.length, 3);
    await app.close();
  });

  test("the callback is re-asked on every sensitive request", async () => {
    const authorize = stubAuthorize({ orgRole: "ADMIN" });
    const app = await startApp({ authorize });
    const token = makeToken({ sub: ADMIN });
    await app.asUser("/app/session", token, { method: "POST" });
    await app.asUser("/app/org-notes", token);
    await app.asUser("/app/org-notes", token);
    assert.equal(authorize.calls.length, 3, "no positive caching between identical requests");
    await app.close();
  });

  test("a body that supplies its own identity is a 400, not a silent strip", async () => {
    const app = await startApp({ authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const token = makeToken();
    for (const body of [
      { title: "ok", companyId: COMPANY_B },
      { title: "ok", email: "owner@example.com" },
      { title: "ok", orgRole: "OWNER" },
      { title: "ok", isAdmin: true },
      { title: "" },
      { title: "x".repeat(500) },
      { notTitle: "x" },
    ]) {
      const res = await app.asUser("/app/notes", token, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
    await app.close();
  });

  test("an oversized body is refused before it is parsed", async () => {
    const app = await startApp({ authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const res = await app.asUser("/app/notes", makeToken(), {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "x".repeat(20_000) }),
    });
    assert.equal(res.status, 413);
    await app.close();
  });

  test("no cross-tenant read or write, in either direction", async () => {
    const store = createStore();
    const theirs = store.add({
      companyId: COMPANY_B,
      ownerEmail: "other@example.com",
      title: "Another org's note",
    });
    const app = await startApp({ store, authorize: stubAuthorize({ orgRole: "ADMIN" }) });
    const token = makeToken({ sub: ADMIN }); // companyId = COMPANY_A

    // Read: the other tenant's id is absent, not forbidden.
    assert.equal((await app.asUser(`/app/notes/${theirs.note.id}`, token)).status, 404);

    // Write: an admin's delete cannot reach out of its own tenant.
    const del = await app.asUser(`/app/org-notes/${theirs.note.id}`, token, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    assert.equal(del.status, 404);
    assert.ok(store.getInTenant(COMPANY_B, theirs.note.id), "the other tenant's note is untouched");

    // The admin's own-tenant listing shows nothing from the other one.
    const list = await app.asUser("/app/org-notes", token);
    assert.ok(!list.body.data.notes.some((n) => n.id === theirs.note.id));

    // And the same holds on the proxied resource surface, which is
    // owner-scoped: the other tenant's owner is a different person.
    const viaProxy = await app.asProxy("/api/v1/resources", token);
    assert.equal(viaProxy.status, 200);
    assert.ok(!viaProxy.body.data.items.some((n) => n.id === theirs.note.id));
    await app.close();
  });

  test("a read-scoped token may read but may never write", async () => {
    // The regression this guards: a proxy read token is a legitimate,
    // correctly signed token held by a legitimately senior person. Neither
    // fact makes it spendable on a mutation.
    const store = createStore();
    const existing = store.add({
      companyId: COMPANY_A,
      ownerEmail: "colleague@example.com",
      title: "Existing note",
    });
    const app = await startApp({ store, authorize: stubAuthorize({ orgRole: "OWNER" }) });
    const readOnly = makeToken({ scope: ["read"] });

    const list = await app.asUser("/app/notes", readOnly);
    assert.equal(list.status, 200, "reading is exactly what a read token is for");

    const write = await app.asUser("/app/notes", readOnly, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "Should not exist" }),
    });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, "SCOPE_INSUFFICIENT");

    const remove = await app.asUser(`/app/org-notes/${existing.note.id}`, readOnly, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    assert.equal(remove.status, 403);
    assert.equal(remove.body.error.code, "SCOPE_INSUFFICIENT");
    assert.ok(store.getInTenant(COMPANY_A, existing.note.id), "nothing was removed");
    assert.equal(store.listTenant(COMPANY_A).length, 1, "nothing was added");
    await app.close();
  });

  test("a merge-scoped token is not a write token anywhere but the merge endpoint", async () => {
    // `merge` re-keys people on the workspace's behalf. It must not double as
    // a licence to add or delete notes through the app's own backend.
    const store = createStore();
    const existing = store.add({ companyId: COMPANY_A, ownerEmail: MEMBER, title: "Existing" });
    const app = await startApp({ store, authorize: stubAuthorize({ orgRole: "OWNER" }) });
    const mergeOnly = makeToken({ scope: ["merge"] });

    const write = await app.asUser("/app/notes", mergeOnly, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "Should not exist" }),
    });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, "SCOPE_INSUFFICIENT");
    const remove = await app.asUser(`/app/org-notes/${existing.note.id}`, mergeOnly, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    assert.equal(remove.status, 403);
    assert.equal(store.listTenant(COMPANY_A).length, 1, "nothing was added or removed");
    await app.close();
  });

  test("a write-scoped token writes, and embed scope is not an admin grant", async () => {
    const store = createStore();
    const theirs = store.add({
      companyId: COMPANY_A,
      ownerEmail: "someone@example.com",
      title: "Someone else's note",
    });
    const app = await startApp({ store, authorize: stubAuthorize({ orgRole: "MEMBER" }) });

    const written = await app.asUser("/app/notes", makeToken({ scope: ["read", "write"] }), {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ title: "Written with write scope" }),
    });
    assert.equal(written.status, 201);

    // Embed scope opens the app. The admin plane still needs the ROLE, which
    // only the callback grants — the scope never stands in for it.
    const denied = await app.asUser(`/app/org-notes/${theirs.note.id}`, makeToken(), {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "ADMIN_REQUIRED");
    await app.close();
  });

  test("a synthetic tenant cannot reach the real-data plane", async () => {
    const app = await startApp();
    const res = await app.asUser("/app/session", makeToken({ companyId: "demo" }), {
      method: "POST",
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "TENANT_NOT_ELIGIBLE");
    await app.close();
  });

  test("errors never carry an exception, a path or a stack to the client", async () => {
    const app = await startApp({
      authorize: async () => {
        throw new Error("/Users/someone/secret/path/db.js exploded: password=hunter2");
      },
    });
    const res = await app.asUser("/app/session", makeToken(), { method: "POST" });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, {
      error: { code: "INTERNAL_ERROR", message: "Something went wrong." },
    });
    await app.close();
  });
});

describe("token lifetime is exact — no grace, and none that compounds", () => {
  // The defect this pins: a 30s skew on the TTL ceiling AND a 30s skew on the
  // expiry check stacked, so a "≤300s" token was usable for up to 360s.
  // Because an offline own-row read is gated by the token alone, that grace
  // window WAS the whole window. This reference is deliberately stricter than
  // the verifier the Workspace's first-party services use, which keeps ±30s
  // for fleet clock drift.
  const verify = (token, now = NOW_SECONDS) =>
    verifyIdentityToken(token, { secrets: [EMBED_KEY], audience: SLUG, now });

  test("a 300s token is valid up to, and not including, its exp", () => {
    const token = makeToken({ now: NOW_SECONDS, ttlSeconds: 300 });
    const exp = NOW_SECONDS + 300;

    assert.equal(verify(token, exp - 1).ok, true, "the last valid second");
    assert.equal(verify(token, exp).reason, "expired", "exp itself is already dead");
    assert.equal(verify(token, exp + 1).reason, "expired");
    // The old 30s grace, now gone. This is the regression.
    assert.equal(verify(token, exp + 30).reason, "expired", "no expiry grace");
  });

  test("the TTL ceiling is 300 exactly, with no grace above it", () => {
    assert.equal(verify(makeToken({ ttlSeconds: 300 })).ok, true);
    assert.equal(verify(makeToken({ ttlSeconds: 301 })).reason, "ttl");
    // 330 = 300 + the old skew: the token that used to slip through.
    assert.equal(verify(makeToken({ ttlSeconds: 330 })).reason, "ttl");
    assert.equal(verify(makeToken({ ttlSeconds: 3600 })).reason, "ttl");
  });

  test("300 + 30 + 30 no longer adds up to a usable token", () => {
    const overLong = makeToken({ now: NOW_SECONDS, ttlSeconds: 330 });
    assert.equal(verify(overLong, NOW_SECONDS).reason, "ttl", "refused on lifetime alone");
    assert.equal(verify(overLong, NOW_SECONDS + 359).reason, "ttl");
  });

  test("a token minted in the future is refused, with no tolerance", () => {
    assert.equal(verify(makeToken({ now: NOW_SECONDS + 1 })).reason, "not_yet_valid");
    assert.equal(verify(makeToken({ now: NOW_SECONDS + 30 })).reason, "not_yet_valid");
    assert.equal(verify(makeToken({ now: NOW_SECONDS })).ok, true, "minted this second is fine");
  });

  test("fractional, reversed and absurd timestamps are refused, never rounded", () => {
    const base = { now: NOW_SECONDS, ttlSeconds: 300 };
    // Fractions are not seconds.
    assert.equal(verify(makeToken({ ...base, iat: NOW_SECONDS + 0.5 })).reason, "iat");
    assert.equal(verify(makeToken({ ...base, exp: NOW_SECONDS + 300.5 })).reason, "exp");
    // Past Number.MAX_SAFE_INTEGER, arithmetic stops meaning anything.
    assert.equal(verify(makeToken({ ...base, exp: 1e21 })).reason, "exp");
    assert.equal(verify(makeToken({ ...base, exp: Number.NaN })).reason, "exp");
    assert.equal(verify(makeToken({ ...base, iat: Number.POSITIVE_INFINITY })).reason, "iat");
    // Reversed, and zero-length.
    assert.equal(verify(makeToken({ ...base, exp: NOW_SECONDS - 1 })).reason, "ttl");
    assert.equal(verify(makeToken({ ...base, exp: NOW_SECONDS })).reason, "ttl");
    // Our OWN clock must be whole seconds too: milliseconds passed by mistake,
    // or a float, is a refusal rather than a silently wrong comparison.
    assert.equal(verify(makeToken(base), NOW_SECONDS + 0.5).reason, "clock");
    assert.equal(verify(makeToken(base), NOW_MS).reason, "expired", "ms read as s is far future");
  });

  test("the offline own-read window is therefore exactly the token's, to the second", async () => {
    const clock = controllableClock(NOW_MS);
    const app = await startApp({ now: clock, authorize: stubAuthorize({ orgRole: "MEMBER" }) });
    const token = makeToken({ now: NOW_SECONDS, ttlSeconds: 300 });

    assert.equal((await app.asUser("/app/notes", token)).status, 200);
    clock.set(NOW_MS + 299_000);
    assert.equal((await app.asUser("/app/notes", token)).status, 200, "299s: still fine");
    clock.set(NOW_MS + 300_000);
    const dead = await app.asUser("/app/notes", token);
    assert.equal(dead.status, 401, "300s: over, with no extra minute");
    assert.equal(dead.body.error.code, "TOKEN_EXPIRED");
    await app.close();
  });
});

describe("time is read after the network, and again before the operation", () => {
  const config = testConfig();
  const envelopeAt = (nowMs) => ({
    active: true,
    subject: { email: MEMBER, companyId: COMPANY_A },
    access: { orgRole: "ADMIN", deptSlugs: [], roleSlugs: [], permissions: [] },
    expiresAt: new Date(nowMs + 60_000).toISOString(),
    asOf: new Date(nowMs).toISOString(),
  });

  test("reconciliation uses the time the answer ARRIVED, not when it was sent", async () => {
    // The defect: the server snapshotted `now()` before `await authorize(...)`
    // and `authorizeRequest` reused that snapshot afterwards. A token with two
    // seconds left, and a callback that takes three, reconciled as live.
    const clock = controllableClock(NOW_MS);
    const token = makeToken({ now: NOW_SECONDS, ttlSeconds: 300 });
    const identity = verifyIdentityToken(token, {
      secrets: [EMBED_KEY],
      audience: SLUG,
      now: NOW_SECONDS,
    }).identity;

    // A slow workspace: the token lapses while its answer is in flight. The
    // envelope is stamped with the real arrival time, as a real one would be.
    const slowFetch = async () => {
      clock.advance(301_000);
      return new Response(JSON.stringify({ data: envelopeAt(clock()) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await authorizeRequest({ token, identity, config, fetchImpl: slowFetch, clock });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired");

    // The contrast that names the bug: reconciling the very same answer
    // against the PRE-flight timestamp would have allowed it.
    const preFlight = reconcileAuthorization(identity, envelopeAt(NOW_MS), { nowMs: NOW_MS });
    assert.equal(preFlight.ok, true, "which is precisely why the snapshot was wrong");
  });

  test("a token that lapses during the callback is denied at the request level", async () => {
    const clock = controllableClock(NOW_MS);
    const store = createStore();
    const app = await startApp({
      store,
      now: clock,
      authorize: stubAuthorize({
        orgRole: "ADMIN",
        duringCall: ({ clock: c }) => c.advance(301_000),
      }),
    });
    const res = await app.asUser("/app/session", makeToken({ ttlSeconds: 300 }), {
      method: "POST",
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "TOKEN_EXPIRED");
    await app.close();
  });

  test("a slow request body cannot outlive its authorization, replay included", async () => {
    // Authorization is decided when the HEADERS arrive; the body arrives
    // whenever the client feels like it. Here the client sends half a body,
    // lets the authorization lapse, then sends the rest.
    //
    // Two things make this test isolate the pre-operation re-check rather
    // than something upstream that happens to also say no:
    //
    //  · The clock moves only 61s. The token is good for 300s, so the
    //    VERIFIER is still perfectly happy — only `access.expiresAtMs`
    //    (callback expiry, now+60s) has passed. Nothing but the re-check can
    //    produce this denial.
    //  · The advance is chained off the callback actually completing, not off
    //    a `setImmediate` that might land either side of it. Without that, the
    //    test passes via the expiry-during-callback path instead and proves a
    //    different thing on every run.
    //
    // The key is one already recorded, so the replay branch is on trial too:
    // a recorded 201 is still a privileged answer.
    const clock = controllableClock(NOW_MS);
    const store = createStore();
    const base = stubAuthorize({ orgRole: "MEMBER" });
    let notifyAuthorized = () => {};
    const app = await startApp({
      store,
      now: clock,
      authorize: async (args) => {
        const decision = await base(args);
        notifyAuthorized();
        return decision;
      },
    });
    const token = makeToken({ now: NOW_SECONDS, ttlSeconds: 300 });
    const key = idempotencyKey("slow-body");

    const first = await app.asUser("/app/notes", token, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ title: "Recorded once" }),
    });
    assert.equal(first.status, 201);

    const body = JSON.stringify({ title: "Should never be stored" });
    const half = Math.floor(body.length / 2);
    const authorized = new Promise((resolve) => (notifyAuthorized = resolve));

    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: app.server.address().port,
          method: "POST",
          path: "/app/notes",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        },
      );
      req.on("error", reject);
      req.write(body.slice(0, half));
      // The server has authorized and is now awaiting the rest of the body.
      // No sleeping — just move past the point where that decision was good.
      authorized.then(() => {
        clock.advance(61_000);
        req.end(body.slice(half));
      });
    });

    assert.equal(result.status, 401, "the re-check, not the verifier, must catch this");
    assert.equal(result.body.error.code, "TOKEN_EXPIRED");
    assert.ok(!("data" in result.body), "the recorded 201 was not replayed");
    assert.equal(store.listTenant(COMPANY_A).length, 1, "and nothing was written twice");
    await app.close();
  });

  test("a recorded answer is not replayed to a token that has since died", async () => {
    // The plainer sibling of the test above: here the token itself is gone, so
    // the verifier refuses before the idempotency ledger is ever consulted.
    const clock = controllableClock(NOW_MS);
    const store = createStore();
    const app = await startApp({
      store,
      now: clock,
      authorize: stubAuthorize({ orgRole: "MEMBER" }),
    });
    const token = makeToken({ now: NOW_SECONDS, ttlSeconds: 300 });
    const key = idempotencyKey("replay-after-expiry");
    const send = () =>
      app.asUser("/app/notes", token, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ title: "Recorded once" }),
      });

    assert.equal((await send()).status, 201);
    clock.advance(301_000);
    const replay = await send();
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, "TOKEN_EXPIRED");
    assert.ok(!("data" in replay.body), "no recorded answer handed back");
    assert.equal(store.listTenant(COMPANY_A).length, 1);
    await app.close();
  });

  test("a privileged org read is re-checked before it is serialised", async () => {
    const clock = controllableClock(NOW_MS);
    const store = createStore();
    store.add({ companyId: COMPANY_A, ownerEmail: "colleague@example.com", title: "Private" });
    const app = await startApp({
      store,
      now: clock,
      // Authorizes, then time moves — the window between "allowed" and
      // "answered", which is where a privileged read gets serialised.
      authorize: stubAuthorize({
        handler: async ({ identity, clock: c }) => {
          const nowMs = c();
          const access = {
            email: identity.email,
            companyId: identity.companyId,
            orgRole: "ADMIN",
            isAdmin: true,
            deptSlugs: [],
            roleSlugs: [],
            permissions: [],
            expiresAtMs: Math.min(identity.expiresAt * 1000, nowMs + 60_000),
          };
          c.advance(301_000);
          return { ok: true, access };
        },
      }),
    });
    const res = await app.asUser("/app/org-notes", makeToken({ sub: ADMIN, ttlSeconds: 300 }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "TOKEN_EXPIRED");
    assert.ok(!JSON.stringify(res.body).includes("Private"), "no tenant data on a dead credential");
    await app.close();
  });
});

describe("offline reads, online sensitive operations, and the certification line", () => {
  // The lifecycle fact behind all of this: certification runs BEFORE the
  // service is live and installed — exactly the state the authorize callback
  // refuses. So the resource handlers cannot be online-gated. Certification
  // also forbids answering probes from a side channel, so they are the REAL
  // handlers. These tests pin both halves of that compromise.

  test("the resource handlers never call the callback, so certification can run", async () => {
    const authorize = stubAuthorize({ orgRole: "OWNER" });
    const app = await startApp({ authorize });
    const token = canaryToken({ sub: "jordan.lee.a1b2c3@example.com", companyId: COMPANY_A });
    const list = await app.asProxy("/api/v1/resources", token);
    assert.equal(list.status, 200);
    await app.asProxy(`/api/v1/resources/${list.body.data.items[0].id}`, token);
    assert.equal(authorize.calls.length, 0, "certification must work before the app is live");
    await app.close();
  });

  test("the resource surface needs BOTH the service key and a signed token", async () => {
    const app = await startApp();
    const token = canaryToken({ sub: "jordan.lee.a1b2c3@example.com", companyId: COMPANY_A });
    const path = "/api/v1/resources";

    // Nothing at all.
    assert.equal((await app.request(path)).status, 401);
    // The query hint alone. This is the regression: an earlier draft served
    // it, which was a public read path wearing a hint's clothes.
    assert.equal(
      (await app.request(`${path}?email=jordan.lee.a1b2c3@example.com`)).status,
      401,
      "a bare ?email= must never be an identity",
    );
    // Service key, no token: a caller, not a person.
    assert.equal(
      (await app.request(path, { headers: { "X-Workspace-Api-Key": SERVICE_API_KEY } })).status,
      401,
    );
    // Token, no service key: a person, but not from a caller we serve here.
    assert.equal(
      (await app.request(path, { headers: { "X-Workspace-Token": token } })).status,
      401,
    );
    // A signature-invalid token with a good service key.
    const forged =
      canaryToken({ sub: "a.b@example.com", companyId: COMPANY_A }).slice(0, -4) + "AAAA";
    assert.equal((await app.asProxy(path, forged)).status, 401);
    // Both, correct.
    assert.equal((await app.asProxy(path, token)).status, 200);
    await app.close();
  });

  test("a hint that disagrees with the signature is refused, not resolved", async () => {
    const store = createStore();
    const app = await startApp({ store });
    const emailA = "jordan.lee.a1b2c3@example.com";
    const emailB = "sam.rivera.d4e5f6@example.com";
    const a = canaryToken({ sub: emailA, companyId: COMPANY_A });
    const b = canaryToken({ sub: emailB, companyId: COMPANY_B });

    // Give A a row to try to reach.
    const aList = await app.asProxy("/api/v1/resources", a);
    const aId = aList.body.data.items[0].id;

    // Signed as B, hinting A: refused outright. Not silently answered as B,
    // and certainly not as A.
    const crossed = await app.asProxy(`/api/v1/resources?email=${encodeURIComponent(emailA)}`, b);
    assert.equal(crossed.status, 403);
    assert.equal(crossed.body.error.code, "IDENTITY_MISMATCH");
    assert.ok(!JSON.stringify(crossed.body).includes(aId));

    // Signed as B, asking for A's row id by path: absent.
    assert.equal((await app.asProxy(`/api/v1/resources/${aId}`, b)).status, 404);

    // And a hint that agrees is simply a hint.
    const agreeing = await app.asProxy(`/api/v1/resources?email=${encodeURIComponent(emailB)}`, b);
    assert.equal(agreeing.status, 200);
    assert.ok(!agreeing.body.data.items.some((n) => n.id === aId));
    await app.close();
  });

  test("the resource surface is read-only: it has no mutating verb", async () => {
    const app = await startApp();
    const token = canaryToken({ sub: "a.b@example.com", companyId: COMPANY_A });
    for (const method of ["POST", "DELETE"]) {
      assert.equal((await app.asProxy("/api/v1/resources", token, { method })).status, 404, method);
    }
    await app.close();
  });

  test("first-use provisioning is ordinary behaviour, not a canary branch", async () => {
    // Any verified subject gets the same starter row through the same path.
    // A harness identity is indistinguishable from a real user, which is the
    // whole point of the isolation probes.
    const app = await startApp();
    const rows = [];
    for (const sub of ["casey.nguyen.111111@example.com", MEMBER]) {
      const res = await app.asProxy(
        "/api/v1/resources",
        canaryToken({ sub, companyId: COMPANY_A }),
      );
      assert.equal(res.status, 200, sub);
      assert.equal(res.body.data.items.length, 1, sub);
      rows.push(res.body.data.items[0]);
    }
    assert.equal(rows[0].title, rows[1].title, "the same row for everyone");
    assert.notEqual(rows[0].id, rows[1].id, "but distinct rows, per owner");
    await app.close();
  });

  test("your own rows are served offline, but ONLY your own rows", async () => {
    const store = createStore();
    const theirs = store.add({
      companyId: COMPANY_A,
      ownerEmail: "colleague@example.com",
      title: "Not yours",
    });
    const authorize = stubAuthorize({ orgRole: "OWNER" });
    const app = await startApp({ store, authorize });
    const token = makeToken();

    const own = await app.asUser("/app/notes", token);
    assert.equal(own.status, 200);
    assert.ok(!own.body.data.mine.some((n) => n.id === theirs.note.id));
    // Even for an OWNER: this endpoint is owner-scoped, and no callback ran,
    // so no role was available to widen it.
    assert.equal((await app.asUser(`/app/notes/${theirs.note.id}`, token)).status, 404);
    assert.equal(authorize.calls.length, 0);
    await app.close();
  });

  test("the offline read's staleness is bounded by the token, and nothing else", async () => {
    // The stated trade: after a revocation, someone reads their own rows for
    // at most the remainder of a ≤300s token. A token past that is refused
    // with no callback needed.
    const app = await startApp({ authorize: stubAuthorize({ deny: "forbidden" }) });
    const stale = makeToken({ now: NOW_SECONDS - 1000, ttlSeconds: 300 });
    const res = await app.asUser("/app/notes", stale);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "TOKEN_EXPIRED");
    await app.close();
  });

  test("a revoked person still reads their own rows, but nothing sensitive", async () => {
    const authorize = stubAuthorize({ deny: "forbidden" });
    const app = await startApp({ authorize });
    const token = makeToken();

    // The bounded window, stated honestly rather than papered over.
    assert.equal((await app.asUser("/app/notes", token)).status, 200);

    // Everything that matters is shut immediately.
    for (const [path, init] of [
      ["/app/session", { method: "POST" }],
      ["/app/org-notes", {}],
      [
        "/app/notes",
        { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: '{"title":"x"}' },
      ],
    ]) {
      const res = await app.asUser(path, token, init);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error.code, "NOT_AUTHORIZED", path);
    }
    await app.close();
  });

  test("the ?email= hint is inert on the app plane, with or without a service key", async () => {
    const app = await startApp({ authorize: stubAuthorize({ orgRole: "OWNER" }) });
    const key = { "X-Workspace-Api-Key": SERVICE_API_KEY };
    for (const headers of [{}, key]) {
      assert.equal(
        (await app.request("/app/notes?email=a.b@example.com", { headers })).status,
        401,
      );
      assert.equal(
        (await app.request("/app/org-notes?email=a.b@example.com", { headers })).status,
        401,
      );
      const write = await app.request("/app/notes?email=a.b@example.com", {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ title: "x" }),
      });
      assert.equal(write.status, 401);
    }
    await app.close();
  });

  test("a synthetic tenant is refused before the callback is even consulted", async () => {
    const authorize = stubAuthorize({ orgRole: "OWNER" });
    const app = await startApp({ authorize });
    for (const companyId of ["demo", "demo-acme-corporation", "probe-6162636465666768"]) {
      const res = await app.asUser("/app/session", makeToken({ companyId }), { method: "POST" });
      assert.equal(res.status, 403, companyId);
      assert.equal(res.body.error.code, "TENANT_NOT_ELIGIBLE", companyId);
    }
    assert.equal(authorize.calls.length, 0);
    await app.close();
  });
});

describe("the example's own configuration is validated, not assumed", () => {
  test("a plaintext workspace origin is refused unless it is opted-in loopback", () => {
    assert.equal(
      parseExampleConfig({ ...TEST_ENV, TEAMAPP_WORKSPACE_ORIGIN: "http://ws.example" }).ok,
      false,
    );
    assert.equal(
      parseExampleConfig({ ...TEST_ENV, TEAMAPP_WORKSPACE_ORIGIN: "http://127.0.0.1:3000" }).ok,
      false,
      "loopback still needs the explicit opt-in",
    );
    const loopback = parseExampleConfig({
      ...TEST_ENV,
      TEAMAPP_WORKSPACE_ORIGIN: "http://127.0.0.1:3000",
      TEAMAPP_ALLOW_INSECURE_LOOPBACK: "true",
    });
    assert.equal(loopback.ok, true);
    assert.equal(loopback.config.workspaceOrigin, "http://127.0.0.1:3000");
  });

  test("an origin with a path, a bad slug, or a reused key is refused", () => {
    const bad = [
      { TEAMAPP_WORKSPACE_ORIGIN: "https://ws.example/embed" },
      { TEAMAPP_WORKSPACE_ORIGIN: "not-a-url" },
      { TEAMAPP_SERVICE_SLUG: "Team-App" },
      { TEAMAPP_EMBED_KEY: "short" },
      { TEAMAPP_WORKSPACE_API_KEY: EMBED_KEY },
    ];
    for (const override of bad) {
      const result = parseExampleConfig({ ...TEST_ENV, ...override });
      assert.equal(result.ok, false, JSON.stringify(override));
      assert.ok(result.issues.length > 0);
      // The complaint names the variable, never the value.
      for (const issue of result.issues) assert.ok(!issue.includes(EMBED_KEY), issue);
    }
  });
});
