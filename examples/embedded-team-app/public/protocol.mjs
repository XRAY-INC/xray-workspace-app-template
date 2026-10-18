/**
 * The embed handshake's message rules — ONE pure module, loaded unchanged by
 * both halves: the browser (`<script type="module">`, same origin) and the
 * node test suite. Sharing the file is the point: the rule the tests assert is
 * literally the rule the browser runs.
 *
 * Zero imports, zero DOM, zero node builtins. Do not add any.
 *
 * Mirrors the Workspace's embed protocol (checked against its real messages:
 * `contract.test.mjs`). The host is the Workspace's embed frame: it listens
 * for our `ready`, mints a short-lived identity token, and posts it back targeted at our origin.
 */

export const EMBED_MESSAGE = Object.freeze({
  ready: "xray:embed:ready",
  token: "xray:embed:token",
  theme: "xray:embed:theme",
});

/** A JWT bigger than this is not one of ours; refuse before touching it. */
export const MAX_TOKEN_LENGTH = 4096;

/** Three base64url segments. Cheap shape gate before the token leaves the page. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The message we send UP to announce we are loaded and want a token. */
export function readyMessage() {
  return { type: EMBED_MESSAGE.ready };
}

function deny(reason) {
  return { ok: false, reason };
}

/**
 * Decide whether an incoming `message` event carries a token we may use.
 *
 * Both halves of "who sent this" are checked, because either alone is
 * bypassable: `event.origin` alone would accept a message from ANY window at
 * the workspace origin (a popup, a sibling frame the host opened), and
 * `event.source === parent` alone would accept whatever origin happens to be
 * framing us. We require both, plus the shape.
 *
 * Unknown extra keys on the message are IGNORED rather than rejected, so the
 * host can add a field without breaking already-deployed services. The keys
 * we consume are validated strictly.
 *
 * @param {{origin: string, source: unknown, data: unknown}} event
 * @param {{expectedOrigin: string, parentWindow: unknown, selfWindow: unknown}} ctx
 * @returns {{ok: true, token: string} | {ok: false, reason: string}}
 */
export function acceptTokenMessage(event, ctx) {
  const { expectedOrigin, parentWindow, selfWindow } = ctx ?? {};
  if (typeof expectedOrigin !== "string" || expectedOrigin.length === 0) {
    return deny("no_expected_origin");
  }
  // Not framed (or framed by ourselves): there is no host to trust.
  if (!parentWindow || parentWindow === selfWindow) return deny("not_framed");
  if (!event || typeof event !== "object") return deny("shape");
  if (event.origin !== expectedOrigin) return deny("origin");
  if (event.source !== parentWindow) return deny("source");

  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return deny("shape");
  if (data.type !== EMBED_MESSAGE.token) return deny("type");

  const token = data.token;
  if (typeof token !== "string") return deny("shape");
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return deny("length");
  if (!JWT_SHAPE.test(token)) return deny("shape");

  return { ok: true, token };
}

// ── theme handoff, protocol v1 ──────────────────────────────────────────────
//
// Inside a frame, `prefers-color-scheme` follows the OPERATING SYSTEM, not the
// workspace around you — which is how a light workspace ended up framing a
// dark app. So the host hands its theme over twice:
//
//   1. `?theme=light|dark` on your frame URL, for the first paint. Read it
//      before you paint (this example's server renders it into
//      `<html data-theme>`), so the page never flashes the wrong palette.
//   2. `{ type: "xray:embed:theme", version: 1, mode, tokens, radius, fonts }`,
//      posted after your `ready` and again on every theme change, targeted at
//      your origin. The workspace's own computed colours: apply them and you
//      are painted in the workspace's palette, not an approximation of it.
//
// Everything in that message ends up in CSS, so it is validated as strictly as
// the token: a value that fails its pattern could otherwise smuggle a
// `url(…)` or a `;` into a stylesheet.

/** Every colour the workspace sends. Nothing else is ever applied. */
export const THEME_COLOR_PATTERN = /^hsl\(\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%\)$/;

/** The corner radius the workspace sends. */
export const THEME_RADIUS_PATTERN = /^\d{1,3}(\.\d{1,3})?(rem|px)$/;

/** The token names of version 1 — a closed set; a new name comes with a new version. */
export const THEME_TOKEN_NAMES = Object.freeze([
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "destructive",
  "destructiveForeground",
  "border",
  "input",
  "ring",
]);

/**
 * The typefaces this app knows how to render, by the names the workspace
 * sends. An app applies a family ONLY if it is on its own list — never a
 * string from a message straight into `font-family`. This example self-hosts
 * neither, so it accepts the names (a valid message) and keeps its own stack.
 */
export const THEME_FONT_ALLOWLIST = Object.freeze({
  body: Object.freeze(["Urbanist"]),
  heading: Object.freeze(["Figtree"]),
});

const THEME_KEYS = ["type", "version", "mode", "tokens", "radius", "fonts"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * The mode for the FIRST paint, from the frame URL's query — `"light"`,
 * `"dark"`, or null when the workspace did not say (then follow your own
 * default until the message arrives).
 *
 * @param {string} search `location.search`
 * @returns {"light" | "dark" | null}
 */
export function themeFromSearch(search) {
  let value = null;
  try {
    value = new URLSearchParams(search).get("theme");
  } catch {
    return null;
  }
  return value === "light" || value === "dark" ? value : null;
}

/**
 * Decide whether an incoming `message` event is a workspace theme we may apply.
 *
 * The same two sender checks as the token (exact origin AND the parent
 * window), then a STRICT schema: version 1 exactly, no unknown keys at any
 * level, `mode` light or dark, every token a known name whose value matches
 * the colour pattern, the radius its pattern, the fonts this app's allowlist.
 * Any failure refuses the whole message — keep the theme you have.
 *
 * Tokens may be MISSING: the host omits one it could not read rather than
 * sending it malformed. Fall back to your own value for that token.
 *
 * @param {{origin: string, source: unknown, data: unknown}} event
 * @param {{expectedOrigin: string, parentWindow: unknown, selfWindow: unknown}} ctx
 * @returns {{ok: true, theme: {mode: "light" | "dark", tokens: Record<string, string>, radius: string, fonts: {body: string, heading: string}}} | {ok: false, reason: string}}
 */
export function acceptThemeMessage(event, ctx) {
  const { expectedOrigin, parentWindow, selfWindow } = ctx ?? {};
  if (typeof expectedOrigin !== "string" || expectedOrigin.length === 0) {
    return deny("no_expected_origin");
  }
  if (!parentWindow || parentWindow === selfWindow) return deny("not_framed");
  if (!event || typeof event !== "object") return deny("shape");
  if (event.origin !== expectedOrigin) return deny("origin");
  if (event.source !== parentWindow) return deny("source");

  const data = event.data;
  if (!isPlainObject(data)) return deny("shape");
  if (data.type !== EMBED_MESSAGE.theme) return deny("type");
  // A version this code does not know is not an error to shout about — the
  // host may be newer. Ignore it and keep the current theme.
  if (data.version !== 1) return deny("version");
  if (!onlyKeys(data, THEME_KEYS)) return deny("shape");
  if (data.mode !== "light" && data.mode !== "dark") return deny("mode");

  if (!isPlainObject(data.tokens) || !onlyKeys(data.tokens, THEME_TOKEN_NAMES)) {
    return deny("tokens");
  }
  const tokens = {};
  for (const [name, value] of Object.entries(data.tokens)) {
    if (typeof value !== "string" || !THEME_COLOR_PATTERN.test(value)) return deny("color");
    tokens[name] = value;
  }

  if (typeof data.radius !== "string" || !THEME_RADIUS_PATTERN.test(data.radius)) {
    return deny("radius");
  }

  const fonts = data.fonts;
  if (!isPlainObject(fonts) || !onlyKeys(fonts, ["body", "heading"])) return deny("fonts");
  if (
    !THEME_FONT_ALLOWLIST.body.includes(fonts.body) ||
    !THEME_FONT_ALLOWLIST.heading.includes(fonts.heading)
  ) {
    return deny("fonts");
  }

  return {
    ok: true,
    theme: {
      mode: data.mode,
      tokens,
      radius: data.radius,
      fonts: { body: fonts.body, heading: fonts.heading },
    },
  };
}
