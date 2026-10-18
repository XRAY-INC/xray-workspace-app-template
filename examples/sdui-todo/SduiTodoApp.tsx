/**
 * Demo harness — stands in for the workspace shell.
 *
 * In production this role is played by the real shell: the sidebar reads
 * `GET /api/v1/pages` for the sub-nav, the route reads `GET /api/v1/pages/{id}`,
 * and a button click POSTs `POST /api/v1/actions/{id}` (through the BFF proxy,
 * with an Idempotency-Key) then refreshes the page document. Here we call the
 * service functions in-process so the sample runs with no server, but the data
 * flow is identical: service returns JSON → renderer draws it.
 */

import { useCallback, useEffect, useState } from "react";
import type { PageDocument } from "./blocks";
import { BlockRenderer } from "./renderer/BlockRenderer";
import { contextFrom, getPage, listPages, runAction, ServiceError } from "./todo-service";
import { resolveRepository, seedRepository, type RepositoryResult } from "./todo-repository";

const DEMO_EMAIL = "demo@example.com";

export function SduiTodoApp() {
  const pages = listPages();
  const [repo, setRepo] = useState<RepositoryResult | null>(null);
  const [activePage, setActivePage] = useState(pages[0]?.id ?? "today");
  const [doc, setDoc] = useState<PageDocument | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Resolve the data source once (live tasks API → seed fallback).
  useEffect(() => {
    // The demo has no server-side Tasks client available in the browser, so it
    // uses the seed repo directly; swap `null` for a client to exercise live.
    resolveRepository(null, DEMO_EMAIL)
      .then(setRepo)
      .catch(() => setRepo({ repo: seedRepository(), source: "seed" }));
  }, []);

  const refresh = useCallback(async () => {
    if (!repo) return;
    const next = await getPage(activePage, contextFrom(DEMO_EMAIL, repo));
    setDoc(next);
  }, [repo, activePage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAction = useCallback(
    async (actionId: string, input: Record<string, string>) => {
      if (!repo) return;
      try {
        const result = await runAction(actionId, input, contextFrom(DEMO_EMAIL, repo));
        if (result.toast) {
          setToast(result.toast);
          window.setTimeout(() => setToast(null), 2000);
        }
        if (result.refresh) await refresh();
      } catch (err) {
        setToast(err instanceof ServiceError ? err.message : "Something went wrong.");
        window.setTimeout(() => setToast(null), 3000);
      }
    },
    [repo, refresh],
  );

  return (
    <div className="mx-auto flex max-w-4xl gap-6 p-6">
      {/* Sub-nav — driven by GET /api/v1/pages */}
      <nav className="w-40 shrink-0">
        <ul className="flex flex-col gap-1">
          {pages.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium ${p.id === activePage ? "bg-[var(--surface-2)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--surface-2)]"}`}
                onClick={() => setActivePage(p.id)}
              >
                {p.title}
              </button>
            </li>
          ))}
        </ul>
        {repo ? (
          <p className="mt-4 px-3 text-xs text-[var(--ink-muted)]">
            Source: {repo.source === "tasks-api" ? "Tasks API (live)" : "seed"}
          </p>
        ) : null}
      </nav>

      <main className="min-w-0 flex-1">
        {doc ? (
          <BlockRenderer page={doc} onAction={onAction} />
        ) : (
          <p className="text-sm text-[var(--ink-muted)]">Loading…</p>
        )}
      </main>

      {toast ? (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-[var(--ink)] px-4 py-2 text-sm text-[var(--surface)] shadow-lg"
          role="status"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
