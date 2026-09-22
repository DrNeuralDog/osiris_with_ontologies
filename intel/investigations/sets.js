const { randomUUID } = require("node:crypto");
const M = require("./model");
const { references } = require("./references");
const { POLICIES } = require("../intelligence/policy");
const FILTERS = {
  type: "text",
  subtype: "text",
  name: "text",
  provider: "text",
  evidence_state: "text",
  freshness: "text",
  object_id: "text",
  status: "text",
  correlation_type: "text",
  "properties.military": "boolean",
  "properties.magnitude": "number",
  "properties.frp": "number",
  "properties.country": "text",
  "properties.category": "text",
  "properties.source_class": "text",
  "properties.location_precision": "text",
};
function validateQuery(raw = {}) {
  M.fields(raw, [
    "kind",
    "filters",
    "any",
    "from",
    "to",
    "last_hours",
    "bbox",
    "limit",
    "cursor",
  ]);
  M.check(
    ["objects", "observations", "correlations"].includes(raw.kind),
    "Invalid query kind",
  );
  const filters = raw.filters || [],
    any = raw.any || [];
  M.check(
    Array.isArray(filters) &&
      Array.isArray(any) &&
      filters.length + any.length <= 16 &&
      any.length <= 6,
    "Too many filters",
  );
  for (const f of [...filters, ...any]) {
    M.fields(f, ["field", "op", "value"]);
    M.check(
      Object.hasOwn(FILTERS, f.field) &&
        ["eq", "in", "range", "exists"].includes(f.op),
      "Invalid filter field/operation",
    );
    const values = f.op === "in" || f.op === "range" ? f.value : [f.value];
    M.check(
      Array.isArray(values) &&
        values.length > 0 &&
        values.length <= 30 &&
        (f.op !== "range" || values.length === 2),
      "Invalid filter values",
    );
    if (f.op === "exists") {
      M.check(typeof f.value === "boolean", "Invalid exists value");
      continue;
    }
    const type = FILTERS[f.field];
    M.check(
      values.every((v) =>
        type === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : type === "boolean"
            ? typeof v === "boolean"
            : typeof v === "string" && v.length <= 200,
      ),
      "Invalid filter value",
    );
    M.check(
      f.op !== "range" || type === "number",
      "Range needs numeric property",
    );
  }
  if (raw.last_hours !== undefined)
    M.check(
      typeof raw.last_hours === "number" &&
        raw.last_hours > 0 &&
        raw.last_hours <= 744 &&
        !raw.from &&
        !raw.to,
      "Invalid relative range",
    );
  const end = raw.last_hours ? new Date().toISOString() : raw.to,
    start = raw.last_hours
      ? new Date(Date.parse(end) - raw.last_hours * 3600000).toISOString()
      : raw.from;
  return {
    ...raw,
    filters,
    any,
    bbox: M.bbox(raw.bbox),
    range: M.range(start, end, raw.kind !== "objects"),
    limit: M.limit(raw.limit),
    cursor: raw.cursor,
  };
}
function compile(raw) {
  const q = validateQuery(raw),
    values = [],
    param = (v) => {
      values.push(v);
      return `$${values.length}`;
    };
  const scope = M.hash({ ...raw, cursor: undefined, limit: undefined }),
    after = M.cursor(raw.cursor, scope);
  if (after) M.uuid(after.id);
  const anchor = after?.anchor || new Date().toISOString();
  M.timestamp(anchor);
  // Freeze relative time windows across pages; IDs provide a unique total order.
  if (after && q.range) {
    q.range = { from: after.from, to: after.to };
    M.range(q.range.from, q.range.to, true);
  }
  const anchorParam = param(anchor),
    from = q.range ? param(q.range.from) : null,
    to = q.range ? param(q.range.to) : null;
  const time = (alias) =>
    from
      ? `${alias}.timeline_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz`
      : "true";
  let base;
  if (q.kind === "objects")
    base = `SELECT o.id,o.id object_id,'object'::text kind,o.canonical_name name,o.type,COALESCE(h.event_type,'') subtype,o.properties,
  COALESCE(h.provenance,p.provenance,'[]'::jsonb) provenance,COALESCE(h.evidence_state,'CURRENT_OBJECT') evidence_state,h.timeline_at at,
  ${from ? "h.lat" : "COALESCE(h.lat,l.lat)"} lat,${from ? "h.lon" : "COALESCE(h.lon,l.lon)"} lon,''::text status,''::text correlation_type,o.created_at
  FROM ontology_objects o LEFT JOIN intelligence_object_locations l ON l.object_id=o.id
  LEFT JOIN LATERAL(SELECT * FROM intelligence_observations h WHERE h.object_id=o.id AND h.event_type NOT IN ('OBJECT_CREATED','PROPERTIES_CHANGED','RELATIONSHIP_CREATED','RELATIONSHIP_CHANGED') AND ${time("h")} AND h.timeline_at<=${anchorParam}::timestamptz ORDER BY h.timeline_at DESC,h.id DESC LIMIT 1)h ON true
  LEFT JOIN LATERAL(SELECT jsonb_agg(p) provenance FROM (SELECT provider,source_id,source_record_id,kind,url,observed_at,fetched_at,confidence,extraction_method FROM ontology_provenance WHERE object_id=o.id ORDER BY fetched_at DESC LIMIT 12)p)p ON true
  WHERE o.created_at<=${anchorParam}::timestamptz ${from ? "AND h.id IS NOT NULL" : ""}`;
  if (q.kind === "observations")
    base = `SELECT h.id,h.object_id,'observation'::text kind,o.canonical_name name,o.type,h.event_type subtype,h.data properties,h.provenance,h.evidence_state,h.timeline_at at,h.lat,h.lon,''::text status,''::text correlation_type,h.fetched_at created_at
  FROM intelligence_observations h JOIN ontology_objects o ON o.id=h.object_id WHERE ${time("h")} AND h.fetched_at<=${anchorParam}::timestamptz`;
  if (q.kind === "correlations")
    base = `SELECT c.id,NULL::uuid object_id,'correlation'::text kind,c.correlation_type name,'correlation'::text type,c.correlation_type subtype,to_jsonb(c) properties,'[]'::jsonb provenance,c.evidence_state,c.last_confirmed_at at,
  (c.geographic_context->'center'->>'lat')::float8 lat,(c.geographic_context->'center'->>'lon')::float8 lon,c.status,c.correlation_type,c.created_at
  FROM intelligence_correlations c WHERE c.last_confirmed_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz AND c.created_at<=${anchorParam}::timestamptz`;
  const policyCases = Object.entries(POLICIES)
    .map(([k, p]) => `WHEN '${k}' THEN ${p.fresh}`)
    .join(" ");
  const liveCases = Object.entries(POLICIES)
    .map(([k, p]) => `WHEN '${k}' THEN ${p.live}`)
    .join(" ");
  const historyCases = Object.entries(POLICIES)
    .map(([k, p]) => `WHEN '${k}' THEN ${p.historical}`)
    .join(" ");
  const category = `CASE WHEN type='vessel' THEN 'maritime' WHEN type='event' THEN CASE subtype WHEN 'POSITION' THEN type WHEN 'CONFLICT_REPORT' THEN 'conflict' WHEN 'OFFICIAL_ALERT' THEN 'conflict' WHEN 'HEARD_EXPLOSION' THEN 'conflict' WHEN 'NEWS_EVENT' THEN 'news' WHEN 'SEVERE_WEATHER' THEN 'weather' ELSE lower(subtype) END WHEN type IN ('airport','port','infrastructure') THEN 'static' ELSE type END`;
  const age = `EXTRACT(epoch FROM (${anchorParam}::timestamptz-at))`;
  const fresh = `CASE WHEN at IS NULL OR at>${anchorParam}::timestamptz THEN 'UNKNOWN' WHEN ${age}<=CASE ${category} ${liveCases} ELSE 300 END THEN 'LIVE' WHEN ${age}<=CASE ${category} ${policyCases} ELSE 900 END THEN 'FRESH' WHEN ${age}<=CASE ${category} ${historyCases} ELSE 86400 END THEN 'STALE' ELSE 'HISTORICAL' END`;
  const predicates = [];
  function filter(f) {
    let expr;
    if (f.field === "provider") {
      const present =
        "EXISTS(SELECT 1 FROM jsonb_array_elements(provenance) evidence WHERE NULLIF(evidence->>'provider','') IS NOT NULL)";
      if (f.op === "exists") return f.value ? present : `NOT (${present})`;
      const comparison =
        f.op === "in"
          ? `(evidence->>'provider')=ANY(${param(f.value)}::text[])`
          : `(evidence->>'provider')=${param(f.value)}::text`;
      return `EXISTS(SELECT 1 FROM jsonb_array_elements(provenance) evidence WHERE ${comparison})`;
    } else if (f.field.startsWith("properties.")) {
      const key = f.field.slice(11),
        v = `properties->>${param(key)}`;
      expr =
        FILTERS[f.field] === "number"
          ? `CASE WHEN jsonb_typeof(properties->${param(key)})='number' THEN (${v})::numeric END`
          : v;
    } else
      expr = {
        type: "type",
        subtype: "subtype",
        name: "name",
        object_id: "object_id::text",
        status: "status",
        correlation_type: "correlation_type",
        evidence_state: "evidence_state",
        freshness: "freshness",
      }[f.field];
    if (f.op === "exists") return `${expr} IS ${f.value ? "NOT " : ""}NULL`;
    const cast = FILTERS[f.field] === "number" ? "numeric" : "text";
    const val = (v) => param(typeof v === "boolean" ? String(v) : v);
    if (f.op === "eq") return `${expr}=${val(f.value)}::${cast}`;
    if (f.op === "in")
      return `${expr}=ANY(${param(f.value.map((v) => (typeof v === "boolean" ? String(v) : v)))}::${cast}[])`;
    return `${expr} BETWEEN ${val(f.value[0])}::${cast} AND ${val(f.value[1])}::${cast}`;
  }
  predicates.push(...q.filters.map(filter));
  if (q.any.length) predicates.push(`(${q.any.map(filter).join(" OR ")})`);
  if (q.bbox) {
    const [w, s, e, n] = q.bbox;
    predicates.push(
      `lon BETWEEN ${param(w)} AND ${param(e)} AND lat BETWEEN ${param(s)} AND ${param(n)}`,
    );
  }
  if (after) predicates.push(`id>${param(after.id)}::uuid`);
  return {
    sql: `WITH base AS (${base}), result AS (SELECT base.*,${fresh} freshness FROM base) SELECT * FROM result WHERE ${predicates.join(" AND ") || "true"} ORDER BY id LIMIT ${param(q.limit + 1)}`,
    values,
    q,
    scope,
    anchor,
  };
}
class ObjectSets {
  constructor(store) {
    this.store = store;
  }
  async count(set, db) {
    if (set.mode === "SNAPSHOT")
      return {
        count: (
          await db.query(
            "SELECT count(*)::int n FROM investigation_set_members WHERE set_id=$1",
            [set.id],
          )
        ).rows[0].n,
        truncated: false,
      };
    const c = compile({ ...set.query, limit: 100 });
    c.values[c.values.length - 1] = 501;
    const n = (
      await db.query(`SELECT count(*)::int n FROM (${c.sql}) bounded`, c.values)
    ).rows[0].n;
    return { count: Math.min(n, 500), truncated: n > 500 };
  }
  async evaluate(raw, db) {
    if (!db) return M.transaction(this.store, (d) => this.evaluate(raw, d));
    const c = compile(raw),
      rows = (await db.query(c.sql, c.values)).rows;
    const more = rows.length > c.q.limit,
      items = rows.slice(0, c.q.limit).map(M.snapshot);
    return M.budget({
      items,
      next_cursor: more
        ? M.encode({
            id: items.at(-1).id,
            scope: c.scope,
            anchor: c.anchor,
            from: c.q.range?.from,
            to: c.q.range?.to,
          })
        : null,
      count: items.length,
      count_basis: "PAGE",
      truncated: more,
      query: raw,
    });
  }
  async create(raw) {
    M.fields(raw, ["title", "mode", "query"]);
    const title = M.text(raw.title, "title", 200);
    M.check(["DYNAMIC", "SNAPSHOT"].includes(raw.mode), "Invalid set mode");
    validateQuery(raw.query);
    M.check(!raw.query.cursor, "Saved query cannot contain cursor");
    return M.transaction(this.store, async (db) => {
      const id = randomUUID(),
        result =
          raw.mode === "SNAPSHOT"
            ? await this.evaluate({ ...raw.query, limit: 100 }, db)
            : null;
      await db.query(
        "INSERT INTO investigation_object_sets(id,title,mode,query,truncated) VALUES($1,$2,$3,$4,$5)",
        [id, title, raw.mode, raw.query, !!result?.next_cursor],
      );
      if (result)
        for (const r of result.items)
          await db.query(
            "INSERT INTO investigation_set_members VALUES($1,$2,$3)",
            [id, r.kind, r.id],
          );
      return (
        await db.query("SELECT * FROM investigation_object_sets WHERE id=$1", [
          id,
        ])
      ).rows[0];
    });
  }
  async list(raw = {}) {
    M.fields(raw, ["limit", "cursor"]);
    const scope = "sets",
      after = M.cursor(raw.cursor, scope),
      limit = M.limit(raw.limit);
    if (after) M.uuid(after.id);
    const rows = (
      await this.store.pool.query(
        "SELECT * FROM investigation_object_sets WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2",
        [after?.id || null, limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, limit),
      next_cursor:
        rows.length > limit
          ? M.encode({ scope, id: rows[limit - 1].id })
          : null,
    };
  }
  async get(id, db = this.store.pool) {
    M.uuid(id);
    const r = (
      await db.query("SELECT * FROM investigation_object_sets WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (!r) throw new M.InputError("Object set not found", 404);
    return r;
  }
  async run(id, raw = {}) {
    M.fields(raw, ["limit", "cursor"]);
    return M.transaction(this.store, async (db) => {
      const set = await this.get(id, db);
      if (set.mode === "DYNAMIC")
        return {
          ...(await this.evaluate({ ...set.query, ...raw }, db)),
          mode: set.mode,
        };
      const limit = M.limit(raw.limit),
        scope = `set:${id}`,
        after = M.cursor(raw.cursor, scope);
      if (after) M.uuid(after.id);
      const refs = (
        await db.query(
          "SELECT * FROM investigation_set_members WHERE set_id=$1 AND ($2::uuid IS NULL OR ref_id>$2) ORDER BY ref_id LIMIT $3",
          [id, after?.id || null, limit + 1],
        )
      ).rows;
      const items = (
        await references(
          this.store,
          db,
          refs[0]?.kind,
          refs.slice(0, limit).map((r) => r.ref_id),
        )
      ).map(M.snapshot);
      return M.budget({
        items,
        next_cursor:
          refs.length > limit
            ? M.encode({ scope, id: refs[limit - 1].ref_id })
            : null,
        mode: set.mode,
        count: items.length,
        truncated: set.truncated,
      });
    });
  }
}
module.exports = { ObjectSets, validateQuery, FILTERS, compile };
