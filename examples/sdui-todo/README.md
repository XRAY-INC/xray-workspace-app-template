# sdui-todo: a server-driven UI reference

A tiny, runnable demonstration of the workspace's **server-driven UI (SDUI)**
model: your service ships **no frontend**, and the workspace renders its UI
from structured block JSON.

The product here is a to-do list. It exercises every block type (headings,
paragraphs, stats, tabs, a bar chart, a donut chart, a table, an add-task form,
badges, and buttons with confirmations), so you can see exactly how rich an
interface the contract can express without your service owning any React, CSS
or HTML.

```bash
npm run start:sdui            # http://localhost:4801
```

The sibling app, [`embedded-team-app`](../embedded-team-app), is the other
shape: the workspace frames a page you serve yourself. Read that one for
identity across a frame boundary. Read this one for server-driven UI.

## The mental model

```
        SERVICE (headless, ships no UI)                 WORKSPACE (owns rendering)
   ┌───────────────────────────────────┐          ┌──────────────────────────────┐
   │ todo-service.ts                    │          │ the workspace's renderer     │
   │  listPages()   → PageRef[]         │  JSON    │  one view per block          │
   │  getPage(id)   → PageDocument ─────┼─────────►│  drawn with shell tokens     │
   │  runAction(id) → ActionResult      │◄─────────┼─ button click → POST action  │
   └───────────────────────────────────┘  action  └──────────────────────────────┘
             │ data from
             ▼
   your own API, or the seed fallback
```

The service returns **UI as data**. The renderer is the only thing that knows
what a to-do _looks_ like, and it lives in the workspace. Point the renderer at
a different service and it draws that product instead. That is the whole idea.

## Files

| File                         | Role                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `server.mjs`                 | The runnable service: every required endpoint, pages, one form action, search, subject merge, tenant isolation |
| `blocks.ts`                  | The block vocabulary as a Zod schema + TS types: validate your own output against it             |
| `types.ts`                   | The service's private domain model (`Todo`)                                                      |
| `todo-repository.ts`         | Data layer: an upstream-API adapter **and** a seed fallback behind one interface                 |
| `todo-service.ts`            | The headless service: produces `PageDocument`s and handles actions                               |
| `todo-contract.test.ts`      | Holds the tenancy rule and parity with the workspace mechanically                                |
| `renderer/BlockRenderer.tsx` | A self-contained renderer (React, recharts, lucide) that draws documents the way the shell does  |
| `SduiTodoApp.tsx`            | A demo harness standing in for the shell (sub-nav, fetch, action round trip)                     |

`server.mjs` has zero dependencies and is what you register. The `.ts` files
are the same service written as typed modules, for reading and copying.

## Block vocabulary

`v1 = content + actions` is the decided core. Blocks marked **proposed** are
governed extensions this sample uses to show charts, tabs and stat groups;
they ship only after block-vocabulary review.

| Core (v1)                                                              | Proposed (governed extension)                |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| `heading` `text` `stat` `list` `table` `card` `media` `form` `actions` | `divider` `statGroup` `badge` `tabs` `chart` |

Styling is **tokens only**: a block picks a semantic `accent` / `tone` / `icon`
/ `emphasis` from a fixed allowlist, and the shell owns every real style rule.
So dark mode, accessibility and re-brands apply automatically, and no
third-party CSS ever enters the workspace origin.

A page document's `title` is the page's name, and the workspace shows it in its
top bar. `subtitle` is one plain line on what the page is for, shown right
under the bar.

## The tenancy rule

Every repository method takes `email` **first**, because it is the tenant key,
not a label. The workspace has already proved that identity: it arrives in the
verified identity token (`server.mjs` `resolveIdentity`), never from a
`?email=` hint, which is refused outright when it contradicts the token.

Reads scope by construction: `fetchTasks({ email })` can only return the
caller's rows. **Writes cannot.** `updateTask(id, …)` is addressed by id, so
the id has to be proved to belong to the caller _before_ the write: read the
record, check ownership, write, and answer **404** on a miss, never 403. A 403
would confirm the id exists to whoever guessed it.

`todo-contract.test.ts` holds that line, including the case that matters most:
when the ownership check fails, no write is attempted at all.

## Parity with the workspace

A sample that is more permissive than the workspace teaches you to emit
documents the workspace will refuse. So `todo-contract.test.ts` checks
`blocks.ts` against the workspace's real verdicts, recorded in
[`contract/workspace-v1.json`](../../contract/workspace-v1.json):

- **Deep links.** `DeepLink` accepts and refuses exactly what the workspace's
  `deepLinkSchema` does: workspace-relative paths yes; protocol-relative,
  backslash, control-character and scheme tricks no.
- **Markdown.** `SafeMarkdown` refuses raw HTML and caps length at the
  workspace's ceiling. It deliberately does **not** reproduce the workspace's
  link scanner (see the note in `blocks.ts`), and a test pins that gap so it
  stays a decision rather than a surprise: an unsafe link passes here and is
  still refused by the workspace.

Run it with `npm run test:sdui`.

## Data source

`resolveRepository()` tries an upstream client and falls back to seed data,
reporting which one served (`RepositoryResult.source`), so the demo shows
sample data with an honest notice instead of failing. Pass your own API client
(anything shaped like `TasksClientLike`) to serve real rows.

## How it becomes real

1. Your service serves `GET /api/v1/pages`, `GET /api/v1/pages/{id}` and
   `POST /api/v1/actions/{id}` returning this exact JSON (`server.mjs` does).
2. You declare `"capabilities": { "pages": true }` in your manifest.
3. The workspace renders your pages with its own renderer, including the
   loading, empty, error, accessibility and theming states, so your service
   never has to.
