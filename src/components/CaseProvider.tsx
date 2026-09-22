"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import {
  caseRequest,
  caseReferenceFromSeed,
  type CaseRecord,
  type CaseReference,
  type CaseTab,
  type ResultPage,
} from "@/lib/cases";
import { useLocale } from "@/lib/i18n";
import type { InvestigationSeed } from "@/lib/ontology";
const CaseWorkspace = dynamic(() => import("./CaseWorkspace"), { ssr: false });
const ObjectSetExplorer = dynamic(() => import("./ObjectSetExplorer"), {
  ssr: false,
});
interface Context {
  active: CaseRecord | null;
  refresh: () => Promise<void>;
  activate: (id: string) => Promise<void>;
  close: () => void;
  open: (tab?: CaseTab) => void;
  explore: () => void;
}
const CaseContext = createContext<Context | null>(null);
export function useCases() {
  return useContext(CaseContext);
}
type AddRequest =
  | CaseReference
  | {
      seed: InvestigationSeed;
    }
  | {
      analysis: {
        kind: "cluster" | "acoustic";
        parameters: Record<string, unknown>;
        cluster_id?: string;
      };
    };
export default function CaseProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale(),
    [active, setActive] = useState<CaseRecord | null>(null),
    [opened, setOpened] = useState(false),
    [tab, setTab] = useState<CaseTab>("OVERVIEW"),
    [explorer, setExplorer] = useState(false);
  const [pending, setPending] = useState<AddRequest | null>(null),
    [list, setList] = useState<CaseRecord[]>([]),
    [target, setTarget] = useState(""),
    [title, setTitle] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const activate = useCallback(async (id: string) => {
    const c = await caseRequest<CaseRecord>(`cases/${id}`);
    setActive(c);
    try {
      localStorage.setItem("osiris.case", id);
    } catch {}
  }, []);
  const refresh = useCallback(async () => {
    if (active) await activate(active.id);
  }, [active, activate]);
  useEffect(() => {
    const c = new AbortController();
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("osiris.case");
    } catch {}
    if (saved)
      void caseRequest<CaseRecord>(`cases/${saved}`, undefined, "GET", c.signal)
        .then(setActive)
        .catch(() => {});
    return () => c.abort();
  }, []);
  useEffect(() => {
    const listener = (e: Event) => {
      setError("");
      setPending((e as CustomEvent<AddRequest>).detail);
      setTarget(active?.id || "");
      setTitle("");
      void caseRequest<ResultPage<CaseRecord>>("cases?status=OPEN&limit=100")
        .then((p) => setList(p.items))
        .catch((e) => setError(e.message));
    };
    window.addEventListener("osiris:add-to-case", listener);
    return () => window.removeEventListener("osiris:add-to-case", listener);
  }, [active]);
  async function add() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      const id =
        target || (await caseRequest<CaseRecord>("cases", { title })).id;
      const ref =
        "seed" in pending
          ? await caseReferenceFromSeed(pending.seed)
          : "analysis" in pending
            ? await caseRequest<CaseReference>("analyses", pending.analysis)
            : pending;
      await caseRequest(`cases/${id}/items`, ref);
      await activate(id);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const closeExplorer = () => setExplorer(false);
    window.addEventListener("osiris:case-object", closeExplorer);
    return () =>
      window.removeEventListener("osiris:case-object", closeExplorer);
  }, []);
  const value: Context = {
    active,
    refresh,
    activate,
    close: () => {
      setActive(null);
      try {
        localStorage.removeItem("osiris.case");
      } catch {}
    },
    open: (next = "OVERVIEW") => {
      setTab(next);
      setOpened(true);
    },
    explore: () => setExplorer(true),
  };
  return (
    <CaseContext.Provider value={value}>
      {children}
      {opened && (
        <CaseWorkspace
          key={active?.id || "list"}
          initialTab={tab}
          onClose={() => setOpened(false)}
        />
      )}{" "}
      {explorer && <ObjectSetExplorer onClose={() => setExplorer(false)} />}
      {pending && (
        <section
          role="dialog"
          aria-modal="true"
          aria-label={t("Add to case")}
          className="fixed inset-0 bg-black/60 z-[1600] flex items-center justify-center p-4"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            className="w-full max-w-md p-5 rounded border border-amber-400 bg-slate-950 text-slate-100 space-y-3 font-mono text-sm"
          >
            <h2>{t("Add to case")}</h2>
            <select
              aria-label={t("Case")}
              className="w-full bg-slate-800 p-2"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{t("Create new case")}</option>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            {!target && (
              <input
                aria-label={t("Title")}
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("Title")}
                className="w-full p-2 bg-slate-800"
              />
            )}
            <p className="text-xs text-slate-400">
              {t("Snapshot at add")} ·{" "}
              {t("Analyst action, not factual evidence")}
            </p>
            {error && (
              <p role="alert" className="text-red-300">
                {error}
              </p>
            )}
            <div className="flex gap-4">
              <button
                disabled={busy || (!target && !title.trim())}
                className="border p-2 disabled:opacity-40"
              >
                {t(busy ? "Loading…" : "Add to case")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                {t("Cancel")}
              </button>
            </div>
          </form>
        </section>
      )}
    </CaseContext.Provider>
  );
}
