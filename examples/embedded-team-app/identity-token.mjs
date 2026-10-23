/**
 * Workspace identity-token verification — the half a third-party service owns.
 *
 * The workspace is the only minter. It signs a compact HS256 JWT with the
 * per-service embed key and hands it to the browser, which posts it to us.
 * Nothing here trusts a claim it has not checked, and nothing here authorizes
 * on a role: the role fields are deliberately named `token*` so a reader can
 * see that the CALLBACK (`authorize.mjs`), not the JWT, is the authority on
 * what this person may do right now.
 *
 * Mirrors the Workspace's own verifier (checked against tokens its real minter
 * produced: `contract.test.mjs`).
 * Written against `node:crypto` only, so there is nothing extra to audit.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WORKSPACE_TOKEN_ISSUER = "workspace.xray.tech";
/** Hard ceiling: exp - iat must be ≤ 300s. Enforced at VERIFY time. */
export const MAX_TOKEN_TTL_SECONDS = 300;

/**
 * ── No clock skew. Deliberately, and deliberately unlike the first-party
 *    verifier the Workspace's own services use. ────────────────────────────
 *
 * That verifier allows ±30s of drift, which is the right call for a fleet of
 * first-party services whose clocks wander. But grace COMPOUNDS, and the
 * earlier draft of this file showed how:
 *
 *     TTL ceiling   exp - iat ≤ 300 + 30   → a 330s token is accepted
 *     expiry check  now ≤ exp + 30         → usable for 30s past exp
 *     ────────────────────────────────────────────────────────────────
 *     effective                              360s of validity
 *
 * Twenty percent over a limit the docs state as a hard ≤300s. That matters
 * most exactly where it is least visible: an offline own-row read is gated by
 * the token ALONE, so the grace window is the whole window — a revoked person
 * kept reading for six minutes, not five.
 *
 * So this reference is strict. `exp` and `iat` must be safe integers, the
 * lifetime must be positive and ≤300s, `iat` may not be in the future, and a
 * token is dead the instant `now` reaches `exp`. A service copying this file
 * runs a clock that agrees with the workspace's to the second — NTP, not
 * hope — and gets a bound it can actually quote.
 */
/**
 * The only scopes the workspace mints. Anything else means "not our token".
 * `merge` is minted only for `POST /api/v1/subject/merge` (the workspace folding
 * one person into another); it is not a write scope anywhere else here.
 */
export const KNOWN_SCOPES = Object.freeze(["read", "write", "embed", "merge"]);
/** A real org id. Short, cute strings like "demo" are not tenants. */
const ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
/**
 * Tenant keys this app refuses for anything touching real data — the exact
 * names, and anything wearing one as a prefix (`probe-a1b2…`, `demo-acme`).
 * The prefix rule matters: the certification plane's synthetic identities are
 * long enough to look like real org ids, and without it one of them would
 * satisfy the shape test below.
 */
const SYNTHETIC_TENANTS = new Set(["demo", "demoorg", "sample", "example", "test", "probe"]);
const SYNTHETIC_PREFIXES = ["demo-", "demo_", "probe-", "probe_", "test-", "sample-", "example-"];

function fail(reason) {
  return { ok: false, reason };
}

/** Canonical subject email: NFC, trimmed, lowercased — the workspace's rule. */
export function normalizeEmail(value) {
  return String(value).normalize("NFC").trim().toLowerCase();
}

/**
 * True when `companyId` is a real tenant we are willing to store data under.
 * Defence in depth: the workspace's embed-token route already refuses a demo
 * Subject (`requireWorkspaceUser(request, { allowDemo: false })`), so this
 * should never fire in production. It fires for the certification probe's
 * synthetic identities and for anything hand-rolled, and it is the reason a
 * synthetic subject cannot reach a real-data write here.
 */
export function isRealTenant(companyId) {
  if (typeof companyId !== "string") return false;
  if (!ORG_ID_PATTERN.test(companyId)) return false;
  const lower = companyId.toLowerCase();
  if (SYNTHETIC_TENANTS.has(lower)) return false;
  return !SYNTHETIC_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Verify an identity token.
 *
 * Timing is strict and grace-free — see the note on `MAX_TOKEN_TTL_SECONDS`.
 *
 * @param {string|null|undefined} token
 * @param {{secrets: string[], audience: string, now?: number,
 *          requireScope?: string}} opts  `now` is whole seconds
 * @returns {{ok: true, identity: object} | {ok: false, reason: string}}
 */
export function verifyIdentityToken(token, opts) {
  if (typeof token !== "string" || token.length === 0) return fail("missing");
  if (token.length > 4096) return fail("malformed");

  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [headerPart, payloadPart, signaturePart] = parts;

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return fail("malformed");
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    return fail("malformed");
  }
  // Reject `alg: none` and every other confusion: HS256 or nothing.
  if (header?.alg !== "HS256") return fail("alg");

  const signingInput = `${headerPart}.${payloadPart}`;
  const provided = Buffer.from(signaturePart, "base64url");
  let signatureOk = false;
  for (const secret of opts.secrets ?? []) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(signingInput).digest();
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) return fail("signature");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // Our own clock has to be a whole number of seconds too; a caller that
  // passes milliseconds, or a float, gets a refusal rather than nonsense.
  if (!Number.isSafeInteger(now)) return fail("clock");

  if (claims.iss !== WORKSPACE_TOKEN_ISSUER) return fail("issuer");
  if (claims.aud !== opts.audience) return fail("audience");

  // Mandatory bounds. A token missing any of these is not a workspace identity token.
  // Safe INTEGER, not merely finite: `exp: 1.5` and `exp: 1e21` are both
  // arithmetic hazards, and neither is a second.
  if (!Number.isSafeInteger(claims.exp)) return fail("exp");
  if (!Number.isSafeInteger(claims.iat)) return fail("iat");
  if (typeof claims.jti !== "string" || claims.jti.trim().length === 0) return fail("jti");
  if (typeof claims.sub !== "string" || !claims.sub.includes("@")) return fail("sub");

  // Lifetime: positive, and ≤300s with NO grace. `exp <= iat` covers both a
  // zero-length token and a reversed one.
  const lifetime = claims.exp - claims.iat;
  if (lifetime <= 0) return fail("ttl");
  if (lifetime > MAX_TOKEN_TTL_SECONDS) return fail("ttl");

  // Dead the instant `now` reaches `exp` — `exp` is the first second at which
  // the token is no longer valid, not the last at which it is.
  if (now >= claims.exp) return fail("expired");
  // Not valid before it was minted. No future-dating tolerance.
  if (now < claims.iat) return fail("not_yet_valid");

  // Scope must be a subset of what the workspace actually mints.
  const scope = claims.scope;
  if (!Array.isArray(scope) || scope.length === 0) return fail("scope");
  if (!scope.every((entry) => KNOWN_SCOPES.includes(entry))) return fail("scope");
  if (opts.requireScope && !scope.includes(opts.requireScope)) return fail("scope");

  // `companyId` arrives only when the org granted `identity.companyId`. This
  // app is tenant-scoped, so no companyId means no tenant means no service.
  if (typeof claims.companyId !== "string" || claims.companyId.trim().length === 0) {
    return fail("companyId");
  }

  return {
    ok: true,
    identity: Object.freeze({
      email: normalizeEmail(claims.sub),
      companyId: claims.companyId.trim(),
      jti: claims.jti,
      issuedAt: claims.iat,
      /** Seconds. The ceiling on everything downstream — nothing may extend it. */
      expiresAt: claims.exp,
      scope: Object.freeze([...scope]),
      // ── ADVISORY ONLY. Never authorize on these. ───────────────────────
      // They were true when the token was minted, up to 300 seconds ago.
      // `authorize.mjs` asks the workspace what is true NOW.
      tokenOrgRole: typeof claims.orole === "string" ? claims.orole.toLowerCase() : undefined,
      tokenDeptSlugs: Object.freeze(Array.isArray(claims.depts) ? [...claims.depts] : []),
      tokenRoleSlugs: Object.freeze(Array.isArray(claims.roles) ? [...claims.roles] : []),
      tokenPermissions: Object.freeze(Array.isArray(claims.perms) ? [...claims.perms] : []),
      /**
       * The `pa` (platform-admin) claim. Present only for XRAY staff, and the
       * embed-token route never sets it. This app deliberately does NOT read
       * it for authorization: an org's admin plane is an ORG role decision,
       * and letting a platform claim open it is exactly the override that
       * should not exist. Surfaced so you can see it exists and is unused.
       */
      platformAdminClaim: claims.pa === true,
    }),
  };
}

// A minting half deliberately does NOT live here. The workspace is the only
// minter; a service holds the key to VERIFY. The tests' mint is in
// `test-support.mjs`, where nothing a service would deploy can reach it.
