# The XRAY Workspace app contract (v1)

This page describes what the two apps in this repository implement: the HTTP
contract between [XRAY Workspace](https://workspace.xray.tech/developers) and
an app built for it. It covers what you need to build and certify an app. The
full developer documentation (the normative spec, the OpenAPI document and the
Developer Portal guide) is in the workspace's API-docs hub, for signed-in
members.

Where this page and the code disagree, the code and its tests are right: the
tests run against [known-answer vectors](../contract) generated from the
workspace itself.

---

## The rule everything follows from

**Your code never runs in the workspace's page.** Your app stays deployed on
your own infrastructure and the workspace talks to it over a small, versioned
HTTP contract under `/api/v1/*`. There are two ways it reaches members:

| Shape                                  | What you serve                                         | How it renders                                                           | Reference                                    |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------- |
| **Server-driven UI** (the default)     | `PageDocument` JSON from `GET /api/v1/pages/{id}`      | The workspace draws your blocks with its own components. No iframe.      | [`sdui-todo`](../examples/sdui-todo)               |
| **Full-page embed** (gated)            | A web page on your own origin                          | A sandboxed, cross-origin iframe; identity arrives by `postMessage`.     | [`embedded-team-app`](../examples/embedded-team-app) |

Start with server-driven UI unless you need your own page. It works at every
trust tier, and your content is data, not pixels, so it cannot spoof the
workspace around it.

## Lifecycle and trust

```text
DRAFT → CERTIFIED → IN_REVIEW → LIVE        (SUSPENDED / RETIRED as needed)
        ▲ self-test   ▲ platform review
```

- **Register** your app in the workspace's Developer Portal (`/developer`) as
  an organization admin. You get an API key and an embed key, shown once.
- **Certify** runs automated conformance and cross-tenant isolation checks
  against your live service. A certification stays fresh for 7 days.
- **Submit** for review. A platform admin approves it to `LIVE` and deploys it
  to organizations, and each organization's admin installs it.
- **Trust tier** is separate from going live. New apps start `EXPERIMENTAL`
  and receive a **synthetic identity** scoped to your own organization, so you
  can build and certify without touching customer data. Real, grant-narrowed
  identity arrives at `PARTNER`, after review and a signed DPA.

A `LIVE` app that later fails isolation is suspended automatically.

---

## Endpoints

Every response uses one envelope: `{"data": …}` on success,
`{"error": {"code", "message"}}` on failure.

**None of these may redirect.** The workspace calls you with redirects turned
off and treats any `3xx` as an error, because a redirect can carry credential
headers to a host you did not intend.

### Public

```http
GET /api/v1/health     → 200 {"data":{"status":"ok"}}
GET /api/v1/ready      → 200 once your dependencies are reachable
GET /api/v1/version    → 200 {"data":{"version":"1.0.0"}}
GET /api/v1/manifest   → 200 {"data":{ …your manifest }}
```

### Private: the service key and the identity token, both

| Endpoint                                     | What it is                                                         |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/v1/resources`, `/resources/{id}`   | Your records, scoped to the token's identity. Certification probes these. |
| `GET /api/v1/search?q=&limit=`               | ⌘K search across your records (below).                             |
| `POST /api/v1/subject/merge`                 | Fold one person into another when emails are linked (below).       |
| `GET /api/v1/pages`, `/pages/{id}`           | Server-driven UI: your page list and `PageDocument`s.              |
| `POST /api/v1/actions/{id}`                  | A block's action (a button, a form). Requires `Idempotency-Key`.   |

### Search: every app serves it

Members find things with the workspace's ⌘K search, and it reaches into every
app. Serve search and declare `"capabilities": { "search": true }`; both apps
here ship it on.

```http
GET /api/v1/search?q=<at least 2 chars>&limit=<1-10>
  X-Workspace-Api-Key: <your service key>
  X-Workspace-Token:   <identity token, scope "read">
→ 200 {"data":{"results":[
    {"id":"n1","type":"note","title":"Roadmap for Acme",
     "snippet":"Team note · Sales","deepLink":"/svc/<your-slug>?at=%2Fembed%3Fnote%3Dn1",
     "score":0.9}
  ]}}
→ 400 when q is shorter than 2 characters · 401 without a valid key and token
```

- **Who is asking is the token's answer.** Search only what that identity can
  see in your app. There is no `email` in the URL.
- **Links stay inside your app.** `deepLink` is workspace-relative and starts
  with `/svc/<your-slug>`: your app's page, one of your pages
  (`/svc/<slug>/<pageId>`), or your framed UI at a path
  (`/svc/<slug>?at=<path>`). Anything else is dropped.
- `score` (0 to 1) ranks you against everything else ⌘K finds. At most 10
  results.
- **Certification probes it** once declared: the shape, a refusal without an
  identity, and that one tenant never finds another's records.

### Subject merge: every app joins it

A person can link more than one email to their workspace account, and can
combine two accounts they own. When that happens the workspace asks every app
to fold the absorbed person's data into the survivor's, so nothing bought,
booked or written under the old address is stranded. Serve the endpoint and
declare `"capabilities": { "merge": true }`; both apps here ship it on.

```http
POST /api/v1/subject/merge
  X-Workspace-Api-Key: <your service key>
  X-Workspace-Token:   <identity token, scope "merge", sub = the survivor>
  Content-Type:        application/json

{"requestId":"m_8f2c…",                       // ≤ 64 chars, the idempotency key
 "from":{"emails":["old@example.com"]},       // the absorbed person: primary + linked
 "to":{"email":"pat@example.com",             // the survivor
       "emails":["pat@example.com","old@example.com"]},  // primary + linked, after the merge
 "reason":"linked_email"}                     // or "account_unify" | "support"

→ 200 {"data":{"requestId":"m_8f2c…","status":"done",
               "moved":{"notes":3},
               "conflicts":[{"label":"starter_note","kept":"to","count":1}]}}
→ 200 {"data":{"requestId":"m_8f2c…","status":"nothing_to_merge","moved":{},"conflicts":[]}}
→ 202 {"data":{"requestId":"m_8f2c…","status":"accepted"}}   (long-running; see below)
→ 400 VALIDATION_ERROR · 401 without a valid key and token · 403 wrong scope or survivor
→ 409 MERGE_CONFLICT when the survivor was itself merged into someone else
```

- **The emails ride in the signed request body, never the URL.** The token's
  `sub` is the survivor; a body naming a different `to.email` is refused.
  A `read`, `write` or `embed` token cannot merge, and a `merge` token is not
  a write token anywhere else in your app.
- **Idempotent on `requestId`.** A retry gets the answer the first call got. A
  new request for a pair you already folded answers `done`, never an error.
- **The survivor wins collisions.** Where you allow one of something per
  person (one starter note, one reaction per item, one membership per org),
  keep the `to` row, drop or sum the `from` row, and report it in `conflicts`
  as `{label, kept: "to", count}`. Money never deduplicates: a purchase, a
  ledger entry or a package always moves.
- **A merge moves, it does not erase.** Erasure is the privacy contract's job.
  Keep each request and its answer: there is no unmerge endpoint, so support
  reverses a mistaken merge by hand from your record.
- **Nothing held, `nothing_to_merge`.** Every app is asked, so most answers
  are this one. Create nothing on the way.
- **Stay inside the tenant.** The token's `companyId` is the organization
  asking; another organization's rows are not yours to move.
- **20 seconds.** Answer within it, or return `202` and finish in the
  background; the workspace polls `GET /api/v1/subject/merge/{requestId}`.
  Both apps here answer synchronously.
- **Certification probes it** once declared: the shape and a matching second
  call, that merging A into B leaves C untouched, and a refusal without an
  identity.

---

## The manifest

`GET /api/v1/manifest` describes your app. The workspace validates it at
registration against [`contract/manifest.schema.json`](../contract/manifest.schema.json),
which is generated from the workspace's own schema, so you can validate yours
before you register. Two rules JSON Schema cannot express are also enforced:
`service` must equal the slug you register, and a
`certification.recordPathTemplate` must contain `{id}`.

```json
{
  "service": "yourapp",
  "displayName": "Your App",
  "contractVersion": "v1",
  "tagline": "Shipments, ETAs & delivery proof",
  "description": "What it does, in one sentence.",
  "requiredTier": "free",
  "capabilities": { "pages": true, "events": false, "search": true, "merge": true },
  "requestedGrants": {
    "identity": { "companyId": false, "tier": false, "tools": false, "access": false },
    "facts": [],
    "events": [],
    "embed": false,
    "byokRelayPaths": []
  }
}
```

- **`tagline`** is the line under your app's name on members' home screens: a
  noun phrase of about 30 characters.
- **`icon`** optionally names one icon from the allowlist in the schema. It is
  never an image URL.
- **`requestedGrants`** are requests, not grants. Ask for the minimum: the
  review and each organization's install decide what you actually get.

---

## Identity

The workspace authenticates **itself** and the **person** separately, and you
need both on every private path.

| Header                | Proves                                           | Check                                       |
| --------------------- | ------------------------------------------------ | ------------------------------------------- |
| `X-Workspace-Api-Key` | the **caller** is the workspace                  | constant-time compare with your API key     |
| `X-Workspace-Token`   | **who** the request is for                       | verify the identity token (below)           |

A valid API key is not a user. A valid key with a missing or invalid token
fails closed on anything user- or tenant-scoped.

### The identity token

An HS256 JWT signed with your **embed key**. Verify it server-side;
[`identity-token.mjs`](../examples/embedded-team-app/identity-token.mjs) is a
strict, dependency-free reference you can copy.

1. Refuse every `alg` but `HS256`, `none` above all, before any signature work.
2. Verify the signature with a **constant-time** comparison.
3. `iss` is `workspace.xray.tech`; `aud` is **your** slug.
4. `iat` and `exp` are whole seconds; the lifetime is positive and at most
   **300 seconds**; `iat` is not in the future; the token is dead once
   `now >= exp`. Keep your clock synchronized rather than adding grace.
5. `sub` (the person's email), `jti`, `scope` and `companyId` are mandatory.
   `scope` is a non-empty subset of `read`, `write`, `embed`, and a
   read-scoped token never mutates.
6. **Trust `sub` from the token, never a `?email=` query parameter.** A query
   email is a routing hint at most, and one that disagrees with the token is
   refused, not resolved.

Some claims are **advisory**: `orole`, `depts`, `roles` and `perms` were true
when the token was minted, up to 300 seconds ago. `perms` arrive narrowed to
your own `<slug>.*` keys. The `pa` claim (XRAY staff) is never an authorization
input for an organization's data.

### Current authorization (the callback)

The token is a photograph. Before anything sensitive (a write, other people's
rows, anything that reports a role), ask the workspace what is true **now**:

```http
POST {workspaceOrigin}/api/v1/registry/{slug}/authorize
X-Workspace-Api-Key: <your service key>
{ "token": "<the identity token>" }
→ 200 {"data":{"active":true,"subject":{…},"access":{"orgRole":"ADMIN",…},
              "expiresAt":"…","asOf":"…"}}
```

Fail closed on everything else: timeouts, network errors, redirects, any
non-200, oversized or malformed bodies. Never cache an "allowed". Reconcile the
answer against the token (same email, same organization, a recent `asOf`), and
end the session at the earlier of the token's `exp` and the callback's
`expiresAt`. [`authorize.mjs`](../examples/embedded-team-app/authorize.mjs) does
all of this.

The callback refuses `EXPERIMENTAL` apps and apps that are not live and
installed. That is why resource handlers verify the token offline: certification
runs before you are live.

---

## Full-page embed

The gated shape: the workspace frames a page on your own origin.

### The handshake

1. Your page posts `{"type":"xray:embed:ready"}` to `window.parent`, targeted at
   the workspace origin.
2. The workspace mints a short-lived identity token and posts
   `{"type":"xray:embed:token","token":"…"}` back.
3. Accept a message only when `event.origin` is exactly the workspace origin
   **and** `event.source` is `window.parent`. Either check alone is
   bypassable.
4. Keep the token in memory. Never in the URL, storage, cookies or logs. Send it
   only to your own backend, as `Authorization: Bearer`.
5. There is no refresh endpoint: announcing `ready` again **is** the renewal.
   Re-announce shortly before expiry, and stop after a bounded number of
   attempts.

Serve the page with a CSP whose `frame-ancestors` names the workspace origin
and nothing else, and do **not** set `X-Frame-Options` (it would override
`frame-ancestors` with `DENY`). Certification checks this header.

### Theme handoff (v1)

Inside a frame, `prefers-color-scheme` follows the operating system, not the
workspace. So the workspace hands you its theme twice:

- **For the first paint**, `?theme=light|dark` on your frame URL. Render it into
  your markup server-side (for example `<html data-theme="dark">`). Anything
  other than exactly `light` or `dark` means you were not framed by the
  workspace.
- **By message**, after each `ready` (before the token) and whenever the
  member's theme changes:

```json
{
  "type": "xray:embed:theme",
  "version": 1,
  "mode": "light",
  "tokens": { "background": "hsl(40 100% 97%)", "foreground": "hsl(213 53% 12%)", "…": "…" },
  "radius": "0.75rem",
  "fonts": { "body": "Urbanist", "heading": "Figtree" }
}
```

`tokens` holds up to 19 named colours, each `hsl(H S% L%)`; a colour the
workspace could not read is omitted, never sent malformed. Everything in this
message ends up in your CSS, so check the sender exactly as for the token, then
check every colour, the radius and the fonts against strict patterns, and
refuse the **whole** message on any failure. Apply colours as custom
properties through the CSSOM, never as CSS text. The exact vocabulary and
patterns are in [`contract/workspace-v1.json`](../contract/workspace-v1.json),
with real messages for both modes.

---

## Certification

What the harness checks, and where the reference apps' tests cover it:

| Check                    | What it proves                                                        |
| ------------------------ | --------------------------------------------------------------------- |
| `credentials`            | the workspace holds usable credentials for you (platform side)        |
| `health`                 | health, ready and manifest answer 200 and never redirect              |
| `resource_list`          | an authenticated list for identity A                                  |
| `peer_resource_list`     | the same for identity B                                               |
| `cross_tenant_record`    | B's record requested as A is not found                                |
| `cross_tenant_list`      | B's record is absent from A's list                                    |
| `unauthenticated_denied` | no key or no token is a 401                                           |
| `tampered_token_denied`  | a bad signature is refused, even with a matching email hint           |
| `hint_not_authoritative` | a hint that disagrees with the token is refused                       |
| `embed_frame_ancestors`  | the embed page's CSP names the workspace in `frame-ancestors`         |

The harness probes your **real** handlers with identities indistinguishable
from real users. Don't build a probe-only code path: a service that behaves for
the probe and leaks at runtime is exactly what certification exists to catch.
An authenticated list that comes back empty cannot prove isolation, so it is a
non-pass, not a green: provision real records before you certify.

---

## Look like the workspace

- **Title and description.** The workspace shows your page's title in its top
  bar and a one-line description under it: your manifest's `displayName` and
  `tagline` for a framed page, a `PageDocument`'s `title` and `subtitle` for
  server-driven UI. Don't draw a visible title of your own; keep an `sr-only`
  `<h1>` for screen readers.
- **Gutters.** Start your content directly under the workspace's header, with
  no top padding, and use its gutters: 16px on a phone, 24px from 640px, 32px
  from 768px.
- **Motion.** Every reveal in the workspace is one line rising from the bottom
  edge, and closing sinks it back down. `embedded-team-app/public/app.css`
  carries the keyframes; use them unchanged.
- **Copy.** Write the tagline and subtitle as one plain line on what the page is
  for, under about 90 characters.
