/**
 * The framed page.
 *
 * Everything about how this file handles the token is deliberate:
 *
 *   · It lives in a module-scoped `let`. Not `localStorage`, not
 *     `sessionStorage`, not a cookie, not the URL, not a `data-` attribute,
 *     and never an argument to `console.*`. When the page unloads it is gone,
 *     which is the correct lifetime for a ≤300s credential.
 *   · It is sent only to this app's own backend, as `Authorization: Bearer`.
 *     The registered service's API key is not here and must never be — that
 *     key is the SERVICE's credential and lives only in the server process.
 *   · Expiry fails closed. There is no refresh endpoint to call, because the
 *     workspace does not have one: the host mints a new token each time we
 *     announce `xray:embed:ready`, so re-announcing IS the renewal. If the
 *     host has gone (the user navigated away from the app's page in the
 *     workspace), nothing answers, and we say so rather than retrying.
 *
 * Loaded as a module from this app's own origin. No inline script, no CDN.
 */
import {
  EMBED_MESSAGE,
  acceptThemeMessage,
  acceptTokenMessage,
  readyMessage,
} from "./protocol.mjs";

/** How long to wait for a token after announcing, before telling the user. */
const HANDSHAKE_TIMEOUT_MS = 8_000;
/** Re-announce this far ahead of expiry, so a live session never blinks. */
const RENEW_LEAD_MS = 20_000;
/**
 * How many times we will re-announce before giving up and telling the user.
 *
 * There is no refresh endpoint: re-announcing IS the renewal, and the host
 * answers every announcement. So if the host answers with a token the server
 * has already rejected, announcing again produces the same rejection — a
 * tight loop against our own backend. Two independent brakes below: this
 * counter, and an exact match against the token that just failed.
 */
const MAX_RENEW_ATTEMPTS = 3;

const REOPEN_GUIDANCE =
  "Your workspace session for this app has ended. " +
  "Re-open Team notes from the workspace to continue.";

const workspaceOrigin = document.querySelector('meta[name="xray-workspace-origin"]')?.content ?? "";

const el = (id) => document.getElementById(id);
const statusLine = el("status");
const alertBox = el("alert");
const signedIn = el("signed-in");
const adminPlane = el("admin-plane");
const logList = el("handshake-log-items");

/** The credential. Module scope, nothing else. */
let identityToken = null;
let session = null;
let renewTimer = null;
let handshakeTimer = null;
/** The token the server just refused, so the host cannot hand it back to us. */
let lastRejectedToken = null;
let renewAttempts = 0;

function log(message) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  logList.append(item);
}

function setStatus(text) {
  statusLine.textContent = text;
}

function showAlert(text) {
  alertBox.textContent = text;
  alertBox.hidden = false;
}

function clearAlert() {
  alertBox.textContent = "";
  alertBox.hidden = true;
}

// ── the handshake ───────────────────────────────────────────────────────────

/** Stop. Tell the person what to do. Do not ask the host again. */
function giveUp(logLine) {
  clearTimeout(handshakeTimer);
  clearTimeout(renewTimer);
  identityToken = null;
  session = null;
  setStatus("Not signed in.");
  showAlert(REOPEN_GUIDANCE);
  log(logLine);
}

function announce() {
  if (window.parent === window) {
    setStatus("This app runs inside the workspace.");
    showAlert("Open Team notes from your XRAY Workspace — it needs the workspace to sign you in.");
    log("not framed: no host to hand us an identity");
    return;
  }
  // Targeted at the configured origin, so the request itself cannot be read
  // by a page that framed us from somewhere else.
  window.parent.postMessage(readyMessage(), workspaceOrigin);
  log(`announced ${EMBED_MESSAGE.ready} to ${workspaceOrigin}`);
  clearTimeout(handshakeTimer);
  handshakeTimer = setTimeout(() => {
    if (identityToken) return;
    giveUp("no token arrived within the handshake window");
  }, HANDSHAKE_TIMEOUT_MS);
}

// ── the theme ───────────────────────────────────────────────────────────────

/**
 * Workspace token → this page's own custom property. Only these are applied,
 * and only after `acceptThemeMessage` has checked every value against its
 * pattern. A token the workspace omitted falls back to this page's own value
 * for the mode.
 */
const THEME_PROPERTIES = Object.freeze({
  background: "--ground",
  foreground: "--ink",
  mutedForeground: "--muted",
  border: "--line",
  destructive: "--alert",
});

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  // The CSSOM, not a style attribute: this page's `style-src 'self'` allows
  // it, and a value that passed the colour pattern cannot carry a `;` or a
  // `url(…)` into the cascade.
  for (const [token, property] of Object.entries(THEME_PROPERTIES)) {
    const value = theme.tokens[token];
    if (value) root.style.setProperty(property, value);
    else root.style.removeProperty(property);
  }
  root.style.setProperty("--radius", theme.radius);
  // theme.fonts named families from our allowlist; this example self-hosts
  // neither, so it keeps its own stack. An app that ships Figtree/Urbanist
  // maps the NAME to its own @font-face here — never the raw string.
}

// nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation -- the origin IS validated: acceptThemeMessage and acceptTokenMessage (protocol.mjs) reject any event whose origin is not expectedOrigin or whose source is not the parent window; Semgrep cannot see through the helpers.
window.addEventListener("message", (event) => {
  if (event.data && typeof event.data === "object" && event.data.type === EMBED_MESSAGE.theme) {
    const theme = acceptThemeMessage(event, {
      expectedOrigin: workspaceOrigin,
      parentWindow: window.parent,
      selfWindow: window,
    });
    if (!theme.ok) {
      log(`ignored a theme (${theme.reason})`);
      return;
    }
    applyTheme(theme.theme);
    log(`applied the workspace's ${theme.theme.mode} theme`);
    return;
  }
  const verdict = acceptTokenMessage(event, {
    expectedOrigin: workspaceOrigin,
    parentWindow: window.parent,
    selfWindow: window,
  });
  if (!verdict.ok) {
    // Ignored, not shown to the user as a failure — a page receives all kinds
    // of postMessage traffic. Logged (by REASON, never by content) so the
    // rejection is observable while debugging.
    if (event.data && typeof event.data === "object" && event.data.type) {
      log(`ignored a message (${verdict.reason})`);
    }
    return;
  }
  // The host answers every announcement, so it can hand back the very token
  // the server just refused. Accepting it would re-fail, re-announce, and
  // spin. One comparison ends it.
  if (verdict.token === lastRejectedToken) {
    giveUp("the workspace re-sent a token the server has already refused");
    return;
  }
  clearTimeout(handshakeTimer);
  identityToken = verdict.token;
  log("accepted an identity token from the workspace");
  clearAlert();
  void bootstrap();
});

/**
 * Expiry path. There is no refresh call to make: the host mints a new token
 * on every `ready`, so re-announcing IS the renewal. Bounded, and never a
 * tight retry against a bearer we already know is dead.
 */
function reHandshake(reason) {
  lastRejectedToken = identityToken;
  identityToken = null;
  session = null;
  clearTimeout(renewTimer);
  renewAttempts += 1;
  if (renewAttempts > MAX_RENEW_ATTEMPTS) {
    giveUp(`gave up after ${MAX_RENEW_ATTEMPTS} attempts (${reason})`);
    return;
  }
  log(`re-announcing (${reason})`);
  setStatus("Reconnecting to your workspace…");
  announce();
}

// ── talking to our own backend ──────────────────────────────────────────────

async function call(path, init = {}) {
  if (!identityToken) return { expired: true };
  const response = await fetch(path, {
    ...init,
    credentials: "omit",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
      Authorization: `Bearer ${identityToken}`,
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 401 && body?.error?.code === "TOKEN_EXPIRED") {
    return { expired: true };
  }
  return { status: response.status, body };
}

async function bootstrap() {
  const result = await call("/app/session", { method: "POST" });
  if (result.expired) return reHandshake("the session call found an expired token");
  if (result.status !== 200) {
    setStatus("Not signed in.");
    showAlert(result.body?.error?.message ?? "The workspace could not confirm your access.");
    return;
  }
  session = result.body.data;
  // A working session clears the brakes: the next expiry gets a fresh budget.
  renewAttempts = 0;
  lastRejectedToken = null;
  const deptList =
    Array.isArray(session.deptSlugs) && session.deptSlugs.length > 0
      ? ` · Depts: ${session.deptSlugs.join(", ")}`
      : "";
  const roleList =
    Array.isArray(session.roleSlugs) && session.roleSlugs.length > 0
      ? ` · Roles: ${session.roleSlugs.join(", ")}`
      : "";
  setStatus(
    `Signed in as ${session.email} — ${session.orgRole.toLowerCase()} of this organisation${deptList}${roleList}.`,
  );
  signedIn.hidden = false;
  adminPlane.hidden = !session.isAdmin;

  // Renew before it lapses, so a person working in the frame never sees the
  // expiry path. The floor keeps a very short token from busy-looping.
  const lead = Date.parse(session.expiresAt) - Date.now() - RENEW_LEAD_MS;
  clearTimeout(renewTimer);
  renewTimer = setTimeout(() => reHandshake("token nearing expiry"), Math.max(lead, 1_000));

  await refreshNotes();
}

async function refreshNotes() {
  // Your own notes: the backend serves these from the verified token alone.
  const mine = await call("/app/notes");
  if (mine.expired) return reHandshake("a read found an expired token");
  if (mine.status !== 200) return;
  renderNotes(el("my-notes"), mine.body.data.mine, false);
  el("my-notes-empty").hidden = mine.body.data.mine.length > 0;

  // Everyone's notes are a separate request on purpose: it reads other
  // people's rows, so the backend re-checks the role with the workspace
  // before answering. A member never asks for it, and would be refused.
  if (!session?.isAdmin) return;
  const org = await call("/app/org-notes");
  if (org.expired) return reHandshake("the organisation read found an expired token");
  if (org.status === 200) renderNotes(el("org-notes"), org.body.data.notes, true);
}

/**
 * `?note=<id>`: the workspace's ⌘K opened this page at one note (its search
 * result links here through `/svc/<slug>?at=/embed?note=<id>`). Read once, as
 * an id only — it selects which of YOUR notes to mark, never what you can see.
 */
const linkedNoteId = new URLSearchParams(window.location.search).get("note");

function renderNotes(list, notes, withRemove) {
  list.replaceChildren();
  for (const note of notes) {
    const item = document.createElement("li");
    if (linkedNoteId && note.id === linkedNoteId) {
      item.classList.add("is-linked");
      item.setAttribute("aria-current", "true");
      queueMicrotask(() => item.scrollIntoView({ block: "center" }));
    }
    const title = document.createElement("span");
    // textContent, never innerHTML: a note title is someone else's text.
    title.textContent = note.title;
    item.append(title);
    if (note.dept) {
      const deptBadge = document.createElement("span");
      deptBadge.className = "dept-tag";
      deptBadge.textContent = note.dept;
      item.append(deptBadge);
    }
    if (withRemove) {
      const byline = document.createElement("span");
      byline.className = "byline";
      byline.textContent = ` — ${note.owner}`;
      item.append(byline);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Remove";
      // The visible label is "Remove"; the accessible name says which note.
      button.setAttribute("aria-label", `Remove note: ${note.title}`);
      button.dataset.noteId = note.id;
      button.addEventListener("click", () => void removeNote(note.id));
      item.append(button);
    }
    list.append(item);
  }
}

function idempotencyKey() {
  return crypto.randomUUID();
}

el("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = el("note-title");
  const title = input.value.trim();
  if (!title) return;
  // Only the title. The server takes who we are from the verified token, so
  // there is nothing about identity for this body to carry — and it would be
  // rejected if it tried.
  const result = await call("/app/notes", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify({ title }),
  });
  if (result.expired) return reHandshake("adding a note found an expired token");
  if (result.status !== 201) {
    showAlert(result.body?.error?.message ?? "That note could not be saved.");
    return;
  }
  clearAlert();
  input.value = "";
  await refreshNotes();
});

async function removeNote(id) {
  const result = await call(`/app/org-notes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": idempotencyKey() },
  });
  if (result.expired) return reHandshake("removing a note found an expired token");
  if (result.status !== 200) {
    showAlert(result.body?.error?.message ?? "That note could not be removed.");
    return;
  }
  clearAlert();
  await refreshNotes();
}

announce();
