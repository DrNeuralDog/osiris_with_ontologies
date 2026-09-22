"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  caseRequest,
  type ObjectSet,
  type SetQuery,
  type SetFilter,
  type ItemSnapshot,
  type ResultPage,
} from "@/lib/cases";
import { useLocale } from "@/lib/i18n";
import { useCases } from "./CaseProvider";
import AddToCaseButton from "./AddToCaseButton";
import EvidenceView from "./EvidenceView";
const CaseMap = dynamic(() => import("./CaseMap"), { ssr: false });
const btn =
    "border border-amber-400/40 rounded px-2 py-1.5 text-xs disabled:opacity-40",
  input = "bg-slate-900 border border-slate-700 p-2 rounded text-xs";
const fields = [
  "type",
  "subtype",
  "name",
  "provider",
  "evidence_state",
  "freshness",
  "object_id",
  "status",
  "correlation_type",
  "properties.military",
  "properties.magnitude",
  "properties.frp",
  "properties.country",
  "properties.category",
  "properties.source_class",
  "properties.location_precision",
];
const fieldLabels: Record<string, string> = {
  type: "Type",
  subtype: "Subtype",
  name: "Name",
  provider: "Provider",
  evidence_state: "Evidence state",
  freshness: "Freshness",
  object_id: "Object ID",
  status: "Status",
  correlation_type: "Correlation type",
  "properties.military": "Military designation",
  "properties.magnitude": "Magnitude",
  "properties.frp": "Fire radiative power",
  "properties.country": "Country",
  "properties.category": "Category",
  "properties.source_class": "Source class",
  "properties.location_precision": "Location precision",
  eq: "Equals",
  in: "One of",
  range: "Range",
  exists: "Exists",
};
type Draft = {
  field: string;
  op: SetFilter["op"];
  value: string;
  or: boolean;
};
export function draftFilter(d: Draft): SetFilter {
  const numeric = ["properties.magnitude", "properties.frp"].includes(d.field),
    boolean = d.field === "properties.military" || d.op === "exists";
  const parse = (v: string) =>
    numeric ? Number(v) : boolean ? v === "true" : v;
  return {
    field: d.field,
    op: d.op,
    value:
      d.op === "in" || d.op === "range"
        ? d.value.split(",").map((s) => parse(s.trim()))
        : parse(d.value),
  };
}
export default function ObjectSetExplorer({
  onClose,
}: {
  onClose: () => void;
}) {
  const { t } = useLocale(),
    cases = useCases(),
    [kind, setKind] = useState<SetQuery["kind"]>("objects"),
    [filters, setFilters] = useState<Draft[]>([
      { field: "type", op: "eq", value: "aircraft", or: false },
    ]);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [hours, setHours] = useState("24"),
    [bbox, setBbox] = useState(""),
    [title, setTitle] = useState(""),
    [mode, setMode] = useState<"DYNAMIC" | "SNAPSHOT">("DYNAMIC"),
    [sets, setSets] = useState<ObjectSet[]>([]),
    [saved, setSaved] = useState<ObjectSet | null>(null);
  const [result, setResult] = useState<ResultPage<ItemSnapshot> | null>(null),
    [chosen, setChosen] = useState<string[]>([]),
    [map, setMap] = useState(false),
    [selection, setSelection] = useState<ItemSnapshot | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const query: SetQuery = {
    kind,
    filters: filters.filter((f) => !f.or).map(draftFilter),
    any: filters.filter((f) => f.or).map(draftFilter),
    ...(from || to
      ? {
          ...(from ? { from: new Date(from).toISOString() } : {}),
          ...(to ? { to: new Date(to).toISOString() } : {}),
        }
      : hours
        ? { last_hours: Number(hours) }
        : {}),
    ...(bbox ? { bbox: bbox.split(",").map(Number) } : {}),
    limit: 50,
  };
  const [preview, setPreview] = useState(query);
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    const timer = setTimeout(() => setPreview(JSON.parse(queryKey)), 350);
    return () => clearTimeout(timer);
  }, [queryKey]);
  useEffect(() => {
    const c = new AbortController();
    void caseRequest<ResultPage<ObjectSet>>(
      "sets?limit=100",
      undefined,
      "GET",
      c.signal,
    )
      .then((p) => setSets(p.items))
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, []);
  async function run(action: () => Promise<void>) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  async function evaluate(cursor?: string) {
    const r = saved
      ? await caseRequest<ResultPage<ItemSnapshot>>(
          `sets/${saved.id}/results?limit=50${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
        )
      : await caseRequest<ResultPage<ItemSnapshot>>("sets/evaluate", {
          ...query,
          cursor,
        });
    setResult((old) =>
      cursor && old ? { ...r, items: [...old.items, ...r.items] } : r,
    );
    setChosen([]);
  }
  async function pinVisible(selected = false) {
    if (!cases?.active || !result) return;
    let count = 0;
    const rows = result.items
      .filter((r) => !r.unavailable && (!selected || chosen.includes(r.id)))
      .slice(0, 100);
    for (let i = 0; i < rows.length; i += 20) {
      const batch = rows.slice(i, i + 20);
      await caseRequest(`cases/${cases.active.id}/items/batch`, {
        items: batch.map((r) => ({ kind: r.kind, id: r.id })),
      });
      count += batch.length;
    }
    await cases.refresh();
    setMessage(`${t("Added to case")}: ${count}`);
  }
  return (
    <section
      role="dialog"
      aria-label={t("OBJECT SETS")}
      className="fixed inset-2 md:inset-5 z-[1250] rounded border border-amber-400/50 bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col font-mono"
    >
      <header className="p-3 border-b border-slate-700 flex gap-3 items-center">
        <h2 className="text-amber-300 mr-auto">
          {t("OBJECT EXPLORER")} / {t("OBJECT SETS")}
        </h2>
        <button className={btn} onClick={onClose}>
          {t("Close")}
        </button>
      </header>
      <div className="flex-1 overflow-auto p-3 text-xs space-y-3">
        <div className="flex flex-wrap gap-2">
          <select
            aria-label={t("Saved sets")}
            className={input}
            value={saved?.id || ""}
            onChange={(e) => {
              const s = sets.find((s) => s.id === e.target.value) || null;
              setSaved(s);
              setResult(null);
            }}
          >
            <option value="">{t("Query preview")}</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} · {t(s.mode)}
              </option>
            ))}
          </select>
          {saved && (
            <span>
              {t(saved.mode)} {saved.truncated ? "· bounded snapshot" : ""}
            </span>
          )}
        </div>
        {!saved && (
          <>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label={t("Type")}
                className={input}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as SetQuery["kind"]);
                  setFilters([]);
                  setResult(null);
                }}
              >
                {(["objects", "observations", "correlations"] as const).map(
                  (k) => (
                    <option value={k} key={k}>
                      {t(
                        {
                          objects: "Objects",
                          observations: "Observations",
                          correlations: "Correlations",
                        }[k],
                      )}
                    </option>
                  ),
                )}
              </select>
              <label>
                {t("Last hours")}{" "}
                <input
                  type="number"
                  min="1"
                  max="744"
                  className={`${input} w-24`}
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                />
              </label>
              <label>
                {t("From")}{" "}
                <input
                  type="datetime-local"
                  className={input}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                {t("To")}{" "}
                <input
                  type="datetime-local"
                  className={input}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label>
                AOI (W,S,E,N){" "}
                <input
                  className={input}
                  aria-label="Object set AOI"
                  value={bbox}
                  onChange={(e) => setBbox(e.target.value)}
                />
              </label>
              {cases?.active?.aoi && (
                <button
                  className={btn}
                  onClick={() => setBbox(cases.active!.aoi!.join(","))}
                >
                  {t("Use case AOI")}
                </button>
              )}
            </div>
            {filters.map((f, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <select
                  className={input}
                  value={f.or ? "OR" : "AND"}
                  onChange={(e) =>
                    setFilters((old) =>
                      old.map((v, n) =>
                        n === i ? { ...v, or: e.target.value === "OR" } : v,
                      ),
                    )
                  }
                >
                  <option value="AND">{t("AND")}</option>
                  <option value="OR">{t("OR")}</option>
                </select>
                <select
                  aria-label={`Filter field ${i + 1}`}
                  className={input}
                  value={f.field}
                  onChange={(e) =>
                    setFilters((old) =>
                      old.map((v, n) =>
                        n === i ? { ...v, field: e.target.value } : v,
                      ),
                    )
                  }
                >
                  {fields.map((k) => (
                    <option value={k} key={k}>
                      {t(fieldLabels[k] || k)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Filter operation ${i + 1}`}
                  className={input}
                  value={f.op}
                  onChange={(e) =>
                    setFilters((old) =>
                      old.map((v, n) =>
                        n === i
                          ? { ...v, op: e.target.value as Draft["op"] }
                          : v,
                      ),
                    )
                  }
                >
                  {["eq", "in", "range", "exists"].map((k) => (
                    <option value={k} key={k}>
                      {t(fieldLabels[k] || k)}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Filter value ${i + 1}`}
                  className={input}
                  value={f.value}
                  onChange={(e) =>
                    setFilters((old) =>
                      old.map((v, n) =>
                        n === i ? { ...v, value: e.target.value } : v,
                      ),
                    )
                  }
                />
                <button
                  className={btn}
                  onClick={() =>
                    setFilters((old) => old.filter((_, n) => i !== n))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className={btn}
              disabled={filters.length >= 16}
              onClick={() =>
                setFilters((old) => [
                  ...old,
                  { field: "subtype", op: "eq", value: "", or: false },
                ])
              }
            >
              {t("Add filter")}
            </button>
            <details>
              <summary>{t("Query preview")}</summary>
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(preview, null, 2)}
              </pre>
            </details>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className={btn}
            disabled={busy}
            onClick={() => void run(() => evaluate())}
          >
            {t("Evaluate")}
          </button>
          <button className={btn} onClick={() => setMap(!map)}>
            {t("Map results")}
          </button>
          {cases?.active && saved && (
            <button
              className={btn}
              onClick={() =>
                void run(async () => {
                  await caseRequest(`cases/${cases.active!.id}/sets`, {
                    set_id: saved.id,
                  });
                  await cases.refresh();
                  setMessage(t("Added to case"));
                })
              }
            >
              {t("Attach to case")}: {cases.active.title}
            </button>
          )}
          {cases?.active && result && (
            <>
              <button
                className={btn}
                disabled={busy}
                onClick={() => void run(() => pinVisible())}
              >
                {t("Snapshot visible results")} (≤100)
              </button>
              <button
                className={btn}
                disabled={busy || !chosen.length}
                onClick={() => void run(() => pinVisible(true))}
              >
                {t("Pin selected")} ({chosen.length})
              </button>
            </>
          )}
        </div>
        {!saved && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const s = await caseRequest<ObjectSet>("sets", {
                  title,
                  mode,
                  query,
                });
                setSets((old) => [s, ...old]);
                setSaved(s);
                setMessage(t("Saved"));
              });
            }}
          >
            <input
              aria-label={t("Title")}
              required
              maxLength={200}
              className={input}
              value={title}
              placeholder={t("Title")}
              onChange={(e) => setTitle(e.target.value)}
            />
            <select
              aria-label={t("Set mode")}
              className={input}
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="DYNAMIC">{t("DYNAMIC")}</option>
              <option value="SNAPSHOT">{t("SNAPSHOT")}</option>
            </select>
            <button disabled={busy} className={btn}>
              {t("Save as Object Set")}
            </button>
          </form>
        )}
        <p className="text-slate-400">
          {t("Dynamic matches are not pinned evidence.")}{" "}
          {t(
            "Snapshot mode saves at most 100 canonical references at creation.",
          )}
        </p>
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-emerald-300">
            {message}
          </p>
        )}
        {busy && <p>{t("Loading…")}</p>}
        {result && (
          <p>
            {t("Result count (this page)")}: {result.items.length}{" "}
            {result.next_cursor ? "· " + t("More results available") : ""}
          </p>
        )}
        {map && result && (
          <CaseMap items={result.items} onSelect={setSelection} />
        )}
        {result?.items.map((r) => (
          <article key={r.id} className="border border-slate-700 rounded p-2">
            <div className="flex gap-2 items-center flex-wrap">
              <input
                aria-label={`${t("Pin")} ${r.name}`}
                type="checkbox"
                disabled={!!r.unavailable}
                checked={chosen.includes(r.id)}
                onChange={(e) =>
                  setChosen((old) =>
                    e.target.checked
                      ? [...old, r.id]
                      : old.filter((id) => id !== r.id),
                  )
                }
              />
              <button
                className="text-left mr-auto underline"
                onClick={() => setSelection(selection?.id === r.id ? null : r)}
              >
                {r.name} · {t(r.type)} · {r.subtype} · {r.at}
              </button>
              {!r.unavailable && (
                <AddToCaseButton reference={{ kind: r.kind, id: r.id }} />
              )}
              {r.object_id && (
                <button
                  className={btn}
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("osiris:case-object", {
                        detail: r.object_id,
                      }),
                    )
                  }
                >
                  {t("Open graph")}
                </button>
              )}
            </div>
            {selection?.id === r.id && (
              <EvidenceView items={r.provenance || []} />
            )}
          </article>
        ))}
        {result?.next_cursor && result.items.length < 500 && (
          <button
            className={btn}
            disabled={busy}
            onClick={() => void run(() => evaluate(result.next_cursor!))}
          >
            {t("Load more")}
          </button>
        )}
        {result && !result.items.length && <p>{t("No results")}</p>}
      </div>
    </section>
  );
}
