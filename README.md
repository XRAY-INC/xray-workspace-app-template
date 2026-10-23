# XRAY Workspace app template

[![CI](https://github.com/XRAY-INC/xray-workspace-app-template/actions/workflows/ci.yml/badge.svg)](https://github.com/XRAY-INC/xray-workspace-app-template/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Two small, runnable apps that show how to build for
[XRAY Workspace](https://workspace.xray.tech/developers), and how to get the
hard parts right: identity across a frame boundary, tenant isolation that
survives a certification harness, and authorization that stops the moment
someone is revoked.

Copy the boundaries. Replace the storage.

| App                                                   | Shape                                                                         | Start here if…                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| [`examples/sdui-todo`](./examples/sdui-todo)               | **Server-driven UI.** You return block JSON; the workspace renders it.        | you want the default, fastest path          |
| [`examples/embedded-team-app`](./examples/embedded-team-app) | **Full-page embed.** The workspace frames a page on your own origin.          | you need your own UI inside the workspace   |

Both serve the whole contract: health, manifest, owner-scoped resources, ⌘K
search, subject merge (folding one person into another when their emails are
linked), and the checks the workspace's certification harness runs. Neither
needs a framework or a build step: plain Node.js, `node:test`, and Zod.

## Quick start

Requires Node.js 20.9 or later (22 recommended).

```bash
git clone https://github.com/XRAY-INC/xray-workspace-app-template.git
cd xray-workspace-app-template
npm install
npm test
```

Or click **Use this template** above to start your own repository from it.

Run the server-driven UI app (no configuration needed):

```bash
npm run start:sdui          # http://localhost:4801
```

Run the embedded app (it needs the keys the workspace issues when you register
an app; see [its README](./examples/embedded-team-app/README.md)):

```bash
cp examples/embedded-team-app/.env.example examples/embedded-team-app/.env
npm run start:embedded
```

## What it teaches

Most templates stop at "verify the JWT". These go further, and every rule is
held by a test:

- **Two credentials, two questions.** The service key says the caller is the
  workspace; the identity token says who the request is for. Neither stands in
  for the other, and a `?email=` in the URL is never an identity.
- **A strict token verifier with no clock grace.** HS256 only, constant-time,
  whole-second timestamps, a hard 300-second lifetime. The
  [README](./examples/embedded-team-app/README.md#why-there-is-no-skew-here)
  shows how ±30s of "harmless" skew turned a five-minute token into six.
- **Offline reads, online writes.** Reading your own rows needs only the token.
  Anything that touches someone else, or reports a role, asks the workspace
  what is true _now_, and fails closed on every error.
- **IDOR-proof writes.** A write addressed by id proves ownership first, and a
  record you can't see is a 404, never a 403.
- **A `postMessage` handshake that checks origin _and_ source**, keeps the token
  in memory only, and renews without a refresh loop, proved in a real browser.
- **No probe-only code paths.** Certification probes the real handlers with
  identities indistinguishable from real users, so the app that passes is the
  app that runs.

## Tests

```bash
npm test                          # unit, security and contract tests (~1s)
npx playwright install chromium   # once, for the browser test
npm run test:browser              # the embed handshake in real Chromium
npm run typecheck                 # the TypeScript reference modules
```

No test touches a real workspace, a database, or the network.

### Contract parity

[`contract/`](./contract) holds known-answer vectors generated from the
workspace's own code: tokens its real minter produced, its embed messages and
theme vocabulary, the verdicts of its deep-link and markdown checks, and its
manifest registration schema as JSON Schema. The contract tests run both apps
against them, so if the workspace's contract moves, this repository's CI says
so. You can validate your own manifest against
[`contract/manifest.schema.json`](./contract/manifest.schema.json) in any
language.

## From template to live app

1. Build your app from one of these, keeping its tests.
2. Deploy it to an HTTPS origin you control.
3. In XRAY Workspace, open the **Developer Portal** (`/developer`) as an
   organization admin, register your app, and generate its keys.
4. **Certify**: the portal runs the conformance and isolation checks against
   your live service.
5. **Submit** for review. Once approved, your app goes live and can be
   installed by organizations.

[`docs/contract.md`](./docs/contract.md) describes the contract these apps
implement: endpoints, manifest, identity, the embed handshake, theme handoff
and certification.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).
To report a security problem, see [SECURITY.md](./SECURITY.md) instead of
opening a public issue.

## License

[MIT](./LICENSE) © XRAY Tech, Inc.
