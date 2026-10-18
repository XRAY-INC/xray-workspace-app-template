/**
 * The workspace-side block renderer (reference implementation).
 *
 * This is the ONLY code that knows how a to-do looks — and it lives in the
 * workspace, not the service. It maps each block in a `PageDocument` to a
 * first-party React component styled with the shell's own tokens. Swap the
 * service and the same renderer draws any other product:
 * that is the whole point of server-driven UI.
 *
 * Real integration note: the Workspace ships its own renderer, built from its
 * own UI primitives. This one is self-contained so the sample reads
 * top-to-bottom, and so you can preview your documents the way the shell
 * will draw them.
 */

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  CheckCircle2,
  Circle,
  Clock,
  Flag,
  Folder,
  Inbox,
  ListTodo,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { AccentToken, Block, IconToken, PageDocument, ToneToken } from "../blocks";

/* --------------------------------------------------------------- tokens */

/** The shell owns every real colour; blocks only pick a semantic slot. */
const ACCENT: Record<AccentToken, string> = {
  slate: "#64748b",
  violet: "#7c6cf0",
  teal: "#12a594",
  amber: "#d9930a",
  rose: "#e5484d",
};

const TONE: Record<ToneToken, { fg: string; bg: string; label: string }> = {
  neutral: { fg: "#475569", bg: "#e2e8f0", label: "neutral" },
  good: { fg: "#0a7d5f", bg: "#d1fae0", label: "good" },
  warning: { fg: "#8a5a00", bg: "#fdeecb", label: "warning" },
  critical: { fg: "#a51e22", bg: "#fbdcdd", label: "critical" },
  info: { fg: "#2b5cc4", bg: "#dbe7ff", label: "info" },
};

const ICON: Record<IconToken, typeof Circle> = {
  "check-circle": CheckCircle2,
  circle: Circle,
  clock: Clock,
  flag: Flag,
  inbox: Inbox,
  "list-todo": ListTodo,
  "bar-chart": BarChart3,
  folder: Folder,
};

export interface RendererProps {
  page: PageDocument;
  /** Fires an ActionRef; the host POSTs to /api/v1/actions/{id} and refreshes. */
  onAction: (actionId: string, input: Record<string, string>) => void;
}

/* -------------------------------------------------------------- leaves */

function Badge({ text, tone }: { text: string; tone: ToneToken }) {
  const t = TONE[tone];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color: t.fg, backgroundColor: t.bg }}
    >
      {text}
    </span>
  );
}

function Button({
  action,
  input,
  onAction,
}: {
  action: import("../blocks").ActionRef;
  input: Record<string, string>;
  onAction: RendererProps["onAction"];
}) {
  const base =
    "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1";
  const style =
    action.style === "primary"
      ? "text-white"
      : action.style === "danger"
        ? "text-white"
        : "border border-[var(--line)] text-[var(--ink)] hover:bg-[var(--surface-2)]";
  const bg =
    action.style === "primary"
      ? ACCENT.violet
      : action.style === "danger"
        ? ACCENT.rose
        : undefined;
  return (
    <button
      type="button"
      className={`${base} ${style}`}
      style={bg ? { backgroundColor: bg } : undefined}
      onClick={() => {
        if (action.confirm && !window.confirm(action.confirm)) return;
        onAction(
          action.id,
          action.input ? Object.fromEntries(action.input.map((k) => [k, input[k] ?? ""])) : {},
        );
      }}
    >
      {action.label}
    </button>
  );
}

function Trend({ dir }: { dir?: "up" | "down" | "flat" }) {
  if (dir === "up") return <TrendingUp size={16} color={TONE.good.fg} aria-label="up" />;
  if (dir === "down") return <TrendingDown size={16} color={TONE.critical.fg} aria-label="down" />;
  return null;
}

/* --------------------------------------------------------------- charts */

function BarViz({ block }: { block: Extract<Block, { type: "chart" }> }) {
  return (
    <div style={{ width: "100%", height: 200 }}>
      <ResponsiveContainer>
        <BarChart data={block.points} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            fontSize={12}
            stroke="var(--ink-muted)"
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            fontSize={12}
            stroke="var(--ink-muted)"
            width={28}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--line)" }}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={ACCENT[block.accent]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const DONUT_TONES: ToneToken[] = ["critical", "warning", "neutral", "info", "good"];

function DonutViz({ block }: { block: Extract<Block, { type: "chart" }> }) {
  const total = block.points.reduce((s, p) => s + p.value, 0);
  return (
    <div className="flex items-center gap-6">
      <div style={{ width: 160, height: 160 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={block.points}
              dataKey="value"
              nameKey="label"
              innerRadius={48}
              outerRadius={72}
              paddingAngle={2}
              stroke="var(--surface)"
            >
              {block.points.map((p, i) => (
                <Cell key={p.label} fill={TONE[p.tone ?? DONUT_TONES[i % DONUT_TONES.length]].fg} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--line)" }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5">
        {block.points.map((p, i) => (
          <li key={p.label} className="flex items-center gap-2 text-sm">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: TONE[p.tone ?? DONUT_TONES[i % DONUT_TONES.length]].fg }}
            />
            <span className="text-[var(--ink)]">{p.label}</span>
            <span className="tabular-nums text-[var(--ink-muted)]">
              {p.value}
              {total ? ` · ${Math.round((p.value / total) * 100)}%` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------- block switch */

function BlockView({ block, onAction }: { block: Block; onAction: RendererProps["onAction"] }) {
  const [formState, setFormState] = useState<Record<string, string>>({});

  switch (block.type) {
    case "heading": {
      const Tag = block.level === 3 ? "h3" : "h2";
      return (
        <Tag
          className={
            block.level === 3
              ? "text-base font-semibold text-[var(--ink)]"
              : "text-xl font-semibold text-[var(--ink)]"
          }
        >
          {block.text}
        </Tag>
      );
    }
    case "text":
      return (
        <p
          className={`text-sm leading-relaxed ${block.emphasis === "muted" ? "text-[var(--ink-muted)]" : "text-[var(--ink)]"}`}
          dangerouslySetInnerHTML={{ __html: renderMd(block.md) }}
        />
      );
    case "divider":
      return <hr className="border-[var(--line)]" />;
    case "badge":
      return <Badge text={block.text} tone={block.tone} />;
    case "stat":
      return <StatCard {...block} />;
    case "statGroup":
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {block.stats.map((s, i) => (
            <StatCard key={i} type="stat" {...s} />
          ))}
        </div>
      );
    case "card": {
      const Icon = block.icon ? ICON[block.icon] : null;
      return (
        <div
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
          style={{ borderLeft: `3px solid ${ACCENT[block.accent]}` }}
        >
          <div className="flex items-center gap-2">
            {Icon ? <Icon size={16} color={ACCENT[block.accent]} /> : null}
            <span className="font-medium text-[var(--ink)]">{block.title}</span>
          </div>
          {block.body ? <p className="mt-1 text-sm text-[var(--ink-muted)]">{block.body}</p> : null}
          {block.actions?.length ? (
            <div className="mt-3 flex gap-2">
              {block.actions.map((a) => (
                <Button key={a.id} action={a} input={{}} onAction={onAction} />
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    case "list":
      if (block.items.length === 0) {
        return (
          <p className="rounded-lg border border-dashed border-[var(--line)] px-4 py-6 text-center text-sm text-[var(--ink-muted)]">
            {block.empty ?? "Nothing here."}
          </p>
        );
      }
      return (
        <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]">
          {block.items.map((item, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--ink)]">
                    {item.title}
                  </span>
                  {item.badge ? <Badge text={item.badge.text} tone={item.badge.tone} /> : null}
                </div>
                {item.body ? (
                  <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{item.body}</p>
                ) : null}
              </div>
              {item.actions?.length ? (
                <div className="flex shrink-0 gap-2">
                  {item.actions.map((a) => (
                    <Button key={a.id} action={a} input={{}} onAction={onAction} />
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[var(--surface-2)]">
                {block.columns.map((c) => (
                  <th
                    key={c.key}
                    className={`px-4 py-2 font-medium text-[var(--ink-muted)] ${c.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-[var(--line)]">
                  {block.columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-2 text-[var(--ink)] ${c.align === "right" ? "text-right tabular-nums" : "text-left"}`}
                    >
                      {String(row[c.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "chart":
      return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          {block.title ? (
            <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">
              {block.title}
              {block.unit ? (
                <span className="ml-1 font-normal text-[var(--ink-muted)]">({block.unit})</span>
              ) : null}
            </h3>
          ) : null}
          {block.chartType === "donut" ? <DonutViz block={block} /> : <BarViz block={block} />}
        </div>
      );
    case "form":
      return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            {block.fields.map((f) => (
              <div key={f.id} className="flex flex-1 flex-col gap-1">
                <label htmlFor={f.id} className="text-xs font-medium text-[var(--ink-muted)]">
                  {f.label}
                </label>
                {f.kind === "select" ? (
                  <select
                    id={f.id}
                    className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--ink)]"
                    value={formState[f.id] ?? f.options[0]?.value ?? ""}
                    onChange={(e) => setFormState((s) => ({ ...s, [f.id]: e.target.value }))}
                  >
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.kind === "checkbox" ? (
                  <input
                    id={f.id}
                    type="checkbox"
                    checked={formState[f.id] === "true"}
                    onChange={(e) =>
                      setFormState((s) => ({ ...s, [f.id]: String(e.target.checked) }))
                    }
                  />
                ) : (
                  <input
                    id={f.id}
                    type="text"
                    placeholder={f.placeholder}
                    className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--ink)]"
                    value={formState[f.id] ?? ""}
                    onChange={(e) => setFormState((s) => ({ ...s, [f.id]: e.target.value }))}
                  />
                )}
              </div>
            ))}
            <Button
              action={block.submit}
              input={formState}
              onAction={(id, input) => {
                onAction(id, input);
                setFormState({});
              }}
            />
          </div>
        </div>
      );
    case "actions":
      return (
        <div className="flex gap-2">
          {block.buttons.map((a) => (
            <Button key={a.id} action={a} input={{}} onAction={onAction} />
          ))}
        </div>
      );
    case "tabs":
      return <TabsView block={block} onAction={onAction} />;
    default:
      // Forward-compatibility: unknown block types are skipped and logged.
      return null;
  }
}

function StatCard(props: Extract<Block, { type: "stat" }>) {
  const Icon = props.icon ? ICON[props.icon] : null;
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
        {Icon ? <Icon size={14} /> : null}
        {props.label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={`tabular-nums ${props.emphasis === "strong" ? "text-3xl" : "text-2xl"} font-semibold text-[var(--ink)]`}
        >
          {props.value}
        </span>
        <Trend dir={props.trend} />
      </div>
    </div>
  );
}

function TabsView({
  block,
  onAction,
}: {
  block: Extract<Block, { type: "tabs" }>;
  onAction: RendererProps["onAction"];
}) {
  const [active, setActive] = useState(block.tabs[0]?.id);
  const current = useMemo(
    () => block.tabs.find((t) => t.id === active) ?? block.tabs[0],
    [block.tabs, active],
  );
  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-[var(--line)]">
        {block.tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === current?.id}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${t.id === current?.id ? "border-[var(--accent)] text-[var(--ink)]" : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
            onClick={() => setActive(t.id)}
          >
            {t.title}
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-4">
        {current?.blocks.map((b, i) => (
          <BlockView key={i} block={b} onAction={onAction} />
        ))}
      </div>
    </div>
  );
}

/** Tiny constrained-markdown → HTML (bold/italic/links only, no raw HTML). */
function renderMd(md: string): string {
  const escape = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  return escape(md)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

/* ---------------------------------------------------------------- page */

export function BlockRenderer({ page, onAction }: RendererProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* In the shell the title is the top bar's and the subtitle the first
          line under it (the workspace's page header); standalone,
          this reference draws both. */}
      <header>
        <h1 className="text-2xl font-bold text-[var(--ink)]">{page.title}</h1>
        {page.subtitle ? <p className="text-sm text-[var(--ink-muted)]">{page.subtitle}</p> : null}
      </header>
      {page.blocks.map((b, i) => (
        <BlockView key={i} block={b} onAction={onAction} />
      ))}
    </div>
  );
}
