/**
 * Shared scaffolding for the example's tests. Not a test file itself, so a
 * `*.test.mjs` glob never picks it up.
 *
 * Everything here is fake by construction: the keys are literal strings in a
 * fixture, the workspace is a stub function, and no test ever opens a socket
 * to anything but a loopback server it started itself.
 */
import { createHmac, randomUUID } from "node:crypto";

import { parseExampleConfig } from "./config.mjs";
import { WORKSPACE_TOKEN_ISSUER } from "./identity-token.mjs";
import { createApp } from "./server.mjs";

/**
 * TEST/DEV ONLY minting. It lives here, not in `identity-token.mjs`, because
 * the workspace is the only minter: a service holds the key to VERIFY, and
 * shipping a mint alongside the verifier invites someone to reach for it.
 * Nothing a service would deploy imports this file.
 */
export function mintExampleToken(secret, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 300;
  const header = { alg: options.alg ?? "HS256", typ: "JWT" };
  const claims = {
    iss: options.iss ?? WORKSPACE_TOKEN_ISSUER,
    aud: options.aud,
    sub: options.sub,
    scope: options.scope ?? ["embed"],
    cid: options.cid ?? randomUUID(),
    iat: options.iat ?? now,
    exp: options.exp ?? now + ttl,
    jti: options.jti ?? randomUUID(),
    ...(options.companyId === null ? {} : { companyId: options.companyId }),
    ...(options.orole ? { orole: options.orole } : {}),
    ...(options.pa ? { pa: true } : {}),
  };
  if (options.omitJti) delete claims.jti;
  if (options.omitScope) delete claims.scope;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * A clock the test drives by hand. No sleeping, no real time: `advance` moves
 * it, and everything that reads it — the verifier, the callback's post-fetch
 * reconciliation, the pre-operation re-check — sees the move immediately.
 */
export function controllableClock(startMs) {
  let ms = startMs;
  const read = () => ms;
  read.advance = (deltaMs) => {
    ms += deltaMs;
    return ms;
  };
  read.set = (valueMs) => {
    ms = valueMs;
    return ms;
  };
  return read;
}

/** Obviously-fake constants. Long enough to satisfy the config schema. */
export const EMBED_KEY = "example-embed-key-for-tests-not-a-secret";
export const PREVIOUS_EMBED_KEY = "example-previous-embed-key-for-tests-only";
export const SERVICE_API_KEY = "example-service-api-key-for-tests-only-x";
export const SLUG = "teamapp";
export const WORKSPACE_ORIGIN = "https://workspace.xray.tech";
export const COMPANY_A = "org-0000aaaa1111bbbb";
export const COMPANY_B = "org-9999zzzz8888yyyy";
export const MEMBER = "member@example.com";
export const ADMIN = "admin@example.com";

export const TEST_ENV = Object.freeze({
  TEAMAPP_PORT: "4802",
  TEAMAPP_SERVICE_SLUG: SLUG,
  TEAMAPP_EMBED_KEY: EMBED_KEY,
  TEAMAPP_WORKSPACE_ORIGIN: WORKSPACE_ORIGIN,
  TEAMAPP_WORKSPACE_API_KEY: SERVICE_API_KEY,
  TEAMAPP_AUTHORIZE_TIMEOUT_MS: "500",
});

/** The parsed config every test runs against. Throws loudly if it drifts. */
export function testConfig(overrides = {}) {
  const parsed = parseExampleConfig({ ...TEST_ENV, ...overrides });
  if (!parsed.ok) throw new Error(`test config invalid: ${parsed.issues.join("; ")}`);
  return parsed.config;
}

/** A fixed clock, so no test ever waits for real time to pass. */
export const NOW_MS = Date.UTC(2026, 8, 9, 12, 0, 0);
export const NOW_SECONDS = Math.floor(NOW_MS / 1000);

/**
 * A short-lived, read-scoped canary token of the kind the certification
 * harness signs: a realistic subject on a canary domain, its own tenant, and
 * nothing that marks it as a probe.
 */
export function canaryToken({ sub, companyId }) {
  return makeToken({ sub, companyId, scope: ["read"], ttlSeconds: 120 });
}

/** Mint a token the way the workspace would, at the fixed clock. */
export function makeToken(overrides = {}) {
  return mintExampleToken(overrides.key ?? EMBED_KEY, {
    aud: SLUG,
    sub: MEMBER,
    companyId: COMPANY_A,
    scope: ["embed"],
    now: NOW_SECONDS,
    ttlSeconds: 300,
    ...overrides,
  });
}

/**
 * The stubbed online boundary. Stands in for
 * `POST /api/v1/registry/{slug}/authorize` — the test suite never reaches a
 * real workspace, a real database, or the network.
 */
export function stubAuthorize(plan = {}) {
  const calls = [];
  // Receives a CLOCK, matching the real `authorizeRequest`, and reads it only
  // where the real one does — after the (here instantaneous) round trip.
  const fn = async ({ token, identity, clock }) => {
    const readClock = clock ?? (() => NOW_MS);
    calls.push({ token, identity, clock: readClock });
    // Lets a test move time forward "during" the callback.
    if (typeof plan.duringCall === "function")
      await plan.duringCall({ identity, clock: readClock });
    if (typeof plan.handler === "function") {
      return plan.handler({ token, identity, clock: readClock, nowMs: readClock(), calls });
    }
    if (plan.deny) return { ok: false, reason: plan.deny };
    const nowMs = readClock();
    const expiresAtMs = Math.min(identity.expiresAt * 1000, nowMs + 60_000);
    // The real reconciler refuses an already-lapsed session; so does this.
    if (expiresAtMs <= nowMs) return { ok: false, reason: "expired" };
    const orgRole = plan.orgRole ?? "MEMBER";
    return {
      ok: true,
      access: Object.freeze({
        email: identity.email,
        companyId: identity.companyId,
        orgRole,
        isAdmin: orgRole === "OWNER" || orgRole === "ADMIN",
        deptSlugs: plan.deptSlugs ?? [],
        roleSlugs: plan.roleSlugs ?? [],
        permissions: plan.permissions ?? [],
        expiresAtMs,
      }),
    };
  };
  fn.calls = calls;
  return fn;
}

/**
 * Every app a test starts, so a failed assertion cannot strand a listening
 * server and hang the runner. Both suites drain this in an `after` hook.
 */
const openApps = new Set();
export async function closeAllApps() {
  await Promise.all([...openApps].map((close) => close()));
  openApps.clear();
}

/** Start the app on a loopback ephemeral port. Returns `{ base, close }`. */
export async function startApp(options = {}) {
  const server = createApp({
    config: options.config ?? testConfig(),
    authorize: options.authorize ?? stubAuthorize(),
    now: options.now ?? (() => NOW_MS),
    store: options.store,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // `close()` alone waits for undici's keep-alive sockets to time out, which
  // hangs the runner. Drop the connections first.
  const close = () =>
    new Promise((resolve) => {
      openApps.delete(close);
      server.closeAllConnections();
      server.close(resolve);
    });
  openApps.add(close);
  return {
    base,
    server,
    close,
    /** Every request in the suite goes through here: manual redirects, JSON. */
    async request(path, init = {}) {
      const response = await fetch(`${base}${path}`, { redirect: "manual", ...init });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, headers: response.headers, body };
    },
    /** A call carrying the browser's bearer token, the way the page does it. */
    async asUser(path, token, init = {}) {
      return this.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    },
    /**
     * A call the way the workspace proxy — and the certification harness —
     * makes it: the service key AND a signed identity token.
     */
    async asProxy(path, token, init = {}) {
      return this.request(path, {
        ...init,
        headers: {
          "X-Workspace-Api-Key": SERVICE_API_KEY,
          "X-Workspace-Token": token,
          ...(init.headers ?? {}),
        },
      });
    },
  };
}

/** A unique Idempotency-Key per mutating call. */
let counter = 0;
export function idempotencyKey(prefix = "test") {
  counter += 1;
  return `${prefix}-key-${String(counter).padStart(6, "0")}`;
}
