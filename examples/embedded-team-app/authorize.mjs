/**
 * The current-authorization callback.
 *
 *   POST {workspaceOrigin}/api/v1/registry/{slug}/authorize
 *   X-Workspace-Api-Key: <registered service key>
 *   { "token": "<the identity token the browser gave us>" }
 *
 * Why it exists: the identity token is a photograph, up to 300 seconds old.
 * Its `orole`/`perms` claims were true when it was minted. Before anything
 * that matters we ask the workspace what is true NOW — which is also how a
 * revoked install, a demoted admin, or a suspended service stops us within
 * one request instead of within one token lifetime.
 *
 * Rules this module keeps, all of them the boring kind that get skipped:
 *   · Configured origin only. HTTPS, unless you explicitly opted into a
 *     loopback origin for a local run.
 *   · No redirect following — a 3xx is a denial, not a hop.
 *   · A short AbortSignal timeout, and a bounded response body.
 *   · Fail CLOSED on every error: timeout, network, redirect, non-200, an
 *     oversized body, unparseable JSON, a shape that does not match.
 *   · NO positive caching. Ever. Caching an "allowed" is caching the thing
 *     the callback exists to stop caching.
 *   · The answer is reconciled against the token we already verified: same
 *     subject, same tenant, and an expiry that can only be EARLIER.
 */
import { z } from "zod";

import { normalizeEmail } from "./identity-token.mjs";

/** Contract: the request body is strict JSON `{token}`, ≤8KB, token ≤4096. */
export const MAX_REQUEST_TOKEN_LENGTH = 4096;
/** Anything larger than this is not the envelope; stop reading. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** How stale an `asOf` we will believe. The workspace answers in real time. */
export const MAX_ASOF_AGE_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const isoTimestamp = z
  .string()
  .trim()
  .max(64)
  .refine((value) => ISO_8601.test(value) && Number.isFinite(Date.parse(value)), {
    message: "must be an ISO 8601 timestamp",
  });

const slugList = (cap) => z.array(z.string().trim().min(1).max(64)).max(cap).default([]);

/**
 * The SUCCESS envelope, and only the success envelope. A negative answer from
 * the workspace has no `active` field at all — it is
 * `{error: {code, message}}` with 400 VALIDATION_ERROR / 401 UNAUTHORIZED /
 * 403 FORBIDDEN / 429 RATE_LIMITED / 503 UNAVAILABLE — so it fails this parse
 * and lands in the same fail-closed branch as a network error. That is
 * deliberate: there is one allow path and everything else denies.
 *
 * Unknown extra keys are stripped rather than rejected, so the workspace can
 * add a field without breaking already-deployed services. Every key we
 * actually consume is validated.
 */
export const authorizeResponseSchema = z.object({
  data: z.object({
    active: z.literal(true),
    subject: z.object({
      email: z.string().trim().min(3).max(254),
      companyId: z.string().trim().min(1).max(64),
    }),
    access: z.object({
      orgRole: z.string().trim().min(1).max(40),
      deptSlugs: slugList(8),
      roleSlugs: slugList(8),
      /** Audience-filtered to `<slug>.*` by the workspace; cap 16. */
      permissions: slugList(16),
    }),
    expiresAt: isoTimestamp,
    asOf: isoTimestamp,
  }),
});

/** Org roles that open this app's admin plane. Nothing else does. */
export const ADMIN_ORG_ROLES = Object.freeze(["OWNER", "ADMIN"]);
const KNOWN_ORG_ROLES = Object.freeze(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

function deny(reason) {
  return { ok: false, reason };
}

/** Build the callback URL and prove it did not escape the configured origin. */
export function authorizeUrl(config) {
  const url = new URL(
    `/api/v1/registry/${encodeURIComponent(config.slug)}/authorize`,
    config.workspaceOrigin,
  );
  if (url.origin !== config.workspaceOrigin) {
    throw new Error("authorize URL escaped the configured workspace origin");
  }
  return url;
}

/** Read at most `limit` bytes. Returns null when the body is oversized. */
async function readBounded(response, limit) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return Buffer.byteLength(text) > limit ? null : text;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Ask the workspace. Returns the PARSED success envelope, or a denial reason.
 * Never throws, never caches, never follows a redirect.
 */
export async function callAuthorize({ token, config, fetchImpl = fetch }) {
  if (typeof token !== "string" || token.length === 0) return deny("no_token");
  if (token.length > MAX_REQUEST_TOKEN_LENGTH) return deny("token_too_long");

  let url;
  try {
    url = authorizeUrl(config);
  } catch {
    return deny("bad_config");
  }

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(config.authorizeTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Cache-Control": "no-store",
        "X-Workspace-Api-Key": config.workspaceApiKey,
      },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    const name = error?.name;
    return deny(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }

  if (response.redirected === true) return deny("redirect");
  const status = Number(response.status);
  if (status >= 300 && status < 400) return deny("redirect");
  // Distinguish only enough to tell the browser what to do next: a 401/403 is
  // "this person may not, right now" (re-open); everything else is "we could
  // not find out" (also a denial — just a different message, never a retry
  // loop on a bearer we already know is expired).
  if (status === 401 || status === 403) return deny("forbidden");
  if (status === 429) return deny("rate_limited");
  if (status !== 200) return deny("unavailable");

  let text;
  try {
    text = await readBounded(response, MAX_RESPONSE_BYTES);
  } catch {
    return deny("network");
  }
  if (text === null) return deny("too_large");

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return deny("malformed");
  }

  const parsed = authorizeResponseSchema.safeParse(json);
  if (!parsed.success) return deny("schema");
  return { ok: true, envelope: parsed.data.data };
}

/**
 * Reconcile the workspace's answer against the token we already verified.
 *
 * This is the step that makes the callback safe to act on: without it, a
 * compromised or confused response could name a different person, a different
 * tenant, or a later expiry than the token allows.
 *
 * @param {object} identity  the verified token identity
 * @param {object} envelope  the parsed `data` object
 * @param {{nowMs: number}} clock
 */
export function reconcileAuthorization(identity, envelope, clock) {
  const nowMs = clock.nowMs;

  if (normalizeEmail(envelope.subject.email) !== identity.email) return deny("subject_mismatch");
  if (envelope.subject.companyId !== identity.companyId) return deny("tenant_mismatch");

  const asOfMs = Date.parse(envelope.asOf);
  if (asOfMs > nowMs + CLOCK_SKEW_SECONDS * 1000) return deny("asof_in_future");
  if (nowMs - asOfMs > MAX_ASOF_AGE_SECONDS * 1000) return deny("asof_stale");

  // The token's exp is the ceiling. A callback may shorten a session; it may
  // never lengthen one, so this is a min(), not an assignment.
  const tokenExpiryMs = identity.expiresAt * 1000;
  const claimedExpiryMs = Date.parse(envelope.expiresAt);
  const expiresAtMs = Math.min(tokenExpiryMs, claimedExpiryMs);
  if (expiresAtMs <= nowMs) return deny("expired");

  const orgRole = String(envelope.access.orgRole).trim().toUpperCase();
  // An unrecognised role is not an error — but it is never an admin.
  const known = KNOWN_ORG_ROLES.includes(orgRole);

  return {
    ok: true,
    access: Object.freeze({
      email: identity.email,
      companyId: identity.companyId,
      orgRole: known ? orgRole : "UNKNOWN",
      isAdmin: ADMIN_ORG_ROLES.includes(orgRole),
      deptSlugs: Object.freeze([...envelope.access.deptSlugs]),
      roleSlugs: Object.freeze([...envelope.access.roleSlugs]),
      permissions: Object.freeze([...envelope.access.permissions]),
      /** Milliseconds. Never later than the token's own exp. */
      expiresAtMs,
    }),
  };
}

/**
 * call + reconcile, the pair every protected handler runs. No caching.
 *
 * Takes a CLOCK, not a timestamp, and reads it AFTER the network round trip.
 * That distinction is the whole point: a snapshot taken before `await` is a
 * statement about when the request started, and reconciliation needs to know
 * when the answer arrived. A token that lapses while the callback is in
 * flight — a slow workspace, a retried TCP handshake, a token that had two
 * seconds left — would otherwise reconcile against a moment when it was still
 * alive, and be honoured after it was not.
 *
 * `clock` is injectable so tests can advance time deterministically instead of
 * sleeping; production passes `Date.now`.
 */
export async function authorizeRequest({ token, identity, config, fetchImpl, clock }) {
  const readClock = clock ?? Date.now;
  const called = await callAuthorize({ token, config, fetchImpl });
  if (!called.ok) return called;
  // Read the clock here, not above.
  return reconcileAuthorization(identity, called.envelope, { nowMs: readClock() });
}
