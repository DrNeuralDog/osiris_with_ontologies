const M = require("./model");
const { intervals } = require("../intelligence/timeline-policy");
function temporal(o) {
  const interval = intervals([{ ...o, object_type: o.type }])[0];
  return interval ? { from: interval.from, to: interval.to } : null;
}
async function reference(store, db, kind, id, at) {
  M.uuid(id);
  if (at !== undefined) M.timestamp(at);
  M.check(
    ["object", "observation", "correlation", "analysis"].includes(kind),
    "Invalid reference kind",
  );
  if (kind === "object") {
    const o = await store.get(id, db),
      p = o.properties;
    const observed = (
      await db.query(
        "SELECT * FROM intelligence_observations WHERE object_id=$1 AND lat IS NOT NULL AND timeline_at<=now() ORDER BY timeline_at DESC,id DESC LIMIT 1",
        [o.id],
      )
    ).rows[0];
    const loc =
      observed ||
      (
        await db.query(
          "SELECT * FROM intelligence_object_locations WHERE object_id=$1",
          [o.id],
        )
      ).rows[0];
    return {
      kind,
      id: o.id,
      object_id: o.id,
      name: o.canonical_name,
      type: o.type,
      properties: p,
      provenance: [...(observed?.provenance || []), ...o.provenance].slice(
        0,
        40,
      ),
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
      at: loc?.observed_at || loc?.timeline_at || null,
      evidence_state: "CURRENT_OBJECT",
      location_basis: observed
        ? "RETAINED_OBSERVATION"
        : loc
          ? "RETAINED_REFERENCE_LOCATION"
          : null,
      location_observation_id: observed?.id || null,
    };
  }
  if (kind === "observation") {
    const o = (
      await db.query(
        "SELECT h.*,o.canonical_name,o.type FROM intelligence_observations h JOIN ontology_objects o ON o.id=h.object_id WHERE h.id=$1",
        [id],
      )
    ).rows[0];
    if (!o)
      throw new M.InputError(
        "Observation not found (possibly outside retention)",
        404,
      );
    return {
      ...o,
      kind,
      name: o.canonical_name,
      at: o.timeline_at,
      properties: o.data,
      replay_interval: temporal(o),
    };
  }
  if (kind === "correlation") {
    const c = (
      await db.query("SELECT * FROM intelligence_correlations WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (!c) throw new M.InputError("Correlation not found", 404);
    let record = c;
    if (at) {
      const v = (
        await db.query(
          "SELECT snapshot,recorded_at FROM intelligence_correlation_versions WHERE correlation_id=$1 AND recorded_at<=$2 ORDER BY recorded_at DESC,id DESC LIMIT 1",
          [id, M.timestamp(at)],
        )
      ).rows[0];
      if (!v)
        throw new M.InputError(
          "No retained correlation version at this time",
          404,
        );
      record = { ...v.snapshot, id, version_recorded_at: v.recorded_at };
      const event = (
        await db.query(
          "SELECT status,changed_at FROM intelligence_correlation_events WHERE correlation_id=$1 AND changed_at<=$2 ORDER BY changed_at DESC,id DESC LIMIT 1",
          [id, at],
        )
      ).rows[0];
      record.status = event?.status || record.status;
      if (
        record.status === "ACTIVE" &&
        Date.parse(record.expires_at) <= Date.parse(at)
      )
        record.status = "EXPIRED";
    }
    const evidence = at
      ? record.evidence || []
      : (
          await db.query(
            "SELECT snapshot FROM intelligence_correlation_evidence WHERE correlation_id=$1 ORDER BY ordinal",
            [id],
          )
        ).rows.map((r) => r.snapshot);
    return {
      ...record,
      kind,
      name: record.correlation_type,
      type: "correlation",
      at: at || record.last_confirmed_at,
      replay_interval: {
        from:
          record.created_at || record.window_start || at || record.detected_at,
        to: record.resolved_at || record.expires_at,
      },
      lat: record.geographic_context?.center?.lat ?? null,
      lon: record.geographic_context?.center?.lon ?? null,
      evidence,
      provenance: evidence.flatMap((e) => e.provenance || []),
      evidence_state: "derived",
    };
  }
  const a = (
    await db.query("SELECT * FROM investigation_analyses WHERE id=$1", [id])
  ).rows[0];
  if (!a) throw new M.InputError("Analysis not found", 404);
  return {
    ...a.result,
    id,
    kind,
    name: a.result.kind || a.kind,
    type: a.kind,
    model_version: a.model_version,
    source_ids: a.source_ids,
    evidence_state: "derived",
  };
}
/** A snapshot set evaluates in a fixed number of SQL calls, not one call per member. */
async function references(store, db, kind, ids) {
  if (!ids.length) return [];
  if (kind === "object") {
    const aliases = (
      await db.query(
        "SELECT old_id,object_id FROM ontology_aliases WHERE old_id=ANY($1::uuid[])",
        [ids],
      )
    ).rows;
    const canonical = ids.map(
        (id) => aliases.find((a) => a.old_id === id)?.object_id || id,
      ),
      objects = await store.objects(canonical, db);
    const locations = (
      await db.query(
        "SELECT * FROM intelligence_object_locations WHERE object_id=ANY($1::uuid[])",
        [canonical],
      )
    ).rows;
    return ids.map((id, i) => {
      const o = objects.find((o) => o.id === canonical[i]),
        l = locations.find((l) => l.object_id === canonical[i]);
      return o
        ? {
            id,
            canonical_id: o.id,
            object_id: o.id,
            kind,
            type: o.type,
            name: o.canonical_name,
            properties: o.properties,
            provenance: o.provenance,
            evidence_state: "CURRENT_OBJECT",
            lat: l?.lat ?? null,
            lon: l?.lon ?? null,
            at: l?.observed_at || null,
          }
        : {
            id,
            kind,
            unavailable: true,
            name: "Outside retention / unavailable",
          };
    });
  }
  if (kind === "observation") {
    const rows = (
      await db.query(
        "SELECT h.*,o.type,o.canonical_name name FROM intelligence_observations h JOIN ontology_objects o ON o.id=h.object_id WHERE h.id=ANY($1::uuid[])",
        [ids],
      )
    ).rows;
    return ids.map((id) => {
      const o = rows.find((r) => r.id === id);
      return o
        ? {
            ...o,
            kind,
            at: o.timeline_at,
            properties: o.data,
            replay_interval: temporal(o),
          }
        : {
            id,
            kind,
            name: "Outside retention / unavailable",
            unavailable: true,
          };
    });
  }
  const rows = (
    await db.query(
      `SELECT c.*,COALESCE((SELECT jsonb_agg(snapshot ORDER BY ordinal) FROM intelligence_correlation_evidence WHERE correlation_id=c.id),'[]') evidence FROM intelligence_correlations c WHERE c.id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  return ids.map((id) => {
    const c = rows.find((r) => r.id === id);
    return c
      ? {
          ...c,
          kind,
          name: c.correlation_type,
          type: "correlation",
          at: c.last_confirmed_at,
          lat: c.geographic_context?.center?.lat ?? null,
          lon: c.geographic_context?.center?.lon ?? null,
          provenance: c.evidence.flatMap((e) => e.provenance || []),
        }
      : {
          id,
          kind,
          name: "Outside retention / unavailable",
          unavailable: true,
        };
  });
}
module.exports = { reference, references };
