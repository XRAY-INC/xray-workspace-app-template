/**
 * The example's OWN configuration — not the workspace's.
 *
 * Every variable here is prefixed `TEAMAPP_` and belongs to THIS fixture
 * process. None of them are read by the XRAY Workspace deployment, and this
 * file never reads `.env.local`. A third-party developer running this example
 * on their own hosting sets these; a workspace operator never does.
 *
 * Validation is Zod (the one runtime dependency) and fail-closed:
 * the process refuses to start rather than run with a half-configured
 * identity boundary.
 */
import { z } from "zod";

/** Registered service slugs are lowercase alphanumerics, 3–32. No hyphen. */
export const SERVICE_SLUG_PATTERN = /^[a-z0-9]{3,32}$/;

const secretString = z
  .string()
  .trim()
  .min(24, "must be at least 24 characters")
  .max(512, "is implausibly long");

const boolString = z
  .union([z.literal("true"), z.literal("false")])
  .transform((value) => value === "true");

/** Hosts we will accept over plain http, and only when explicitly opted in. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

const rawEnvSchema = z.object({
  TEAMAPP_PORT: z.coerce.number().int().min(1).max(65535).default(4802),
  TEAMAPP_SERVICE_SLUG: z
    .string()
    .trim()
    .regex(SERVICE_SLUG_PATTERN, "must be 3–32 lowercase letters/digits")
    .default("teamapp"),
  /** The per-service HS256 key the workspace signs identity tokens with. */
  TEAMAPP_EMBED_KEY: secretString,
  /**
   * OPTIONAL second verification key, for the window in which you have asked
   * the workspace to rotate your embed key. The workspace mints with exactly
   * ONE key; this slot exists so YOUR verifier keeps accepting tokens already
   * in flight, signed by the key being retired. There is no `embedKeyNext`
   * field in the platform's credential record — do not assume one.
   */
  TEAMAPP_EMBED_KEY_PREVIOUS: secretString.optional(),
  /** Exactly the workspace origin, scheme+host+port, no path. */
  TEAMAPP_WORKSPACE_ORIGIN: z.string().trim().min(8).max(200),
  /** The registered service API key. Backend only — never sent to a browser. */
  TEAMAPP_WORKSPACE_API_KEY: secretString,
  TEAMAPP_AUTHORIZE_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(2_000),
  /**
   * Permit an `http://127.0.0.1:PORT` workspace origin. For running this
   * example against a workspace on your own machine, and nothing else.
   */
  TEAMAPP_ALLOW_INSECURE_LOOPBACK: boolString.default(false),
});

/**
 * Parse an env-shaped object into the frozen config the app runs on.
 * Returns `{ ok: false, issues }` rather than throwing, so the caller decides
 * how loudly to fail. Issue strings name the VARIABLE and the rule — never
 * the value, because these values are secrets.
 */
export function parseExampleConfig(env) {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "config"}: ${issue.message}`,
      ),
    };
  }
  const raw = parsed.data;
  const issues = [];

  let origin = null;
  try {
    const url = new URL(raw.TEAMAPP_WORKSPACE_ORIGIN);
    if (url.pathname !== "/" || url.search || url.hash) {
      issues.push("TEAMAPP_WORKSPACE_ORIGIN: must be an origin only (no path, query or fragment)");
    }
    const loopback = isLoopbackHost(url.hostname);
    if (url.protocol === "https:") {
      origin = url.origin;
    } else if (url.protocol === "http:" && loopback && raw.TEAMAPP_ALLOW_INSECURE_LOOPBACK) {
      origin = url.origin;
    } else if (url.protocol === "http:") {
      issues.push(
        "TEAMAPP_WORKSPACE_ORIGIN: http is only allowed for a loopback host with TEAMAPP_ALLOW_INSECURE_LOOPBACK=true",
      );
    } else {
      issues.push("TEAMAPP_WORKSPACE_ORIGIN: must be https (or loopback http, opted in)");
    }
  } catch {
    issues.push("TEAMAPP_WORKSPACE_ORIGIN: is not a valid absolute URL");
  }

  if (raw.TEAMAPP_EMBED_KEY === raw.TEAMAPP_WORKSPACE_API_KEY) {
    issues.push("TEAMAPP_EMBED_KEY: must differ from TEAMAPP_WORKSPACE_API_KEY");
  }
  if (raw.TEAMAPP_EMBED_KEY_PREVIOUS === raw.TEAMAPP_EMBED_KEY) {
    issues.push("TEAMAPP_EMBED_KEY_PREVIOUS: must differ from TEAMAPP_EMBED_KEY");
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    config: Object.freeze({
      port: raw.TEAMAPP_PORT,
      slug: raw.TEAMAPP_SERVICE_SLUG,
      /** Verification key set: current first, then the one being retired. */
      embedKeys: Object.freeze(
        [raw.TEAMAPP_EMBED_KEY, raw.TEAMAPP_EMBED_KEY_PREVIOUS].filter(Boolean),
      ),
      workspaceOrigin: origin,
      workspaceApiKey: raw.TEAMAPP_WORKSPACE_API_KEY,
      authorizeTimeoutMs: raw.TEAMAPP_AUTHORIZE_TIMEOUT_MS,
      allowInsecureLoopback: raw.TEAMAPP_ALLOW_INSECURE_LOOPBACK,
    }),
  };
}
