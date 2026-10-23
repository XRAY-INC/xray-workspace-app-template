# embedded-team-app

A runnable reference for the **full-page embedded** app shape: the
workspace frames your page, cross-origin and sandboxed, and your
page has to establish who is looking at it without ever receiving a session.

The sibling fixture, [`examples/sdui-todo`](../sdui-todo), is the other shape —
you return blocks and the workspace renders them. Read that one for
server-driven UI. Read this one for identity across a frame boundary.

```bash
cp examples/embedded-team-app/.env.example examples/embedded-team-app/.env
# fill in the four keys, then (from the repository root):
npm run start:embedded
```

No framework, no build step, no dependency beyond `zod` and `node:*`. One
process, ~600 lines of application code.

---

## What this is, and what it is not

**It is** a teaching fixture. Data lives in a `Map` and dies with the process.
It carries no real user data and is not production hosting.

**It is not** proof that your service is safe to trust with real customers'
role data. That is a separate, deliberate step — see
[Trust tiers: two claims, not one](#trust-tiers-two-claims-not-one) below,
which is the part most people get wrong.

Copy the boundaries. Do not copy the storage.

---

## How the workspace names your page

The workspace names every page the same way: the title goes in
its top bar and a one-line description goes under it. For a framed app, the
top bar shows the manifest's `displayName`, and the line under it, above your
frame, is the manifest's `tagline`.

So this page follows these rules:

- **No visible title of its own.** `server.mjs` renders its `<h1>` with
  `class="sr-only"`, so screen readers still land on a heading.
- **Content starts right under the workspace's header.** `public/app.css` uses
  the workspace's gutters (16px, then 24px from 640px, then 32px from 768px)
  and no top padding.

Copy that too: a visible title here is the same title shown twice.

---

## The three boundaries

Everything worth learning here is in three files. Read them in this order.

### 1. The handshake — [`public/protocol.mjs`](./public/protocol.mjs)

One pure module with zero imports, loaded **unchanged** by both the browser
(`<script type="module">`, same origin) and the node test suite. Sharing the
file is the point: the rule the tests assert is literally the rule the browser
runs.

The page announces `xray:embed:ready` to its parent, targeted at the
configured workspace origin. The host (the workspace's embed frame) mints a
short-lived token and posts `xray:embed:token` back. A message is
accepted only when **both** halves of "who sent this" check out:

- `event.origin` is exactly the configured workspace origin — not a prefix, not
  a suffix, not a different scheme or port; and
- `event.source` is `window.parent`.

Either alone is bypassable. Origin alone accepts a message from any window at
the workspace origin — a popup, a sibling frame. Source alone accepts whatever
happens to be framing you. `security.test.mjs` asserts each near-miss.

Once accepted, the token lives in a module-scoped `let` and nowhere else:

| Never                                       | Why                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| the URL                                     | it ends up in history, referrers and server logs                                   |
| `localStorage` / `sessionStorage` / cookies | wrong lifetime for a ≤300s credential, and readable by anything else on the origin |
| `console.*`                                 | logs get shipped                                                                   |

It is sent to exactly one place — this app's own backend, as
`Authorization: Bearer`. The registered service's API key is **not** in the
browser and must never be.

#### The workspace's theme (theme handoff, protocol v1)

Inside a frame, `prefers-color-scheme` follows the operating system, not the
workspace around it — a light workspace framed this page dark until the host
started handing its theme over. The page takes it in two steps, both in the
files above:

- **First paint.** The host puts `?theme=light|dark` on the frame URL. The
  server reads it with `themeFromSearch` (`public/protocol.mjs`) and renders
  `<html data-theme="…">`, so `app.css` paints the right palette before any
  script runs. A module script would be too late — it runs after the first
  paint.
- **The message.** After each `xray:embed:ready` (before the token) and on
  every theme change, the host posts `xray:embed:theme`: the mode, up to 19
  colours as `hsl(H S% L%)`, a radius and two font family names.
  `acceptThemeMessage` checks the sender exactly as `acceptTokenMessage` does,
  then a strict v1 schema — every colour against its pattern, the radius
  against its pattern, the fonts against this app's allowlist — and refuses
  the whole message on any failure. `applyTheme` (`public/app.mjs`) sets the
  accepted colours as custom properties through the CSSOM, which this page's
  `style-src 'self'` allows, and never as CSS text.

`security.test.mjs` asserts the near-misses, `browser.test.mjs` a real frame
painting the workspace's cream under a dark OS, and `contract.test.mjs`
feeds the theme messages the workspace's real stylesheet produces through
`acceptThemeMessage`. The contract is in
[`docs/contract.md`](../../docs/contract.md#theme-handoff-v1).

### 2. Identity-token verification — [`identity-token.mjs`](./identity-token.mjs)

Mirrors the workspace's own verifier, and `contract.test.mjs` runs it against
tokens the workspace's real minter produced. Built on `node:crypto`, so there
is nothing extra to audit.

- **HS256 only.** `alg: none` and every other value is refused before any
  signature work.
- **Constant-time signature check** across the verification key set.
- **Issuer pinned** to `workspace.xray.tech`, **audience pinned** to your slug.
- **`exp`, `iat`, `jti`, `sub`, `scope` and `companyId` are all mandatory.**
- **The ≤300s lifetime ceiling is enforced here**, not just at mint. A mint-side
  clamp does not protect you from a token minted out of band with a leaked key
  and a far-future `exp`.
- **No clock skew, and timestamps must be whole seconds.** See below — this is
  the one place the reference is deliberately stricter than the first-party
  verifier.

Two claims are deliberately _not_ used for authorization:

- `orole` / `depts` / `roles` / `perms` were true when the token was minted, up
  to 300 seconds ago. They are surfaced as `identity.token*` so a reader can see
  they are advisory.
- `pa` ("this person is XRAY staff") is surfaced as
  `platformAdminClaim` and never consulted. An organisation's admin plane is an
  _org role_ decision. A platform claim opening it is exactly the override that
  should not exist. (The workspace's embed-token route does not set it anyway.)

#### Why there is no skew here

The workspace's first-party verifier allows ±30s of drift, which is right for a
fleet of first-party services whose clocks wander. But **grace compounds**, and
an earlier draft of this file showed how:

| Check       | Rule                   | Effect                    |
| ----------- | ---------------------- | ------------------------- |
| TTL ceiling | `exp - iat ≤ 300 + 30` | a 330s token is accepted  |
| Expiry      | `now ≤ exp + 30`       | usable 30s past `exp`     |
|             |                        | **360s of real validity** |

Twenty percent over a limit documented as a hard ≤300s — and it bites hardest
where it is least visible, because an **offline own-row read is gated by the
token alone**. The grace window _was_ the whole window: a revoked person kept
reading for six minutes, not five.

So this reference is strict, and the rules are worth stating exactly:

- `iat` and `exp` must be **safe integers** — not merely finite. `exp: 1.5` and
  `exp: 1e21` are arithmetic hazards, and neither is a second.
- The lifetime must be **positive and ≤300s**, with no grace above it. That
  covers reversed (`exp < iat`) and zero-length tokens too.
- A token is **dead the instant `now` reaches `exp`**. `exp` is the first second
  at which it is invalid, not the last at which it is valid.
- `iat` in the future is refused, with **no tolerance**.
- Your own clock must be whole seconds as well: milliseconds passed by mistake
  is a refusal, not a silently wrong comparison.

A service copying this file runs a clock that agrees with the workspace's to the
second — NTP, not hope — and in exchange gets a bound it can actually quote.

#### Time is read after the network, and again before the operation

Two related mistakes, both fixed here and both worth recognising in your own
code:

1. **Never snapshot the clock before an `await`.** `authorizeRequest` takes a
   _clock function_, not a timestamp, and reads it **after** the round trip.
   A snapshot taken before the call describes when the request started;
   reconciliation needs to know when the answer arrived. A token with two
   seconds left and a callback that takes three would otherwise reconcile as
   live.
2. **Re-check immediately before the operation.** Authenticating is not a
   moment, it is the start of one. Between the callback returning and the write
   happening there is an `await` on the request body — time the _client_
   controls completely. A client that dribbles out 8 KB over six minutes gets a
   decision made before its token expired and a write attempted long after. So
   `stillValid(access)` runs at the last possible instant: before a store
   mutation, before a privileged read is serialised, and before an idempotency
   replay hands back a recorded answer. It compares against
   `min(token exp, callback expiry)`, so whichever runs out first wins.

### 3. Current authorization — [`authorize.mjs`](./authorize.mjs)

```
POST {workspaceOrigin}/api/v1/registry/{slug}/authorize
X-Workspace-Api-Key: <your registered service key>
{ "token": "<the identity token the browser gave us>" }
```

The identity token is a photograph. Before anything that matters, ask the
workspace what is true **now**. That is how a revoked install, a demoted admin
or a suspended service stops you within one request instead of within one token
lifetime.

The call:

- goes to the **configured origin only**, over HTTPS (loopback `http` needs an
  explicit opt-in for local runs);
- **does not follow redirects** — a 3xx is a denial, not a hop;
- carries a short `AbortSignal` timeout and reads a **bounded** body;
- **fails closed** on timeout, network error, redirect, any non-200, an
  oversized body, unparseable JSON, or a shape that does not match; and
- is **never positively cached**. Caching an "allowed" caches the thing the
  callback exists to stop caching. `security.test.mjs` counts the calls.

A success is accepted only in this shape:

```jsonc
{
  "data": {
    "active": true,
    "subject": { "email": "…", "companyId": "…" },
    "access": {
      "orgRole": "ADMIN",
      "deptSlugs": [], // cap 8
      "roleSlugs": [], // cap 8
      "permissions": [], // audience-filtered to `<slug>.*`, cap 16
    },
    "expiresAt": "2026-09-09T12:05:00.000Z", // ISO 8601
    "asOf": "2026-09-09T12:00:00.000Z",
  },
}
```

A negative answer has **no `active` field at all** — it is
`{"error": {"code", "message"}}` with `400 VALIDATION_ERROR`,
`401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED` or `503 UNAVAILABLE`.
That fails the success parse and lands in the same fail-closed branch as a
network error, which is deliberate: there is one allow path and everything else
denies.

Then the answer is **reconciled against the token you already verified**:

- the subject email must match, or deny;
- the `companyId` must match, or deny;
- `asOf` must be recent and not in the future, or deny; and
- the session expiry is `min(token.exp, response.expiresAt)`. A callback may
  **shorten** a session. It may never extend one.

The returned `orgRole` is the current one, and it is the only thing this app's
admin plane reads.

### Access claims: departments, roles, and permissions

The workspace's identity layer supports multi-department and custom-role modeling. When an organization installs your service, its admin consents to scopes (including `identity.companyId` and `identity.access`).

When granted, two things happen:

1. **Advisory claims in the token:** The JWT carries `orole` (e.g. `"owner"`), `depts` (array of department slugs, primary first, cap 8), `roles` (custom-role slugs, cap 8), and `perms` (permission keys filtered to `<slug>.*`, cap 16).
2. **Authoritative access in the callback:** Calling `/api/v1/registry/:slug/authorize` returns live `access: { orgRole, deptSlugs, roleSlugs, permissions }`.

In this reference app:

- `orgRole` / `isAdmin` gates the organization-wide admin plane (viewing and deleting any note in the tenant).
- `deptSlugs` are surfaced in the session (`/app/session`) and rendered in the UI status header. New notes created by a user with a department are automatically tagged with their primary department (`note.dept`).
- `roleSlugs` and `permissions` are passed through in `/app/session` so microservices with fine-grained feature toggles or custom roles have an authoritative recipe to branch on them.

---

## Scope is not role, and neither is the other

Three independent checks, none of which substitutes for another:

| Check              | Answers                                         | Source                              |
| ------------------ | ----------------------------------------------- | ----------------------------------- |
| Signature + bounds | is this token ours, unaltered, and still alive? | the embed key                       |
| **Scope**          | what was this token minted **to do**?           | the `scope` claim                   |
| **Role**           | what may this person do **right now**?          | the callback, and only the callback |

Scope must be a non-empty subset of `read` / `write` / `embed`; anything else
means "not our token". A **read-scoped token cannot mutate**, however senior its
holder is, and a successful callback does not launder it into one — the callback
answers _who and what role_, not _ignore the scope_. `embed` scope opens the
full app; it is a licence to act as yourself, not an automatic admin grant.

The admin operation here (removing anyone's note in the organisation) needs
`OWNER` or `ADMIN` **from the callback**. An unrecognised role is never an
admin.

And identity is never request data. Request bodies are `.strict()` Zod schemas,
so a body carrying `companyId`, `email`, `orgRole` or `isAdmin` is a `400` — a
loud "you cannot say who you are" rather than a silent strip.

---

## Offline reads, online sensitive operations

Not every request can afford the same check, and the line between them is the
most consequential decision in this example.

|                | Offline (verify the token)                                       | Online (call authorize first)                                                              |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| What           | reading **your own** rows                                        | writes, **other people's** rows, anything reporting a role                                 |
| Endpoints      | `GET /api/v1/resources`, `GET /app/notes`, `GET /app/notes/{id}` | `POST /app/session`, `POST /app/notes`, `GET /app/org-notes`, `DELETE /app/org-notes/{id}` |
| Role available | none — `isAdmin` is `false` by construction                      | the current one, from the callback                                                         |
| Staleness      | **bounded by the token: ≤300 s**                                 | rechecked per sensitive request; not atomic with the later operation                       |

**A person is not a tenant.** Every resource and own-note read is scoped by
both the verified `companyId` and email: one consultant's token for client A
cannot read that same person's notes for client B. The resource and app routes
share those accessors. The teaching quota is per person per organization, and
idempotency records are bound to tenant, person, HTTP method and path — a key
used for creating a note cannot replay that response for a delete.

**Offline does not mean unauthenticated.** Skipping the callback is not
skipping authentication, and the two are easy to conflate. Every offline
request still carries a signed, unexpired identity token; the proxied resource
surface additionally requires the service key. What is skipped is only the
_freshness_ re-check.

The offline window is a real, stated trade: after a revocation, a person can
keep reading **their own** notes until their token lapses — at most five
minutes from minting, not five fresh minutes after revocation. The verifier
adds no expiry grace (see [Why there is no skew here](#why-there-is-no-skew-here)). Everything that could
harm someone else is shut on the very next request. `security.test.mjs` asserts
both halves, including that a revoked person still reads their own rows and is
refused everything sensitive, and that the own-read window closes to the second.

Two structural details keep the offline path from widening:

- It never produces a role. The offline branch returns `orgRole: "UNVERIFIED"`
  and `isAdmin: false`, so nothing that needs a role can be served from it by
  accident.
- `GET /app/notes/{id}` is **tenant-and-owner-scoped, not org-wide**. An admin reading
  a colleague's note there gets a `404` and has to use the online org plane.

## Why the resource handlers cannot be online-gated

**Certification runs before the service is LIVE and before any organisation has
installed it** — exactly the state the authorize callback refuses (not live, not
installed, still `EXPERIMENTAL`). A resource handler that called authorize would
be _uncertifiable_: the harness could never get a 200, and the service could
never reach the LIVE state that would let it.

The answer is **not** to soften authorize, and it is **not** to build a
probe-only surface either. Certification is explicit that the harness probes the
**real** handlers with identities indistinguishable from real users, precisely
so a service cannot behave honestly for the probe and leak at runtime. So
`/api/v1/resources` reads the **same rows, through the same owner-scoped
accessors**, as everything else. There is no certification code path, and
`server.test.mjs` asserts that the proxied read and the app's own read reach the
same storage.

### What a probe must carry

The harness authenticates like the workspace proxy does, and this surface
requires **both** credentials on every request:

| Header                | Proves                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `X-Workspace-Api-Key` | the **caller** is the platform (or the harness acting as it)           |
| `X-Workspace-Token`   | **who** the request is for — a signed identity JWT, `read` scope, ≤300 s |

Neither alone is enough. A service key is a caller credential and says nothing
about a person; a token from an unknown caller is not something this surface
serves. Missing or invalid either → `401`.

`?email=` is a **routing hint and nothing more**. It can never introduce,
change or widen a signed identity: if it disagrees with the token's `sub` the
request is refused (`403 IDENTITY_MISMATCH`) rather than quietly resolved in
either direction, and a bare `?email=` with no credentials is a `401`.

Note where that bites. The harness's tampered-token probe sends the correct API
key, a **signature-invalid** token, and a hint that **agrees** with that token's
claimed subject. It is aimed squarely at an app that falls back to the hint when
verification fails — without the matching hint, such an app denies for the wrong
reason and looks correct. A broken signature must end the request no matter what
the query string says.

> An earlier draft of this fixture served the hint alone, because the
> certification harness sent nothing else. That was a **defect in the harness,
> not a property of the contract** — the harness now authenticates its probes. A public read
> path on real resources is never the right answer, and nothing about
> certification requires one.

**First use provisions a starter note.** Ordinary behaviour — a new member's
notes are not empty — and deliberately _not_ a canary branch: any verified
subject takes exactly this path and gets exactly these rows, which is what
makes a harness identity indistinguishable from a real user. It also happens to
be what lets the harness run its isolation checks at all: an empty list gives it
no record to probe with, and it treats that as a non-pass rather than letting a
service dodge the negative test by answering `[]`.

> This is a **convenience of this teaching fixture, not a production
> provisioning requirement**. Lazily creating a row on read is fine for a demo
> whose store is a `Map`; it is not a pattern to copy into a service where a
> read has cost, quota or audit consequences. A real service should provision
> at install or first sign-in.

The division of responsibility is worth being precise about: **the harness
guarantees it will not certify an empty tenant; it does not guarantee to create
one for you.** An authenticated list that comes back empty is reported as a
named non-pass — "insufficient evidence: the authenticated list was empty, so
isolation cannot be proved" — never a green. So a service that provisions
nothing fails visibly rather than slipping through, and provisioning _somehow_,
at some point before certification, is the service's job.

A synthetic tenant (`demo`, `demo-acme`, `probe-…`, `test-…`) is refused by
`isRealTenant` on the `/app/*` real-data plane, before the callback is
consulted.

## Trust tiers: two claims, not one

**Two different things can be demonstrated, and they are not the same claim:**

1. **Synthetic framing smoke.** An `EXPERIMENTAL` service may be framed inside
   its owner org once it is LIVE, review has passed, and that install has
   consented to embed. The identity handed to it is synthetic. This proves the
   _handshake_ works end to end. It proves nothing about RBAC.
2. **A trusted real-RBAC experiment.** Real-data authorize **rejects
   `EXPERIMENTAL`**. Trialling this app against real organisation roles requires
   promotion to **`PARTNER`** trust, plus:
   - `identity.companyId` **and** `identity.access` granted at install (both are
     in this example's manifest — without either, the callback returns no usable
     role and the admin plane simply never opens); and
   - access claims switched on for the workspace, or there is no access data
     to resolve in the first place.

Also worth knowing: the workspace re-reads the install epoch
(`max(updatedAt, revokedAt)`) on every check, and a token issued at or before
that epoch is treated as revoked — including a fail-closed window of up to one
second on a freshly installed or re-consented app. A transient `403` right after
an install is that window, not a bug. **Do not tight-retry it**, and do not
tight-retry an expired bearer either; see below.

---

## Expiry fails closed, and the retry is bounded

There is no refresh endpoint, because the workspace does not have one. The host
mints a new token **every time the frame announces `xray:embed:ready`**, so
re-announcing _is_ the renewal. The page:

- re-announces ~20 seconds before expiry, so a live session never blinks;
- on a `401 TOKEN_EXPIRED`, drops the token and re-announces; and
- **stops** — after three attempts, or immediately if the host hands back a
  token the server has already refused — and shows visible guidance:
  _"Your workspace session for this app has ended. Re-open Team notes from the
  workspace to continue."_

That second brake matters. The host answers every announcement, so a host that
re-sends the same expired token would otherwise produce a tight loop against
your own backend. `browser.test.mjs` asserts the loop does not happen by
counting requests — which is how the bug was found in the first place.

---

## The page itself

Served by this process, so `frame-ancestors` on `/embed` names the workspace
origin and nothing else:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors https://workspace.xray.tech
```

No `'unsafe-inline'`, no `'unsafe-eval'`, no CDN — the script and stylesheet are
files this app serves. `X-Frame-Options` is deliberately **not** set: it has no
allow-list, so it would override `frame-ancestors` with `DENY`. The
certification harness checks exactly this header.

The UI is plain and semantic on purpose — `<main>`, headings, a labelled
`<input>`, real `<button>`s, a `role="status"` line and a `role="alert"` for
failures, remove buttons whose accessible name says which note. Note titles are
rendered with `textContent`, never `innerHTML`.

---

## Endpoints

| Method   | Path                              | Auth                                                        | Notes                                                                               |
| -------- | --------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/health`, `/api/v1/ready` | public                                                      |                                                                                     |
| `GET`    | `/api/v1/manifest`                | public                                                      | the registered-service manifest                                                     |
| `GET`    | `/api/v1/resources`, `/…/{id}`    | service key **and** signed token                            | the real, owner-scoped handlers; also what certification probes. Read-only, offline |
| `GET`    | `/api/v1/search?q=&limit=`        | service key **and** signed token                            | ⌘K search over your own notes; the same rows as the resources                       |
| `POST`   | `/api/v1/subject/merge`           | service key **and** signed token of scope `merge`           | folds one person's notes into the survivor's, inside the token's tenant; idempotent |
| `GET`    | `/api/v1/pages`, `/…/{id}`        | service key                                                 | carries no user data — a service credential is not a person                         |
| `GET`    | `/embed`, `/embed/*`              | public                                                      | the framed page and its own assets                                                  |
| `POST`   | `/app/session`                    | bearer + **callback**                                       | who am I, what role, when does this end                                             |
| `GET`    | `/app/notes`, `/app/notes/{id}`   | bearer (offline)                                            | your own rows only                                                                  |
| `POST`   | `/app/notes`                      | bearer + write/embed scope + **callback**                   | `Idempotency-Key` required                                                          |
| `GET`    | `/app/org-notes`                  | bearer + **callback** + `OWNER`/`ADMIN`                     | everyone's notes in your organisation                                               |
| `DELETE` | `/app/org-notes/{id}`             | bearer + write/embed scope + **callback** + `OWNER`/`ADMIN` | the admin-only organisation operation                                               |

Cross-tenant reads and writes return **404, not 403** — a foreign id is
indistinguishable from one that never existed, so existence does not leak.
Every client-visible error is one of a fixed set of codes and a sentence written
by us: no exception message, no stack, no path, no upstream detail. Bodies are
capped at 8 KB, methods are bounded, and mutations require an `Idempotency-Key`.

---

## Tests

```bash
# unit + integration (real loopback HTTP server, stubbed online boundary),
# plus contract parity with the workspace
npm run test:embedded

# the handshake in a real browser (Playwright)
npx playwright install chromium   # once
npm run test:browser
```

The test files are named individually on purpose: a `*.test.mjs` glob would
sweep the browser test into the fast unit run. `test-support.mjs` is shared
scaffolding, not a test file.

`server.test.mjs` and `security.test.mjs` are fast (~250 ms, no sleeping): the
clock is injected and the workspace is a stub function. They cover the handshake
rules, the identity-token matrix (tamper, `none`, wrong audience, wrong issuer, expiry,
future-dating, TTL ceiling, missing claims), the callback's failure modes
(timeout, network, redirect, every error status, malformed and oversized
bodies), the reconciliation rules, member-vs-admin, read-scope-on-write,
cross-tenant isolation, revocation and demotion, forged identity in a body, and
the offline/online split with its bounded staleness.

Timing gets its own two blocks, because both defects there were found by review
rather than by a failing test: exact-expiry and TTL boundaries (300 valid, 301
and 330 refused, `exp` itself already dead, no grace at `exp + 30`), fractional
and reversed timestamps, a future `iat`, reconciliation against the time the
callback's answer _arrived_, and a slow request body that cannot outlive its
authorization. All of it runs on an injected clock — no sleeping, and each test
was confirmed to fail against the old behaviour before the fix was kept.

They also mirror the certification harness's own checks, so a failure here is a
certification failure you can see before you submit:

| Harness check            | Covered by                                                              |
| ------------------------ | ----------------------------------------------------------------------- |
| `credentials`            | _service-side precondition only_ — see the note below                   |
| `health`                 | "health, ready and manifest answer 200 … and never redirect"            |
| `resource_list`          | "the resource handlers are owner-scoped and never leak existence"       |
| `peer_resource_list`     | same test, identity B                                                   |
| `cross_tenant_record`    | same test, step 3 — B's row requested as A                              |
| `cross_tenant_list`      | same test, step 4 — B's id absent from A's list                         |
| `unauthenticated_denied` | "the resource surface needs BOTH the service key and a signed token"    |
| `tampered_token_denied`  | "a tampered token is refused even when a matching hint would rescue it" |
| `hint_not_authoritative` | "a hint that disagrees with the signature is refused, not resolved"     |
| `embed_frame_ancestors`  | "serves a CSP that names the workspace in frame-ancestors"              |

The `credentials` row is the one asymmetry, and it is worth understanding
before you go debugging the wrong machine. That check is entirely about the
**workspace's** copy of your credentials — absent, or no longer decryptable —
so it fails on the platform side and there is nothing on your deployment to
change. This example's own startup validation (`config.mjs` refuses to boot
without a service key and an embed key) is a service-side _precondition_ for
that check, not a test of it: the harness never observes whether you refuse to
boot. Both are worth having; they are not the same thing.

`contract.test.mjs` is the parity check against the workspace itself. It
reads [`contract/workspace-v1.json`](../../contract/workspace-v1.json): tokens
minted by the workspace's real minter (with and without grant narrowing, for
an experimental app, for another app), its real embed message names and theme
vocabulary, and the theme messages its real stylesheet produces. It also
validates this app's manifest against
[`contract/manifest.schema.json`](../../contract/manifest.schema.json), the
workspace's registration schema. Those files are generated from the
workspace's code, not written by hand, so a contract change on its side shows
up here as a failing test.

`browser.test.mjs` starts the app and a stand-in host on two loopback ports and
drives real Chromium. It exercises what only a browser can: a genuine
cross-origin `postMessage`, a real iframe, real CSP, origin and source
rejection, member vs admin in the actual UI, and the bounded expiry path. If
Chromium is not installed it fails with `npx playwright install chromium`
rather than skipping quietly.

No test touches a real workspace, a database, or the network.
