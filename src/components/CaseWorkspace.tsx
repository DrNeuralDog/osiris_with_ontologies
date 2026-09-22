"use client";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useCases } from "./CaseProvider";
import { useWorldReplay } from "./WorldReplayProvider";
import { useLocale } from "@/lib/i18n";
import {
  caseRequest,
  caseVisibleAt,
  caseMapSnapshot,
  type CaseRecord,
  type CaseTab,
  type CaseItem,
  type CaseNote,
  type ResultPage,
  type ItemSnapshot,
} from "@/lib/cases";
import type { OntologyGraph } from "@/lib/ontology";
import EvidenceView from "./EvidenceView";
import AddToCaseButton from "./AddToCaseButton";
const CaseMap = dynamic(() => import("./CaseMap"), { ssr: false });
const EntityGraphPanel = dynamic(() => import("./EntityGraphPanel"), {
  ssr: false,
});
const tabs: CaseTab[] = [
  "OVERVIEW",
  "MAP",
  "GRAPH",
  "TIMELINE",
  "EVIDENCE",
  "NOTES",
];
const btn =
  "rounded border border-[var(--gold-primary)]/40 px-2 py-1.5 text-xs disabled:opacity-40 hover:bg-amber-300/10";
const input = "bg-slate-900 border border-slate-700 rounded p-2 text-xs";
interface TimelinePage extends ResultPage<ItemSnapshot> {
  lifecycle: {
    id: string;
    correlation_id: string;
    status: string;
    changed_at: string;
    correlation_type: string;
  }[];
}
export default function CaseWorkspace({
  initialTab,
  onClose,
}: {
  initialTab: CaseTab;
  onClose: () => void;
}) {
  const context = useCases()!,
    replay = useWorldReplay(),
    { t } = useLocale(),
    active = context.active;
  const [tab, setTab] = useState(initialTab),
    [list, setList] = useState<CaseRecord[]>([]),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("OPEN"),
    [tag, setTag] = useState(""),
    [listCursor, setListCursor] = useState<string | null>(null);
  const [title, setTitle] = useState(active?.title || ""),
    [description, setDescription] = useState(active?.description || ""),
    [tags, setTags] = useState(active?.tags.join(", ") || ""),
    [aoi, setAoi] = useState(active?.aoi?.join(",") || ""),
    [from, setFrom] = useState(active?.time_range?.from.slice(0, 16) || ""),
    [to, setTo] = useState(active?.time_range?.to.slice(0, 16) || "");
  const [items, setItems] = useState<CaseItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<ItemSnapshot | null>(null),
    [domain, setDomain] = useState("");
  const [notes, setNotes] = useState<CaseNote[]>([]),
    [body, setBody] = useState(""),
    [noteId, setNoteId] = useState(""),
    [noteItem, setNoteItem] = useState("");
  const [events, setEvents] = useState<TimelinePage | null>(null),
    [graph, setGraph] = useState<OntologyGraph | null>(null),
    [expand, setExpand] = useState(false),
    [activity, setActivity] = useState<
      {
        id: string;
        action: string;
        created_at: string;
      }[]
    >([]);
  const [setCounts, setSetCounts] = useState<
    {
      id: string;
      count: number;
      truncated: boolean;
    }[]
  >([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  const loadList = useCallback(
    async (after?: string, signal?: AbortSignal) => {
      const p = new URLSearchParams({ q: search, status, tag, limit: "30" });
      if (after) p.set("cursor", after);
      const result = await caseRequest<ResultPage<CaseRecord>>(
        `cases?${p}`,
        undefined,
        "GET",
        signal,
      );
      setList((old) => (after ? [...old, ...result.items] : result.items));
      setListCursor(result.next_cursor);
    },
    [search, status, tag],
  );
  useEffect(() => {
    const c = new AbortController();
    const timer = setTimeout(
      () =>
        void loadList(undefined, c.signal).catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        }),
      250,
    );
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [loadList, version]);
  useEffect(() => {
    if (!active) return;
    const c = new AbortController();
    void caseRequest<ResultPage<CaseItem>>(
      `cases/${active.id}/items?limit=100`,
      undefined,
      "GET",
      c.signal,
    )
      .then((p) => {
        setItems(p.items);
        setCursor(p.next_cursor);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [active, version]);
  useEffect(() => {
    if (!active) return;
    const c = new AbortController();
    if (tab === "NOTES")
      void caseRequest<{
        items: CaseNote[];
      }>(`cases/${active.id}/notes`, undefined, "GET", c.signal)
        .then((p) => setNotes(p.items))
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        });
    if (tab === "OVERVIEW")
      void caseRequest<{
        items: typeof setCounts;
      }>(`cases/${active.id}/set-counts`, undefined, "GET", c.signal)
        .then((p) => setSetCounts(p.items))
        .catch(() => {});
    if (tab === "OVERVIEW" || tab === "TIMELINE")
      void caseRequest<{
        items: typeof activity;
      }>(`cases/${active.id}/activity?limit=30`, undefined, "GET", c.signal)
        .then((p) => setActivity(p.items))
        .catch(() => {});
    return () => c.abort();
  }, [active, tab, version]);
  const loadTimeline = async (after?: string) => {
    if (!active) return;
    const p = new URLSearchParams({ limit: "100" });
    if (from) p.set("from", new Date(from + "Z").toISOString());
    if (to) p.set("to", new Date(to + "Z").toISOString());
    if (after) p.set("cursor", after);
    const r = await caseRequest<TimelinePage>(
      `cases/${active.id}/timeline?${p}`,
    );
    setEvents((old) =>
      after && old ? { ...r, items: [...old.items, ...r.items] } : r,
    );
  };
  useEffect(() => {
    if (tab !== "TIMELINE" || !active) return;
    const c = new AbortController();
    const p = new URLSearchParams({ limit: "100" });
    if (active.time_range) {
      p.set("from", active.time_range.from);
      p.set("to", active.time_range.to);
    }
    void caseRequest<TimelinePage>(
      `cases/${active.id}/timeline?${p}`,
      undefined,
      "GET",
      c.signal,
    )
      .then(setEvents)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [tab, active, version]);
  async function save() {
    if (!active) return;
    await caseRequest(
      `cases/${active.id}`,
      {
        title,
        description,
        tags: tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        aoi: aoi ? aoi.split(",").map(Number) : null,
        time_range:
          from && to
            ? {
                from: new Date(from + "Z").toISOString(),
                to: new Date(to + "Z").toISOString(),
              }
            : null,
      },
      "PATCH",
    );
    await context.refresh();
    refresh();
  }
  function jump(s: ItemSnapshot) {
    if (!s.at) return;
    replay.jump(Date.parse(s.at));
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon))
      window.dispatchEvent(
        new CustomEvent("osiris:case-focus", {
          detail: {
            lat: s.lat,
            lng: s.lon,
            label: s.name,
            objectId: s.object_id,
          },
        }),
      );
    onClose();
  }
  function investigate(s: ItemSnapshot) {
    const id = s.object_id || s.related_object_ids?.[0];
    if (id)
      window.dispatchEvent(
        new CustomEvent("osiris:case-object", { detail: id }),
      );
  }
  async function download(format: "json" | "geojson") {
    if (!active) return;
    const data = await caseRequest(
      `cases/${active.id}/export?format=${format}`,
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], {
        type:
          format === "geojson" ? "application/geo+json" : "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `case-${active.id}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const visible = items.filter(
    (i) =>
      (!domain ||
        i.snapshot_at_add.type === domain ||
        i.snapshot_at_add.event_type === domain) &&
      caseVisibleAt(
        i,
        replay.state.mode === "replay" ? replay.state.at : null,
      ) &&
      (!from ||
        i.kind === "object" ||
        !i.snapshot_at_add.at ||
        Date.parse(i.snapshot_at_add.at) >= Date.parse(from + "Z")) &&
      (!to ||
        i.kind === "object" ||
        !i.snapshot_at_add.at ||
        Date.parse(i.snapshot_at_add.at) <= Date.parse(to + "Z")),
  );
  return (
    <section
      role="dialog"
      aria-label={t("Cases")}
      className="fixed inset-2 md:inset-6 z-[1150] flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] border border-amber-400/50 rounded-lg font-mono shadow-2xl overflow-hidden"
    >
      <header className="flex gap-2 p-3 border-b border-slate-700 items-center">
        <h2 className="mr-auto text-amber-300">
          {t("CASES")} {active && `/ ${active.title}`}
        </h2>
        <button className={btn} onClick={context.explore}>
          {t("OBJECT SETS")}
        </button>
        <button className={btn} onClick={onClose}>
          {t("Back to map")}
        </button>
      </header>
      {error && (
        <p role="alert" className="p-2 text-red-300 text-xs">
          {error}
        </p>
      )}
      {busy && <p role="status">{t("Loading…")}</p>}
      <div className="flex flex-1 min-h-0">
        <aside className="w-48 md:w-60 shrink-0 border-r border-slate-700 overflow-auto p-3 space-y-2">
          <input
            aria-label={t("Search")}
            placeholder={t("Search")}
            className={`${input} w-full`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <input
            aria-label={t("Tags")}
            placeholder={t("Tags")}
            className={`${input} w-full`}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
          <select
            aria-label={t("Status")}
            className={`${input} w-full`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {["OPEN", "ARCHIVED", "all"].map((s) => (
              <option key={s} value={s}>
                {t(s)}
              </option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                const c = await caseRequest<CaseRecord>("cases", {
                  title: f.get("title"),
                });
                await context.activate(c.id);
                refresh();
              });
            }}
            className="space-y-2"
          >
            <input
              name="title"
              required
              maxLength={200}
              aria-label={t("Create new case")}
              placeholder={t("Title")}
              className={`${input} w-full`}
            />
            <button className={btn} disabled={busy}>
              {t("Create case")}
            </button>
          </form>
          {list.map((c) => (
            <button
              key={c.id}
              className={`w-full text-left p-2 border text-xs ${active?.id === c.id ? "border-amber-300" : "border-slate-700"}`}
              onClick={() => void run(() => context.activate(c.id))}
            >
              {c.title}
              <small className="block text-slate-400">{t(c.status)}</small>
            </button>
          ))}
          {listCursor && (
            <button
              className={btn}
              onClick={() => void run(() => loadList(listCursor))}
            >
              {t("Load more")}
            </button>
          )}
        </aside>
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {active ? (
            <>
              <nav className="flex flex-wrap gap-1 p-2 border-b border-slate-700">
                {tabs.map((v) => (
                  <button
                    key={v}
                    aria-pressed={tab === v}
                    onClick={() => setTab(v)}
                    className={`${btn} ${tab === v ? "text-amber-300" : ""}`}
                  >
                    {t(v)}
                  </button>
                ))}
              </nav>
              <div className="flex-1 min-h-0 overflow-auto p-3 text-xs space-y-3">
                {tab === "OVERVIEW" && (
                  <>
                    <div className="flex flex-wrap gap-3">
                      {Object.entries(active.counts || {}).map(([k, n]) => (
                        <span key={k}>
                          {t(
                            (
                              {
                                objects: "Objects",
                                items: "Items",
                                observations: "Observations",
                                correlations: "Correlations",
                                analyses: "Analyses",
                                notes: "Notes",
                                saved_sets: "Saved sets",
                              } as Record<string, string>
                            )[k] || k,
                          )}
                          : <strong>{n}</strong>
                        </span>
                      ))}
                    </div>
                    <label className="block">
                      {t("Title")}
                      <input
                        className={`${input} block w-full`}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </label>
                    <label className="block">
                      {t("Description")}
                      <textarea
                        className={`${input} block w-full`}
                        rows={3}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </label>
                    <label>
                      {t("Tags")}{" "}
                      <input
                        className={input}
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                      />
                    </label>
                    <label className="block">
                      AOI (W,S,E,N){" "}
                      <input
                        aria-label="Case AOI"
                        className={`${input} w-72`}
                        value={aoi}
                        onChange={(e) => setAoi(e.target.value)}
                      />
                    </label>
                    <div className="flex gap-2 flex-wrap">
                      <label>
                        {t("From")} UTC{" "}
                        <input
                          className={input}
                          type="datetime-local"
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                        />
                      </label>
                      <label>
                        {t("To")} UTC{" "}
                        <input
                          className={input}
                          type="datetime-local"
                          value={to}
                          onChange={(e) => setTo(e.target.value)}
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        disabled={busy}
                        className={btn}
                        onClick={() => void run(save)}
                      >
                        {t("Save")}
                      </button>
                      <button
                        className={btn}
                        onClick={() =>
                          void run(async () => {
                            await caseRequest(
                              `cases/${active.id}`,
                              {
                                status:
                                  active.status === "OPEN"
                                    ? "ARCHIVED"
                                    : "OPEN",
                              },
                              "PATCH",
                            );
                            await context.refresh();
                            refresh();
                          })
                        }
                      >
                        {t(active.status === "OPEN" ? "Archive" : "Reopen")}
                      </button>
                      <button
                        className={btn}
                        onClick={() => void run(() => download("json"))}
                      >
                        {t("JSON export")}
                      </button>
                      <button
                        className={btn}
                        onClick={() => void run(() => download("geojson"))}
                      >
                        {t("GeoJSON export")}
                      </button>
                    </div>
                    <h3>{t("Saved sets")}</h3>
                    {active.sets?.map((s) => (
                      <div key={s.id}>
                        {s.title} · {t(s.mode)} · {t("Current matches")}:{" "}
                        {setCounts.find((c) => c.id === s.id)?.count ?? "—"}
                        {setCounts.find((c) => c.id === s.id)?.truncated
                          ? "+"
                          : ""}{" "}
                        <button
                          className={btn}
                          onClick={() =>
                            void run(async () => {
                              await caseRequest(
                                `cases/${active.id}/sets/${s.id}`,
                                undefined,
                                "DELETE",
                              );
                              await context.refresh();
                            })
                          }
                        >
                          {t("Detach")}
                        </button>
                      </div>
                    ))}
                    <p>{t("Dynamic matches are not pinned evidence.")}</p>
                    <h3>{t("Activity log")}</h3>
                    {activity.map((a) => (
                      <p key={a.id}>
                        {new Date(a.created_at).toLocaleString()} ·{" "}
                        {t(a.action)}
                      </p>
                    ))}
                  </>
                )}
                {["MAP", "EVIDENCE"].includes(tab) && (
                  <>
                    <label>
                      {t("Type")}{" "}
                      <select
                        className={input}
                        value={domain}
                        onChange={(e) => setDomain(e.target.value)}
                      >
                        <option value="">{t("All")}</option>
                        {[
                          ...new Set(items.map((i) => i.snapshot_at_add.type)),
                        ].map((d) => (
                          <option key={d} value={d}>
                            {t(d)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {replay.state.mode === "replay" && (
                      <p className="text-cyan-300">
                        {t("REPLAY")} {new Date(replay.state.at).toISOString()}{" "}
                        ·{" "}
                        {t(
                          "Static objects remain available; saved positions are snapshots, not positions at replay time.",
                        )}
                      </p>
                    )}
                    {tab === "MAP" && (
                      <div className="flex flex-wrap gap-2">
                        <label>
                          {t("From")} UTC{" "}
                          <input
                            type="datetime-local"
                            className={input}
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                          />
                        </label>
                        <label>
                          {t("To")} UTC{" "}
                          <input
                            type="datetime-local"
                            className={input}
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                          />
                        </label>
                      </div>
                    )}
                    {tab === "MAP" && (
                      <CaseMap
                        items={visible.map((i) =>
                          caseMapSnapshot(
                            i,
                            replay.state.mode === "replay"
                              ? replay.state.at
                              : null,
                            replay.items,
                          ),
                        )}
                        temporal={replay.state.mode === "replay"}
                        onSelect={setSelected}
                      />
                    )}
                    <div className="space-y-2">
                      {visible.map((i) => (
                        <details
                          key={i.id}
                          className="border border-slate-700 p-2"
                          open={selected?.id === i.ref_id}
                        >
                          <summary className="cursor-pointer">
                            {i.snapshot_at_add.name} ·{" "}
                            {t(i.snapshot_at_add.type)} ·{" "}
                            {t(i.pinned ? "Pinned" : "Unpin")}
                          </summary>
                          <p>
                            {t("Snapshot at add")}:{" "}
                            {new Date(i.added_at).toLocaleString()}
                          </p>
                          <div className="flex flex-wrap gap-2 my-2">
                            <button
                              className={btn}
                              onClick={() => investigate(i.snapshot_at_add)}
                            >
                              {t("Open graph")}
                            </button>
                            {i.snapshot_at_add.at && (
                              <button
                                className={btn}
                                onClick={() => jump(i.snapshot_at_add)}
                              >
                                {t("Open in World Replay")}
                              </button>
                            )}
                            <button
                              className={btn}
                              onClick={() =>
                                void run(async () => {
                                  await caseRequest(
                                    `cases/${active.id}/items/${i.id}`,
                                    { pinned: !i.pinned },
                                    "PATCH",
                                  );
                                  refresh();
                                  await context.refresh();
                                })
                              }
                            >
                              {t(i.pinned ? "Unpin" : "Pin")}
                            </button>
                            <button
                              className={btn}
                              onClick={() =>
                                void run(async () => {
                                  await caseRequest(
                                    `cases/${active.id}/items/${i.id}`,
                                    undefined,
                                    "DELETE",
                                  );
                                  refresh();
                                  await context.refresh();
                                })
                              }
                            >
                              {t("Remove from case")}
                            </button>
                          </div>
                          <p>
                            {t(i.snapshot_at_add.evidence_state)} ·{" "}
                            {i.snapshot_at_add.at}
                          </p>
                          <EvidenceView
                            items={i.snapshot_at_add.provenance || []}
                          />
                          <details>
                            <summary>{t("Snapshot at add")}</summary>
                            <pre className="whitespace-pre-wrap break-words text-[10px]">
                              {JSON.stringify(i.snapshot_at_add, null, 2)}
                            </pre>
                          </details>
                        </details>
                      ))}
                    </div>
                    {cursor && (
                      <button
                        className={btn}
                        onClick={() =>
                          void run(async () => {
                            const p = await caseRequest<ResultPage<CaseItem>>(
                              `cases/${active.id}/items?limit=100&cursor=${encodeURIComponent(cursor)}`,
                            );
                            setItems((old) => [...old, ...p.items]);
                            setCursor(p.next_cursor);
                          })
                        }
                      >
                        {t("Load more")}
                      </button>
                    )}
                  </>
                )}
                {tab === "GRAPH" && (
                  <>
                    <p>
                      {t("Current ontology relationships")} ·{" "}
                      {t("Analyst action, not factual evidence")}
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={expand}
                        onChange={(e) => setExpand(e.target.checked)}
                      />{" "}
                      {t("Include one-hop related objects")}
                    </label>
                    <button
                      className={btn}
                      onClick={() =>
                        void run(async () =>
                          setGraph(
                            await caseRequest<OntologyGraph>(
                              `cases/${active.id}/graph?expand=${expand}`,
                            ),
                          ),
                        )
                      }
                    >
                      {t("Open graph")}
                    </button>
                    {graph && (
                      <EntityGraphPanel
                        initialGraph={graph}
                        onClose={() => setGraph(null)}
                      />
                    )}
                  </>
                )}
                {tab === "TIMELINE" && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <label>
                        {t("From")} UTC{" "}
                        <input
                          className={input}
                          type="datetime-local"
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                        />
                      </label>
                      <label>
                        {t("To")} UTC{" "}
                        <input
                          className={input}
                          type="datetime-local"
                          value={to}
                          onChange={(e) => setTo(e.target.value)}
                        />
                      </label>
                      <button
                        className={btn}
                        onClick={() => void run(() => loadTimeline())}
                      >
                        {t("Apply")}
                      </button>
                    </div>
                    <details>
                      <summary>
                        {t("Activity log")} ·{" "}
                        {t("Analyst action, not factual evidence")}
                      </summary>
                      {activity.map((a) => (
                        <p key={a.id}>
                          {new Date(a.created_at).toLocaleString()} ·{" "}
                          {t(a.action)}
                        </p>
                      ))}
                    </details>
                    {!events?.items.length && (
                      <p>{t("No retained observations yet")}</p>
                    )}
                    {events?.items.map((e) => (
                      <div
                        key={String(e.event_key || e.id)}
                        className="border-l border-cyan-300 pl-3 py-2"
                      >
                        <p>
                          {e.at} · {e.name} · {e.event_type}
                        </p>
                        <button className={btn} onClick={() => jump(e)}>
                          {t("Open in World Replay")}
                        </button>{" "}
                        <AddToCaseButton
                          reference={{ kind: e.kind, id: e.id, at: e.at }}
                        />
                        <EvidenceView items={e.provenance || []} />
                      </div>
                    ))}
                    {events?.next_cursor && (
                      <button
                        className={btn}
                        onClick={() =>
                          void run(() => loadTimeline(events.next_cursor!))
                        }
                      >
                        {t("Load more")}
                      </button>
                    )}
                    {events?.lifecycle.map((e) => (
                      <p key={e.id}>
                        {e.changed_at} · {e.correlation_type} · {t(e.status)}{" "}
                        <button
                          className={btn}
                          onClick={() => {
                            replay.jump(Date.parse(e.changed_at));
                            onClose();
                          }}
                        >
                          {t("Open in World Replay")}
                        </button>
                      </p>
                    ))}
                  </>
                )}
                {tab === "NOTES" && (
                  <>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          await caseRequest(
                            `cases/${active.id}/notes${noteId ? "/" + noteId : ""}`,
                            {
                              body,
                              ...(!noteId && noteItem
                                ? { item_id: noteItem }
                                : {}),
                            },
                            noteId ? "PATCH" : "POST",
                          );
                          setBody("");
                          setNoteId("");
                          refresh();
                          await context.refresh();
                        });
                      }}
                      className="space-y-2"
                    >
                      <label className="block">
                        {t("Write a note")}
                        <textarea
                          required
                          maxLength={10000}
                          rows={5}
                          className={`${input} w-full block`}
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                        />
                      </label>
                      <select
                        className={input}
                        value={noteItem}
                        onChange={(e) => setNoteItem(e.target.value)}
                      >
                        <option value="">{t("Case")}</option>
                        {items.map((i) => (
                          <option value={i.id} key={i.id}>
                            {i.snapshot_at_add.name}
                          </option>
                        ))}
                      </select>{" "}
                      <button disabled={busy} className={btn}>
                        {t("Save note")}
                      </button>
                    </form>
                    {notes.map((n) => (
                      <article
                        key={n.id}
                        className="border border-slate-700 p-3"
                      >
                        <p className="text-slate-400">
                          {new Date(n.updated_at).toLocaleString()} ·{" "}
                          {t("Analyst action, not factual evidence")}
                        </p>
                        <p className="whitespace-pre-wrap break-words my-2">
                          {n.body}
                        </p>
                        <button
                          className={btn}
                          onClick={() => {
                            setNoteId(n.id);
                            setBody(n.body);
                            setNoteItem(n.item_id || "");
                          }}
                        >
                          {t("Edit")}
                        </button>
                      </article>
                    ))}
                  </>
                )}
              </div>
            </>
          ) : (
            <p className="p-5">{t("Create new case")}</p>
          )}
        </main>
      </div>
    </section>
  );
}
