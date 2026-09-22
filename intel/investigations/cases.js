const { randomUUID } = require("node:crypto");
const M = require("./model");
const { reference } = require("./references");
const { ObjectSets } = require("./sets");
class CaseService {
  constructor(store) {
    this.store = store;
    this.sets = new ObjectSets(store);
  }
  async audit(db, id, action, metadata = {}) {
    await db.query(
      "INSERT INTO investigation_case_activity(case_id,action,metadata) VALUES($1,$2,$3)",
      [id, action, metadata],
    );
    await db.query(
      "UPDATE investigation_cases SET updated_at=now() WHERE id=$1",
      [id],
    );
    await db.query(
      "DELETE FROM investigation_case_activity WHERE case_id=$1 AND id IN (SELECT id FROM investigation_case_activity WHERE case_id=$1 ORDER BY id DESC OFFSET 1000)",
      [id],
    );
  }
  async exists(db, id, write = false) {
    M.uuid(id);
    const r = (
      await db.query(
        `SELECT * FROM investigation_cases WHERE id=$1${write ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!r) throw new M.InputError("Case not found", 404);
    return r;
  }
  metadata(raw, partial = false) {
    M.fields(raw, [
      "title",
      "description",
      "status",
      "tags",
      "aoi",
      "time_range",
    ]);
    const r = {};
    if (!partial || raw.title !== undefined)
      r.title = M.text(raw.title, "title", 200);
    if (raw.description !== undefined) {
      M.check(
        typeof raw.description === "string" && raw.description.length <= 10000,
        "Invalid description",
      );
      r.description = raw.description;
    }
    if (raw.status !== undefined) {
      M.check(["OPEN", "ARCHIVED"].includes(raw.status), "Invalid status");
      r.status = raw.status;
    }
    if (raw.tags !== undefined) {
      M.check(Array.isArray(raw.tags) && raw.tags.length <= 20, "Invalid tags");
      r.tags = [...new Set(raw.tags.map((t) => M.text(t, "tag", 50)))];
    }
    if (raw.aoi !== undefined) r.aoi = M.bbox(raw.aoi);
    if (raw.time_range !== undefined) {
      if (raw.time_range === null) r.time_range = null;
      else {
        M.fields(raw.time_range, ["from", "to"]);
        r.time_range = M.range(raw.time_range.from, raw.time_range.to, true);
      }
    }
    return r;
  }
  async create(raw) {
    const p = this.metadata(raw);
    return M.transaction(this.store, async (db) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO investigation_cases(id,title,description,tags,aoi,time_range,status,archived_at) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='ARCHIVED' THEN now() ELSE NULL END)",
        [
          id,
          p.title,
          p.description || "",
          p.tags || [],
          p.aoi ? JSON.stringify(p.aoi) : null,
          p.time_range || null,
          p.status || "OPEN",
        ],
      );
      await this.audit(db, id, "CREATED");
      return this.exists(db, id);
    });
  }
  async update(id, raw) {
    const p = this.metadata(raw, true);
    return M.transaction(this.store, async (db) => {
      const c = await this.exists(db, id, true),
        v = { ...c, ...p };
      await db.query(
        "UPDATE investigation_cases SET title=$2,description=$3,status=$4,tags=$5,aoi=$6,time_range=$7,archived_at=CASE WHEN $4='ARCHIVED' THEN COALESCE(archived_at,now()) ELSE NULL END WHERE id=$1",
        [
          id,
          v.title,
          v.description,
          v.status,
          v.tags,
          v.aoi ? JSON.stringify(v.aoi) : null,
          v.time_range,
        ],
      );
      await this.audit(
        db,
        id,
        p.status
          ? p.status === "ARCHIVED"
            ? "ARCHIVED"
            : "REOPENED"
          : "UPDATED",
        { fields: Object.keys(p) },
      );
      return this.exists(db, id);
    });
  }
  async list(raw = {}) {
    M.fields(raw, ["status", "q", "tag", "limit", "cursor"]);
    const status = raw.status || "OPEN";
    M.check(["OPEN", "ARCHIVED", "all"].includes(status), "Invalid status");
    const q = raw.q || "",
      tag = raw.tag || "";
    M.check(
      typeof q === "string" &&
        q.length <= 200 &&
        typeof tag === "string" &&
        tag.length <= 50,
      "Invalid search",
    );
    const scope = M.hash([status, q, tag]),
      after = M.cursor(raw.cursor, scope);
    if (after) M.uuid(after.id);
    const limit = M.limit(raw.limit);
    const rows = (
      await this.store.pool.query(
        "SELECT * FROM investigation_cases WHERE ($1='all' OR status=$1) AND strpos(lower(title),lower($2))>0 AND ($3='' OR $3=ANY(tags)) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5",
        [status, q, tag, after?.id || null, limit + 1],
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
  async get(id) {
    return M.transaction(this.store, async (db) => {
      const c = await this.exists(db, id);
      const counts = (
        await db.query(
          "SELECT count(*)::int items,count(*) FILTER(WHERE kind='object' AND pinned)::int objects,count(*) FILTER(WHERE kind='observation')::int observations,count(*) FILTER(WHERE kind='correlation')::int correlations,count(*) FILTER(WHERE kind='analysis')::int analyses FROM investigation_case_items WHERE case_id=$1",
          [id],
        )
      ).rows[0];
      counts.notes = (
        await db.query(
          "SELECT count(*)::int n FROM investigation_case_notes WHERE case_id=$1",
          [id],
        )
      ).rows[0].n;
      const sets = (
        await db.query(
          "SELECT s.*,a.attached_at FROM investigation_case_object_sets a JOIN investigation_object_sets s ON s.id=a.set_id WHERE a.case_id=$1 ORDER BY a.attached_at DESC",
          [id],
        )
      ).rows;
      counts.saved_sets = sets.length;
      return { ...c, counts, sets };
    });
  }
  async add(id, raw, connection) {
    M.fields(raw, ["kind", "id", "at"]);
    const work = async (db) => {
      await this.exists(db, id, true);
      const r = await reference(this.store, db, raw.kind, raw.id, raw.at);
      const existing = (
        await db.query(
          "SELECT * FROM investigation_case_items WHERE case_id=$1 AND kind=$2 AND (ref_id=$3 OR ($2='object' AND COALESCE(object_id,(SELECT object_id FROM ontology_aliases WHERE old_id=ref_id))=$3))",
          [id, raw.kind, r.id],
        )
      ).rows[0];
      if (existing) return existing;
      M.check(
        (
          await db.query(
            "SELECT count(*)::int n FROM investigation_case_items WHERE case_id=$1",
            [id],
          )
        ).rows[0].n < M.LIMITS.items,
        "Case item limit reached (500)",
      );
      const snap = M.snapshot(r);
      const item = (
        await db.query(
          "INSERT INTO investigation_case_items(id,case_id,kind,ref_id,object_id,observation_id,correlation_id,analysis_id,snapshot_at_add) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            randomUUID(),
            id,
            raw.kind,
            r.id,
            r.object_id || null,
            raw.kind === "observation" ? r.id : null,
            raw.kind === "correlation" ? r.id : null,
            raw.kind === "analysis" ? r.id : null,
            snap,
          ],
        )
      ).rows[0];
      await this.audit(db, id, "ITEM_ADDED", {
        item_id: item.id,
        kind: raw.kind,
        ref_id: r.id,
      });
      return item;
    };
    return connection ? work(connection) : M.transaction(this.store, work);
  }
  async items(id, raw = {}) {
    M.fields(raw, ["limit", "cursor", "type", "from", "to"]);
    M.uuid(id);
    const limit = M.limit(raw.limit),
      scope = M.hash([id, raw.type, raw.from, raw.to]),
      after = M.cursor(raw.cursor, scope);
    if (after) M.uuid(after.id);
    const range = M.range(raw.from, raw.to);
    if (raw.type) M.text(raw.type, "type", 60);
    const rows = (
      await this.store.pool.query(
        "SELECT * FROM investigation_case_items WHERE case_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3::text IS NULL OR snapshot_at_add->>'type'=$3 OR snapshot_at_add->>'event_type'=$3) AND ($4::timestamptz IS NULL OR snapshot_at_add->>'at' IS NULL OR (snapshot_at_add->>'at')::timestamptz BETWEEN $4 AND $5) ORDER BY id LIMIT $6",
        [
          id,
          after?.id || null,
          raw.type || null,
          range?.from || null,
          range?.to || null,
          limit + 1,
        ],
      )
    ).rows;
    await this.exists(this.store.pool, id);
    return M.budget({
      items: rows.slice(0, limit),
      next_cursor:
        rows.length > limit
          ? M.encode({ scope, id: rows[limit - 1].id })
          : null,
    });
  }
  async remove(id, item) {
    M.uuid(item);
    return M.transaction(this.store, async (db) => {
      await this.exists(db, id, true);
      const r = await db.query(
        "DELETE FROM investigation_case_items WHERE case_id=$1 AND id=$2 RETURNING id",
        [id, item],
      );
      if (!r.rowCount) throw new M.InputError("Item not found", 404);
      await this.audit(db, id, "ITEM_REMOVED", { item_id: item });
      return { removed: true };
    });
  }
  async pin(id, item, pinned) {
    M.uuid(item);
    M.check(typeof pinned === "boolean", "Invalid pinned");
    return M.transaction(this.store, async (db) => {
      await this.exists(db, id, true);
      const r = (
        await db.query(
          "UPDATE investigation_case_items SET pinned=$3 WHERE case_id=$1 AND id=$2 RETURNING *",
          [id, item, pinned],
        )
      ).rows[0];
      if (!r) throw new M.InputError("Item not found", 404);
      await this.audit(db, id, pinned ? "ITEM_PINNED" : "ITEM_UNPINNED", {
        item_id: item,
      });
      return r;
    });
  }
  async note(id, raw, noteId) {
    M.fields(raw, ["body", "item_id"]);
    M.check(
      typeof raw.body === "string" &&
        raw.body.trim().length > 0 &&
        raw.body.length <= 10000,
      "Invalid note",
    );
    if (noteId) M.uuid(noteId);
    if (raw.item_id != null) M.uuid(raw.item_id);
    return M.transaction(this.store, async (db) => {
      await this.exists(db, id, true);
      if (raw.item_id)
        M.check(
          (
            await db.query(
              "SELECT 1 FROM investigation_case_items WHERE case_id=$1 AND id=$2",
              [id, raw.item_id],
            )
          ).rowCount,
          "Item belongs to another case",
        );
      if (!noteId)
        M.check(
          (
            await db.query(
              "SELECT count(*)::int n FROM investigation_case_notes WHERE case_id=$1",
              [id],
            )
          ).rows[0].n < 200,
          "Note limit reached",
        );
      const r = noteId
        ? (
            await db.query(
              "UPDATE investigation_case_notes SET body=$3,item_id=CASE WHEN $4 THEN $5::uuid ELSE item_id END,updated_at=now() WHERE case_id=$1 AND id=$2 RETURNING *",
              [
                id,
                noteId,
                raw.body,
                Object.hasOwn(raw, "item_id"),
                raw.item_id || null,
              ],
            )
          ).rows[0]
        : (
            await db.query(
              "INSERT INTO investigation_case_notes(id,case_id,item_id,body) VALUES($1,$2,$3,$4) RETURNING *",
              [randomUUID(), id, raw.item_id || null, raw.body],
            )
          ).rows[0];
      if (!r) throw new M.InputError("Note not found", 404);
      await this.audit(db, id, noteId ? "NOTE_EDITED" : "NOTE_CREATED", {
        note_id: r.id,
      });
      return r;
    });
  }
  async notes(id) {
    await this.exists(this.store.pool, id);
    return {
      items: (
        await this.store.pool.query(
          "SELECT * FROM investigation_case_notes WHERE case_id=$1 ORDER BY created_at DESC,id LIMIT 200",
          [id],
        )
      ).rows,
    };
  }
  async activity(id, raw = {}) {
    M.fields(raw, ["limit", "cursor"]);
    await this.exists(this.store.pool, id);
    const scope = `activity:${id}`,
      after = M.cursor(raw.cursor, scope),
      limit = M.limit(raw.limit);
    if (after) M.check(/^\d+$/.test(after.id), "Invalid cursor");
    const rows = (
      await this.store.pool.query(
        "SELECT * FROM investigation_case_activity WHERE case_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3",
        [id, after?.id || null, limit + 1],
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
  async attach(id, setId) {
    M.uuid(setId);
    return M.transaction(this.store, async (db) => {
      await this.exists(db, id, true);
      await this.sets.get(setId, db);
      M.check(
        (
          await db.query(
            "SELECT count(*)::int n FROM investigation_case_object_sets WHERE case_id=$1",
            [id],
          )
        ).rows[0].n < 30,
        "Set attachment limit reached",
      );
      const r = await db.query(
        "INSERT INTO investigation_case_object_sets VALUES($1,$2,now()) ON CONFLICT DO NOTHING",
        [id, setId],
      );
      if (r.rowCount)
        await this.audit(db, id, "SET_ATTACHED", { set_id: setId });
      return { attached: true };
    });
  }
  async detach(id, setId) {
    M.uuid(setId);
    return M.transaction(this.store, async (db) => {
      await this.exists(db, id, true);
      await db.query(
        "DELETE FROM investigation_case_object_sets WHERE case_id=$1 AND set_id=$2",
        [id, setId],
      );
      await this.audit(db, id, "SET_DETACHED", { set_id: setId });
      return { detached: true };
    });
  }
  async addBatch(id, raw) {
    M.fields(raw, ["items"]);
    M.check(
      Array.isArray(raw.items) &&
        raw.items.length > 0 &&
        raw.items.length <= 20,
      "Invalid batch (1-20 references)",
    );
    return M.transaction(this.store, async (db) => {
      const items = [];
      for (const ref of raw.items) items.push(await this.add(id, ref, db));
      return { items };
    });
  }
  async setCounts(id) {
    return M.transaction(this.store, async (db) => {
      await this.exists(db, id);
      const sets = (
        await db.query(
          "SELECT s.* FROM investigation_case_object_sets a JOIN investigation_object_sets s ON s.id=a.set_id WHERE a.case_id=$1 ORDER BY s.id LIMIT 30",
          [id],
        )
      ).rows;
      const counts = [];
      for (const s of sets)
        counts.push({ id: s.id, ...(await this.sets.count(s, db)) });
      return { items: counts };
    });
  }
  async timeline(id, raw = {}) {
    M.fields(raw, ["from", "to", "limit", "cursor"]);
    return M.transaction(this.store, async (db) => {
      const c = await this.exists(db, id),
        scope = M.hash([id, raw.from, raw.to, c.time_range]),
        after = M.cursor(raw.cursor, scope),
        limit = M.limit(raw.limit);
      const range = after
        ? M.range(after.from, after.to, true)
        : M.range(
            raw.from || c.time_range?.from,
            raw.to || c.time_range?.to,
            true,
          );
      if (after) {
        M.timestamp(after.at);
        M.check(
          /^(observation|correlation|analysis):[a-f0-9-]+$/.test(after.id),
          "Invalid cursor",
        );
      }
      const rows = (
        await db.query(
          `WITH members AS (SELECT * FROM investigation_case_items WHERE case_id=$1), events AS (
    SELECT DISTINCT h.id::text id,'observation:'||h.id event_key,h.object_id,h.event_type,h.timeline_at at,h.lat,h.lon,h.data properties,h.provenance,h.evidence_state,o.canonical_name name,o.type,'observation' kind
    FROM members i JOIN intelligence_observations h ON (i.kind='observation' AND h.id=i.observation_id) OR (i.kind='object' AND i.pinned AND h.object_id=COALESCE(i.object_id,(SELECT object_id FROM ontology_aliases WHERE old_id=i.ref_id)))
    JOIN ontology_objects o ON o.id=h.object_id WHERE h.timeline_at BETWEEN $2 AND $3
    UNION ALL
    SELECT c.id::text,'correlation:'||e.id,NULL::uuid,'CORRELATION_'||e.status,e.changed_at,NULL::float8,NULL::float8,jsonb_build_object('status',e.status,'reason',e.reason),'[]'::jsonb,'derived',c.correlation_type,'correlation','correlation'
    FROM members i JOIN intelligence_correlation_events e ON e.correlation_id=i.correlation_id JOIN intelligence_correlations c ON c.id=e.correlation_id WHERE e.changed_at BETWEEN $2 AND $3
    UNION ALL
    SELECT i.ref_id::text,'analysis:'||i.ref_id,NULL::uuid,'DERIVED_ANALYSIS',(i.snapshot_at_add->>'at')::timestamptz,(i.snapshot_at_add->>'lat')::float8,(i.snapshot_at_add->>'lon')::float8,i.snapshot_at_add,COALESCE(i.snapshot_at_add->'provenance','[]'),'derived',i.snapshot_at_add->>'name','analysis','analysis'
    FROM members i WHERE i.kind='analysis' AND (i.snapshot_at_add->>'at')::timestamptz BETWEEN $2 AND $3
   ) SELECT *,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at FROM events WHERE ($4::timestamptz IS NULL OR (at,event_key)>($4::timestamptz,$5::text)) ORDER BY at,event_key LIMIT $6`,
          [
            id,
            range.from,
            range.to,
            after?.at || null,
            after?.id || null,
            limit + 1,
          ],
        )
      ).rows;
      return M.budget({
        items: rows.slice(0, limit),
        lifecycle: [],
        next_cursor:
          rows.length > limit
            ? M.encode({
                scope,
                id: rows[limit - 1].event_key,
                at: rows[limit - 1].cursor_at,
                from: range.from,
                to: range.to,
              })
            : null,
        range,
        activity_separate: true,
      });
    });
  }
  async graph(id, raw = {}) {
    M.fields(raw, ["expand"]);
    M.check(
      raw.expand === undefined || ["true", "false"].includes(raw.expand),
      "Invalid expansion",
    );
    return M.transaction(this.store, async (db) => {
      await this.exists(db, id);
      let ids = (
        await db.query(
          "SELECT DISTINCT COALESCE(i.object_id,a.object_id) id FROM investigation_case_items i LEFT JOIN ontology_aliases a ON a.old_id=i.ref_id WHERE i.case_id=$1 AND i.pinned AND (i.object_id IS NOT NULL OR a.object_id IS NOT NULL) ORDER BY id LIMIT 101",
          [id],
        )
      ).rows.map((r) => r.id);
      const truncated = ids.length > 100;
      ids = ids.slice(0, 100);
      const pinned = [...ids];
      if (raw.expand === "true") {
        const related = (
          await db.query(
            "SELECT source_object_id,target_object_id FROM ontology_links WHERE source_object_id=ANY($1::uuid[]) OR target_object_id=ANY($1::uuid[]) ORDER BY id LIMIT 200",
            [ids],
          )
        ).rows;
        ids = [
          ...new Set([
            ...ids,
            ...related.flatMap((l) => [l.source_object_id, l.target_object_id]),
          ]),
        ].slice(0, 200);
      }
      const links = (
        await db.query(
          `SELECT l.*,l.source_object_id source,l.target_object_id target,COALESCE((SELECT jsonb_agg(p) FROM (SELECT provider,kind,url,source_id,observed_at,fetched_at,confidence FROM ontology_provenance WHERE link_id=l.id LIMIT 12)p),'[]') provenance FROM ontology_links l WHERE source_object_id=ANY($1::uuid[]) AND target_object_id=ANY($1::uuid[]) ORDER BY id LIMIT 301`,
          [ids],
        )
      ).rows;
      return M.budget({
        root_id: ids[0] || "",
        nodes: await this.store.objects(ids, db),
        links: links.slice(0, 300),
        pinned_ids: pinned,
        truncated: truncated || links.length > 300 || ids.length === 200,
      });
    });
  }
  async analysis(raw) {
    M.fields(raw, ["kind", "parameters", "cluster_id"]);
    M.check(
      ["cluster", "acoustic"].includes(raw.kind),
      "Invalid analysis kind",
    );
    const air = new (require("../intelligence/air-service").AirThreatService)(
      this.store,
    );
    let result, sourceIds;
    if (raw.kind === "cluster") {
      const state = await air.state(raw.parameters);
      result = state.clusters.find((c) => c.id === raw.cluster_id);
      if (!result)
        throw new M.InputError(
          "Cluster no longer available; refresh reports",
          404,
        );
      sourceIds = result.report_ids;
      const reports = state.reports.filter((r) => sourceIds.includes(r.id));
      result = {
        ...result,
        at: state.at,
        lat: reports[0]?.lat ?? null,
        lon: reports[0]?.lon ?? null,
        provenance: reports.flatMap((r) => r.provenance),
        source_ids: sourceIds,
      };
    } else {
      result = await air.acoustic(raw.parameters);
      M.check(result.zones?.length, "Acoustic scenario unavailable");
      sourceIds = [
        M.uuid(raw.parameters.observation_id),
        ...(result.weather_observation_id
          ? [result.weather_observation_id]
          : []),
      ];
      const source = (
        await this.store.pool.query(
          "SELECT lat,lon FROM intelligence_observations WHERE id=$1",
          [sourceIds[0]],
        )
      ).rows[0];
      result = {
        ...result,
        lat: source?.lat ?? null,
        lon: source?.lon ?? null,
        parameters: raw.parameters,
        at: raw.parameters.at || new Date().toISOString(),
      };
    }
    const snapshot = M.snapshot(result),
      fingerprint = M.hash([raw.kind, snapshot]);
    return M.transaction(this.store, async (db) => {
      const row = (
        await db.query(
          "INSERT INTO investigation_analyses(id,fingerprint,kind,model_version,source_ids,result) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(fingerprint) DO UPDATE SET fingerprint=excluded.fingerprint RETURNING id",
          [
            randomUUID(),
            fingerprint,
            raw.kind,
            result.model_version || "unknown",
            sourceIds,
            snapshot,
          ],
        )
      ).rows[0];
      return { kind: "analysis", id: row.id };
    });
  }
  async export(id, format) {
    M.check(["json", "geojson"].includes(format), "Invalid export format");
    const c = await this.get(id),
      items = (
        await this.store.pool.query(
          "SELECT * FROM investigation_case_items WHERE case_id=$1 ORDER BY added_at,id LIMIT 500",
          [id],
        )
      ).rows,
      notes = (await this.notes(id)).items;
    const classification = {
      snapshots: "SOURCE_OR_DERIVED_AT_ADD_NOT_NEW_FACTS",
      notes: "ANALYST_NOTES",
      membership: "ANALYST_ACTION",
    };
    if (format === "geojson")
      return M.budget(
        {
          type: "FeatureCollection",
          case_id: id,
          classification,
          features: items
            .filter(
              (i) =>
                Number.isFinite(i.snapshot_at_add.lat) &&
                Number.isFinite(i.snapshot_at_add.lon),
            )
            .map((i) => ({
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [i.snapshot_at_add.lon, i.snapshot_at_add.lat],
              },
              properties: {
                ...M.safe(i.snapshot_at_add),
                case_item_id: i.id,
                added_at: i.added_at,
                snapshot_only: true,
              },
            })),
        },
        32 * 1024 * 1024,
      );
    const members = (
      await this.store.pool.query(
        "SELECT m.* FROM investigation_set_members m JOIN investigation_case_object_sets a ON a.set_id=m.set_id WHERE a.case_id=$1 ORDER BY m.set_id,m.ref_id LIMIT 3000",
        [id],
      )
    ).rows;
    return M.budget(
      {
        schema: "osiris.case.v1",
        exported_at: new Date().toISOString(),
        classification,
        case: c,
        items,
        notes,
        sets: c.sets.map((s) => ({
          ...s,
          members: members.filter((m) => m.set_id === s.id),
        })),
      },
      32 * 1024 * 1024,
    );
  }
}
module.exports = { CaseService };
