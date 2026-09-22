import type { ReplayItem } from "./replay";
import type { Provenance, InvestigationSeed } from "./ontology";
import { registerInvestigation } from "./investigation";
export type CaseTab =
  | "OVERVIEW"
  | "MAP"
  | "GRAPH"
  | "TIMELINE"
  | "EVIDENCE"
  | "NOTES";
export interface CaseReference {
  kind: "object" | "observation" | "correlation" | "analysis";
  id: string;
  at?: string;
}
export interface CaseRecord {
  id: string;
  title: string;
  description: string;
  status: "OPEN" | "ARCHIVED";
  tags: string[];
  aoi: number[] | null;
  time_range: {
    from: string;
    to: string;
  } | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  counts?: Record<string, number>;
  sets?: ObjectSet[];
}
export interface ItemSnapshot {
  id: string;
  kind: CaseReference["kind"];
  object_id?: string;
  name: string;
  type: string;
  event_type?: string;
  subtype?: string;
  at?: string;
  lat: number | null;
  lon: number | null;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  provenance: Provenance[];
  evidence_state: string;
  model_version?: string;
  source_ids?: string[];
  related_object_ids?: string[];
  [key: string]: unknown;
}
export interface CaseItem {
  id: string;
  case_id: string;
  kind: CaseReference["kind"];
  ref_id: string;
  object_id: string | null;
  pinned: boolean;
  added_at: string;
  snapshot_at_add: ItemSnapshot;
}
export interface CaseNote {
  id: string;
  body: string;
  item_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface SetFilter {
  field: string;
  op: "eq" | "in" | "range" | "exists";
  value: string | number | boolean | (string | number | boolean)[];
}
export interface SetQuery {
  kind: "objects" | "observations" | "correlations";
  filters: SetFilter[];
  any?: SetFilter[];
  from?: string;
  to?: string;
  last_hours?: number;
  bbox?: number[];
  limit?: number;
  cursor?: string;
}
export interface ObjectSet {
  id: string;
  title: string;
  mode: "DYNAMIC" | "SNAPSHOT";
  query: SetQuery;
  truncated: boolean;
}
export interface ResultPage<T> {
  items: T[];
  next_cursor: string | null;
  truncated?: boolean;
}
export async function caseRequest<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(`/api/investigations/${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    cache: "no-store",
    signal,
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || `HTTP ${r.status}`);
  return result;
}
export async function caseReferenceFromSeed(
  seed: InvestigationSeed,
): Promise<CaseReference> {
  const context = await registerInvestigation(seed);
  return { kind: "object", id: context.object.id };
}
export function requestAddToCase(
  reference:
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
      },
) {
  window.dispatchEvent(
    new CustomEvent("osiris:add-to-case", { detail: reference }),
  );
}
export function casePoint(item: CaseItem) {
  const s = item.snapshot_at_add;
  return Number.isFinite(s.lat) && Number.isFinite(s.lon)
    ? { lat: s.lat!, lon: s.lon!, name: s.name, id: item.id }
    : null;
}
/** Membership snapshots are frozen analyst context, never interpolated telemetry. */
export function caseVisibleAt(item: CaseItem, at: number | null) {
  if (at === null || item.kind === "object") return true;
  const s = item.snapshot_at_add,
    interval = s.replay_interval as {
      from?: string;
      to?: string;
    } | null;
  const from = Math.max(
    Date.parse(interval?.from || s.at || ""),
    Date.parse(s.at || interval?.from || ""),
  );
  const to = Date.parse(interval?.to || "");
  return (
    (!Number.isFinite(from) || from <= at) && (!Number.isFinite(to) || at < to)
  );
}
export function caseJumpTime(item: CaseItem) {
  const at = Date.parse(item.snapshot_at_add.at || "");
  return Number.isFinite(at) ? at : null;
}

/** Replay uses only retained positions in the loaded global viewport; identities remain in the list. */
export function caseMapSnapshot(
  item: CaseItem,
  at: number | null,
  replay: ReplayItem[],
): ItemSnapshot {
  const s = item.snapshot_at_add;
  if (
    at === null ||
    item.kind !== "object" ||
    !["aircraft", "vessel", "satellite"].includes(s.type)
  )
    return s;
  const actual = replay.find(
    (r) =>
      r.object_id === (item.object_id || s.object_id || s.id) &&
      r.observation &&
      Date.parse(r.from) <= at &&
      Date.parse(r.to) > at,
  );
  if (!actual?.observation)
    return {
      ...s,
      lat: null,
      lon: null,
      location_basis: "NO_RETAINED_REPLAY_POSITION",
    };
  const o = actual.observation;
  return {
    ...s,
    lat: actual.lat,
    lon: actual.lon,
    at: o.timeline_at,
    provenance: o.provenance,
    evidence_state: o.evidence_state,
    location_observation_id: o.id,
    location_basis: "RETAINED_REPLAY_OBSERVATION",
  };
}
