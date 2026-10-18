/**
 * The handshake, in a real browser.
 *
 * `security.test.mjs` proves the RULE (`acceptTokenMessage`) in isolation.
 * This proves the WIRING: that a real cross-origin iframe, a real
 * `postMessage`, a real CSP and the real `app.mjs` behave the way the rule
 * says they should. The two are different failures — a correct rule wired to
 * nothing passes the first suite and fails this one.
 *
 * Deliberately narrow. This is a smoke test for the embed boundary, not a UI
 * project: one host page, one app, four scenarios.
 *
 * Everything is loopback and in-process:
 *   · the app          — `createApp` with the online callback stubbed
 *   · the "workspace"  — a tiny local http server that frames the app and
 *                        posts a pre-minted token, standing in for
 *                        the Workspace's embed frame
 * No real workspace, no database, no network, no Playwright config, no
 * browser download at test time.
 *
 *   node --test examples/embedded-team-app/browser.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";

import { createApp } from "./server.mjs";
import { createStore } from "./store.mjs";
import { ADMIN, COMPANY_A, MEMBER, TEST_ENV, makeToken } from "./test-support.mjs";
import { parseExampleConfig } from "./config.mjs";

let chromium;
let browser;
let appServer;
let hostServer;
let appOrigin;
let hostOrigin;
let store;

/**
 * The stand-in for the workspace's `EmbedFrame`. Mirrors what that component
 * actually does: listen for `xray:embed:ready` from the app's origin, then
 * post a freshly minted token back TARGETED at that origin.
 *
 * `?role=` picks which token to hand over, and `?mode=` drives the negative
 * cases. The token is a literal string minted from a fixture key.
 */
function hostPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fake workspace</title></head>
<body>
  <h1>Workspace</h1>
  <iframe id="frame" title="Team notes"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          referrerpolicy="strict-origin"
          style="width:100%;height:600px;border:0"></iframe>
  <script>
    const params = new URLSearchParams(location.search);
    const appOrigin = params.get("appOrigin");
    const token = params.get("token");
    const mode = params.get("mode") ?? "normal";
    // Theme handoff v1: the mode rides the frame URL for the first paint, and
    // the full message answers "ready" — both exactly as EmbedFrame does.
    const theme = params.get("theme");
    const TOKENS = {
      light: { background: "hsl(40 100% 97%)", foreground: "hsl(213 53% 12%)" },
      dark: { background: "hsl(213 47% 7%)", foreground: "hsl(40 30% 94%)" },
    };
    const themeMessage = (m) => ({
      type: "xray:embed:theme",
      version: 1,
      mode: m,
      tokens: mode === "bad-theme" ? { background: "url(https://evil.example/x)" } : TOKENS[m],
      radius: "0.75rem",
      fonts: { body: "Urbanist", heading: "Figtree" },
    });
    const frame = document.getElementById("frame");
    frame.src = appOrigin + "/embed" + (theme ? "?theme=" + theme : "");
    window.addEventListener("message", (event) => {
      if (event.origin !== appOrigin) return;
      if (!event.data || event.data.type !== "xray:embed:ready") return;
      if (mode === "silent") return;                       // host never answers
      if (theme) frame.contentWindow.postMessage(themeMessage(theme), appOrigin);
      if (mode === "malformed") {
        // Right origin, right window, wrong shape.
        frame.contentWindow.postMessage({ type: "xray:embed:token" }, appOrigin);
        return;
      }
      frame.contentWindow.postMessage({ type: "xray:embed:token", token }, appOrigin);
    });
  </script>
</body></html>`;
}

before(async () => {
  ({ chromium } = await import("@playwright/test"));
  try {
    browser = await chromium.launch();
  } catch (error) {
    // A missing browser binary is a machine-setup problem, not a regression.
    // Say so loudly rather than passing quietly.
    if (/Executable doesn't exist|please run|browserType.launch/i.test(String(error?.message))) {
      console.error(
        "\n  embedded-team-app browser test: chromium is not installed.\n" +
          "  Run `npx playwright install chromium`, then re-run.\n",
      );
    }
    throw error;
  }

  store = createStore();
  // One note owned by someone else, so the admin plane has something to act on.
  store.add({
    companyId: COMPANY_A,
    ownerEmail: "colleague@example.com",
    title: "Someone else's note",
  });

  const parsed = parseExampleConfig({
    ...TEST_ENV,
    // The app and the "workspace" are two loopback origins on different
    // ports, which is a genuine cross-origin pair for postMessage and CSP.
    TEAMAPP_WORKSPACE_ORIGIN: "http://127.0.0.1:1",
    TEAMAPP_ALLOW_INSECURE_LOOPBACK: "true",
  });
  assert.equal(parsed.ok, true);

  // The host has to exist before the app can be told its origin.
  hostServer = http.createServer((req, res) => {
    const html = hostPage();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
  });
  await new Promise((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
  hostOrigin = `http://127.0.0.1:${hostServer.address().port}`;

  const config = { ...parsed.config, workspaceOrigin: hostOrigin };
  appServer = createApp({
    config,
    store,
    // The stubbed online boundary: the role follows the token's subject, so
    // the two personas exercise the real member/admin branches. It takes a
    // CLOCK and reads it after the (instantaneous) round trip, exactly as the
    // real `authorizeRequest` does.
    authorize: async ({ identity, clock }) => {
      const nowMs = clock();
      const orgRole = identity.email === ADMIN ? "ADMIN" : "MEMBER";
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
  await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  appOrigin = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  await browser?.close();
  for (const server of [appServer, hostServer]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Open the fake workspace page and return the app's frame. */
async function openFrame(page, { token, mode = "normal", theme }) {
  const url = new URL(hostOrigin);
  url.searchParams.set("appOrigin", appOrigin);
  url.searchParams.set("mode", mode);
  if (token) url.searchParams.set("token", token);
  if (theme) url.searchParams.set("theme", theme);
  await page.goto(url.toString());
  const frame = page.frameLocator("#frame");
  return frame;
}

/** The handshake log is a closed <details>; its entries are hidden until opened. */
async function openLog(frame) {
  await frame.locator("#handshake-log > summary").click();
}

// The browser runs on the wall clock, so these tokens are minted on it too —
// unlike the node suites, which inject a fixed clock. Both halves of the server
// (verification and the stubbed callback) use that same real clock, so nothing
// here depends on how long the browser takes.
const liveSeconds = () => Math.floor(Date.now() / 1000);
const memberToken = () => makeToken({ sub: MEMBER, companyId: COMPANY_A, now: liveSeconds() });
const adminToken = () => makeToken({ sub: ADMIN, companyId: COMPANY_A, now: liveSeconds() });
const expiredToken = () =>
  makeToken({ sub: MEMBER, companyId: COMPANY_A, now: liveSeconds() - 10_000, ttlSeconds: 60 });

describe("the embed handshake in a real browser", () => {
  test("a member signs in through the frame and can add a note", async () => {
    const page = await browser.newPage();
    const frame = await openFrame(page, { token: memberToken() });

    await frame
      .getByRole("status")
      .filter({ hasText: "Signed in as" })
      .waitFor({ timeout: 10_000 });
    const status = await frame.getByRole("status").textContent();
    assert.match(status, /Signed in as member@example\.com/);
    assert.match(status, /member of this organisation/);

    // The admin plane is not merely hidden — it is not offered.
    assert.equal(await frame.getByRole("heading", { name: "Everyone’s notes" }).count(), 0);

    await frame.getByLabel("Note").fill("Written from the browser");
    await frame.getByRole("button", { name: "Add note" }).click();
    await frame.getByText("Written from the browser").waitFor({ timeout: 10_000 });

    const mine = store.listOwn(COMPANY_A, MEMBER).map((note) => note.title);
    assert.deepEqual(mine, ["Written from the browser"]);
    await page.close();
  });

  test("an admin gets the organisation plane and can remove someone else's note", async () => {
    const page = await browser.newPage();
    const frame = await openFrame(page, { token: adminToken() });

    await frame
      .getByRole("heading", { name: "Everyone’s notes" })
      .waitFor({ state: "visible", timeout: 10_000 });
    const remove = frame.getByRole("button", { name: "Remove note: Someone else's note" });
    await remove.waitFor({ timeout: 10_000 });
    await remove.click();
    await remove.waitFor({ state: "detached", timeout: 10_000 });

    assert.ok(
      !store.listTenant(COMPANY_A).some((note) => note.title === "Someone else's note"),
      "the admin's delete reached the store",
    );
    await page.close();
  });

  test("a member's browser cannot call the admin operation directly", async () => {
    // The UI not offering a control is not a control. Same page, same real
    // token, straight at the endpoint.
    const seeded = store.add({
      companyId: COMPANY_A,
      ownerEmail: "colleague@example.com",
      title: "Protected note",
    });
    const page = await browser.newPage();
    const frame = await openFrame(page, { token: memberToken() });
    await frame
      .getByRole("status")
      .filter({ hasText: "Signed in as" })
      .waitFor({ timeout: 10_000 });

    const result = await page.frames()[1].evaluate(
      async ([id, token]) => {
        const call = (path, init) =>
          fetch(path, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
          }).then(async (res) => ({ status: res.status, body: await res.json() }));
        return {
          del: await call(`/app/org-notes/${id}`, {
            method: "DELETE",
            headers: { "Idempotency-Key": "browser-key-000001" },
          }),
          list: await call("/app/org-notes"),
        };
      },
      [seeded.note.id, memberToken()],
    );
    assert.equal(result.del.status, 403);
    assert.equal(result.del.body.error.code, "ADMIN_REQUIRED");
    assert.equal(result.list.status, 403, "nor may a member read the organisation's notes");
    assert.ok(store.getInTenant(COMPANY_A, seeded.note.id), "the note survived");
    await page.close();
  });

  test("a token from the wrong window or the wrong shape is ignored", async () => {
    const page = await browser.newPage();
    // The host stays silent, so the ONLY token offered is the bad one below.
    const frame = await openFrame(page, { token: memberToken(), mode: "silent" });
    await openLog(frame);

    const appFrame = page.frames()[1];
    // Same-window post: right token, wrong sender. `event.source` is the app
    // itself and `event.origin` is the app's own origin — both wrong.
    await appFrame.evaluate((token) => {
      // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- deliberate: the test posts with "*" from the wrong window to prove the receiver rejects it (origin + source), not to deliver a token.
      window.postMessage({ type: "xray:embed:token", token }, "*");
    }, memberToken());

    await frame.getByText(/ignored a message \(origin\)/).waitFor({ timeout: 10_000 });
    // Nothing signed in.
    assert.equal(await frame.locator("#signed-in").isVisible(), false);
    await page.close();
  });

  test("a malformed message from the real host is ignored, and the page says so", async () => {
    const page = await browser.newPage();
    const frame = await openFrame(page, { token: memberToken(), mode: "malformed" });
    await openLog(frame);
    await frame.getByText(/ignored a message \(shape\)/).waitFor({ timeout: 10_000 });
    assert.equal(await frame.locator("#signed-in").isVisible(), false);
    await page.close();
  });

  test("an expired token fails closed with re-open guidance, not a refresh loop", async () => {
    const page = await browser.newPage();
    let sessionCalls = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/app/session")) sessionCalls += 1;
    });
    const frame = await openFrame(page, { token: expiredToken() });

    // The page accepts the message (well-formed, from the host), the SERVER
    // refuses the token, and the page re-announces — at which point this host
    // hands back the SAME expired token. That is the real "your session is
    // over" case, and it must terminate in guidance rather than in a loop.
    const alert = frame.getByRole("alert");
    await alert.waitFor({ timeout: 20_000 });
    assert.match(await alert.textContent(), /Re-open Team notes from the workspace/);
    assert.equal(await frame.locator("#signed-in").isVisible(), false);

    // The brake, asserted rather than assumed: give it time to spin, then
    // check that it did not.
    await page.waitForTimeout(1_500);
    assert.ok(sessionCalls <= 2, `expected the retry to stop; saw ${sessionCalls} session calls`);
    await page.close();
  });

  test("the workspace's theme wins over the OS — from the first paint, then by message", async () => {
    // The owner's report: a light workspace framed a DARK app, because inside
    // a frame prefers-color-scheme follows the operating system.
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    const frame = await openFrame(page, { token: memberToken(), theme: "light" });
    await openLog(frame);
    await frame.getByText(/applied the workspace's light theme/).waitFor({ timeout: 10_000 });

    const appFrame = page.frames()[1];
    const painted = await appFrame.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      ground: getComputedStyle(document.documentElement).getPropertyValue("--ground").trim(),
      body: getComputedStyle(document.body).backgroundColor,
    }));
    assert.equal(painted.theme, "light");
    assert.equal(painted.ground, "hsl(40 100% 97%)");
    assert.equal(painted.body, "rgb(255, 250, 240)", "the workspace's cream, not the OS's dark");
    await context.close();
  });

  test("the first paint already has the workspace's mode, before any message", async () => {
    const response = await fetch(`${appOrigin}/embed?theme=dark`);
    assert.match(await response.text(), /<html lang="en" data-theme="dark">/);
  });

  test("a theme whose colour fails the pattern is ignored whole", async () => {
    const page = await browser.newPage();
    const frame = await openFrame(page, { token: memberToken(), theme: "dark", mode: "bad-theme" });
    await openLog(frame);
    await frame.getByText(/ignored a theme \(color\)/).waitFor({ timeout: 10_000 });
    const ground = await page
      .frames()[1]
      .evaluate(() => document.documentElement.style.getPropertyValue("--ground"));
    assert.equal(ground, "", "nothing from the refused message reached the cascade");
    await page.close();
  });

  test("the app's own origin is the only one allowed to frame it", async () => {
    // frame-ancestors names the host origin. A page on any other origin gets
    // a blocked frame — assert the header rather than the browser's console,
    // which is where the block is reported.
    const response = await fetch(`${appOrigin}/embed`, { redirect: "manual" });
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp.includes(`frame-ancestors ${hostOrigin}`), csp);
    assert.ok(!csp.includes("*"), csp);
  });
});
