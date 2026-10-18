/**
 * Server-driven UI — the block vocabulary (reference implementation).
 *
 * This is the JSON contract a headless service returns from `/api/v1/pages/{id}`.
 * The workspace renders it natively; the service ships no UI of its own.
 *
 * Mirrors the Workspace's block contract (`PageDocument`). Blocks marked
 * `[proposed]` are governed extensions beyond the decided
 * `v1 = content + actions` core — they exist here so the sample can demonstrate
 * charts, tabs, and stat groups, and would ship only after block-vocabulary
 * review, versioned like any event/fact type.
 *
 * Design rule: styling is TOKENS ONLY. A block never carries a hex
 * colour or CSS — it picks a semantic `accent`, `tone`, `icon`, or `emphasis`
 * from a fixed allowlist and the shell owns every actual style rule.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ tokens */

/** Curated accent palette (the shell maps these to real colours). */
export const AccentToken = z.enum(["slate", "violet", "teal", "amber", "rose"]);
export type AccentToken = z.infer<typeof AccentToken>;

/** Semantic status, separate from accent — always paired with an icon/label. */
export const ToneToken = z.enum(["neutral", "good", "warning", "critical", "info"]);
export type ToneToken = z.infer<typeof ToneToken>;

/** `lucide` icon allowlist (the `OrgNavLink` precedent, already shipped). */
export const IconToken = z.enum([
  "check-circle",
  "circle",
  "clock",
  "flag",
  "inbox",
  "list-todo",
  "bar-chart",
  "folder",
]);
export type IconToken = z.infer<typeof IconToken>;

export const Emphasis = z.enum(["default", "strong", "muted"]);
export type Emphasis = z.infer<typeof Emphasis>;

/* -------------------------------------------------------- safe primitives */

/**
 * A workspace-relative path, and nothing else. `"/settings"` yes;
 * `"//evil.example"`, `"/\evil.example"` and `"javascript:…"` no — the first
 * two are protocol-relative URLs that most routers and browsers will follow
 * off-origin, which turns any block a service controls into an open redirect.
 *
 * This is the SAME rule the workspace enforces on every document it renders
 * (its `deepLinkSchema`; `todo-contract.test.ts` checks the two agree). It is duplicated
 * here on purpose: this file is the contract a service validates its OWN output
 * against, and a service that ships a link the workspace will reject should
 * find out in its own tests, not in production. Keep the two in step.
 */
/**
 * Markdown a service returns for a `text` block.
 *
 * The field used to be a bare `z.string()` under a comment reading
 * "Constrained markdown — bold/italic/links only, never raw HTML". The comment
 * was not the constraint; this is. Same trap `deepLink` carried.
 *
 * ── WHAT THIS DOES NOT DO, deliberately
 *
 * The workspace's own scanner (`checkSafeMarkdown`) additionally normalizes every link, image, autolink and
 * reference-definition target — angle-bracket unwrap, entity decode, percent
 * decode, control-character strip — and holds them to a positive scheme
 * allowlist, so `javascript:` cannot masquerade as a relative path however it
 * is dressed up. That is 139 lines of security code and it is NOT reproduced
 * here.
 *
 * Copying a HALF of it would be worse than copying none: a service would
 * believe it had link safety it does not have. So this schema screens raw HTML
 * — cheap, self-contained, and exactly what the comment claimed — and stops
 * there. The workspace still runs the full scanner on every document it
 * renders, so an unsafe LINK is refused at the boundary either way; your
 * service simply will not find out until then. `todo-contract.test.ts` pins
 * this gap so it stays deliberate rather than becoming a surprise.
 */
const RAW_HTML = /<\s*[a-zA-Z/!]/;

/** Matches the workspace's own ceiling (`MAX_MARKDOWN_CHARS`). */
export const MAX_MARKDOWN_CHARS = 8_000;

export const SafeMarkdown = z
  .string()
  .max(MAX_MARKDOWN_CHARS)
  .refine((v) => !RAW_HTML.test(v), { message: "markdown must not contain raw HTML" });
export type SafeMarkdown = z.infer<typeof SafeMarkdown>;

/**
 * The URL parser REMOVES tab/LF/CR wherever they appear and strips leading and
 * trailing controls, so `"/\t/evil.example"` is `"//evil.example"` once a
 * browser reads it. Refuse every control and whitespace character outright
 * (as the workspace's own in-app path check does).
 */
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CONTROL_OR_WHITESPACE = /[\u0000-\u001F\u007F-\u009F\s]/;
const PROBE_ORIGIN = "https://in-app-path.invalid";

function isWorkspaceRelativePath(v: string): boolean {
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return false;
  if (CONTROL_OR_WHITESPACE.test(v)) return false;
  try {
    return new URL(v, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

export const DeepLink = z.string().max(2048).refine(isWorkspaceRelativePath, {
  message:
    "deepLink must be a workspace-relative path (start with / but not // or /\\, no whitespace or control characters)",
});
export type DeepLink = z.infer<typeof DeepLink>;

/* ----------------------------------------------------------------- actions */

/**
 * A reference to a service action. The shell renders the control; clicking it
 * POSTs to `/api/v1/actions/{id}` through the BFF proxy with an
 * Idempotency-Key. `input` names form fields whose values ride along.
 */
export const ActionRef = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(80),
  style: z.enum(["primary", "secondary", "danger"]).default("secondary"),
  /** Shell renders a confirm dialog with this copy before firing. */
  confirm: z.string().max(200).optional(),
  /** Field ids (from a sibling `form` block) to send with the action. */
  input: z.array(z.string()).optional(),
});
export type ActionRef = z.infer<typeof ActionRef>;

/* ------------------------------------------------------------ form fields */

export const Field = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    id: z.string(),
    label: z.string(),
    placeholder: z.string().optional(),
    required: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("select"),
    id: z.string(),
    label: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
  }),
  z.object({
    kind: z.literal("checkbox"),
    id: z.string(),
    label: z.string(),
  }),
]);
export type Field = z.infer<typeof Field>;

/* ------------------------------------------------------------------ charts */

/** [proposed] Chart block — a governed extension. */
export const ChartBlock = z.object({
  type: z.literal("chart"),
  chartType: z.enum(["bar", "line", "donut"]),
  title: z.string().optional(),
  unit: z.string().optional(),
  /** One series for bar/line; donut treats each point as a slice. */
  points: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      /** Donut slices may carry a semantic tone; bar/line use one accent. */
      tone: ToneToken.optional(),
    }),
  ),
  accent: AccentToken.default("violet"),
});
export type ChartBlock = z.infer<typeof ChartBlock>;

/* ------------------------------------------------------------------ blocks */

const HeadingBlock = z.object({
  type: z.literal("heading"),
  text: z.string(),
  level: z.union([z.literal(2), z.literal(3)]).default(2),
});

const TextBlock = z.object({
  type: z.literal("text"),
  /** Constrained markdown — never raw HTML. Enforced, not just documented. */
  md: SafeMarkdown,
  emphasis: Emphasis.default("default"),
});

const StatBlock = z.object({
  type: z.literal("stat"),
  label: z.string(),
  value: z.string(),
  trend: z.enum(["up", "down", "flat"]).optional(),
  emphasis: Emphasis.default("default"),
  icon: IconToken.optional(),
});

/** [proposed] A responsive row of stats (layout grouping). */
const StatGroupBlock = z.object({
  type: z.literal("statGroup"),
  stats: z.array(StatBlock.omit({ type: true })),
});

/** [proposed] Inline status pill; carries a tone + optional icon, never colour. */
const BadgeBlock = z.object({
  type: z.literal("badge"),
  text: z.string(),
  tone: ToneToken.default("neutral"),
});

const ListItem = z.object({
  title: z.string(),
  body: z.string().optional(),
  /** Workspace-relative deep link only — enforced, not just documented. */
  deepLink: DeepLink.optional(),
  badge: z.object({ text: z.string(), tone: ToneToken }).optional(),
  actions: z.array(ActionRef).optional(),
});

const ListBlock = z.object({
  type: z.literal("list"),
  items: z.array(ListItem),
  empty: z.string().optional(),
});

const TableBlock = z.object({
  type: z.literal("table"),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      align: z.enum(["left", "right"]).default("left"),
    }),
  ),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
});

const CardBlock = z.object({
  type: z.literal("card"),
  title: z.string(),
  body: z.string().optional(),
  icon: IconToken.optional(),
  accent: AccentToken.default("slate"),
  actions: z.array(ActionRef).optional(),
});

const FormBlock = z.object({
  type: z.literal("form"),
  fields: z.array(Field),
  submit: ActionRef,
});

const ActionsBlock = z.object({
  type: z.literal("actions"),
  buttons: z.array(ActionRef),
});

/** [proposed] Tabs — layout, a governed extension. */
const TabsBlock: z.ZodType<{
  type: "tabs";
  tabs: { id: string; title: string; blocks: Block[] }[];
}> = z.lazy(() =>
  z.object({
    type: z.literal("tabs"),
    tabs: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        blocks: z.array(Block),
      }),
    ),
  }),
);

const DividerBlock = z.object({ type: z.literal("divider") });

export const Block: z.ZodType<Block> = z.lazy(() =>
  z.union([
    HeadingBlock,
    TextBlock,
    StatBlock,
    StatGroupBlock,
    BadgeBlock,
    ListBlock,
    TableBlock,
    CardBlock,
    FormBlock,
    ActionsBlock,
    ChartBlock,
    TabsBlock,
    DividerBlock,
  ]),
);

export type Block =
  | z.infer<typeof HeadingBlock>
  | z.infer<typeof TextBlock>
  | z.infer<typeof StatBlock>
  | z.infer<typeof StatGroupBlock>
  | z.infer<typeof BadgeBlock>
  | z.infer<typeof ListBlock>
  | z.infer<typeof TableBlock>
  | z.infer<typeof CardBlock>
  | z.infer<typeof FormBlock>
  | z.infer<typeof ActionsBlock>
  | ChartBlock
  | { type: "tabs"; tabs: { id: string; title: string; blocks: Block[] }[] }
  | { type: "divider" };

/* --------------------------------------------------------------- documents */

export const PageDocument = z.object({
  blockVersion: z.literal("v1"),
  /** The page's name. The workspace shows it in its top bar. */
  title: z.string(),
  /** One plain line on what the page is for; the workspace shows it right under the bar. */
  subtitle: z.string().optional(),
  blocks: z.array(Block),
  nextCursor: z.string().optional(),
});
export type PageDocument = z.infer<typeof PageDocument>;

export const PageRef = z.object({
  id: z.string(),
  title: z.string(),
  icon: IconToken.optional(),
  order: z.number(),
});
export type PageRef = z.infer<typeof PageRef>;

/** `POST /api/v1/actions/{id}` result. */
export const ActionResult = z.object({
  result: z.literal("ok"),
  /** Optional blocks to splice in (optimistic patch), or a full refresh. */
  patch: z.array(Block).optional(),
  refresh: z.boolean().optional(),
  /** User-safe toast the shell shows after the action. */
  toast: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResult>;
