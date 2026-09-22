const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { OntologyStore } = require("../store");
const { CaseService } = require("../../investigations/cases");
const { ObjectSets, validateQuery } = require("../../investigations/sets");
const { writeObservation } = require("../../intelligence/history");
const schema = `cases_${randomUUID().replaceAll("-", "")}`;
let admin, store, cases, sets, object, observation, caseId;
const prov = [
  {
    provider: "fixture",
    source_id: "stable-1",
    kind: "observed",
    confidence: null,
  },
];
before(async () => {
  admin = new Pool();
  await admin.query(`CREATE SCHEMA ${schema}`);
  store = new OntologyStore(
    new Pool({ options: `-c search_path=${schema},public` }),
  );
  await store.migrate();
  await store.migrate();
  cases = new CaseService(store);
  sets = new ObjectSets(store);
  [object] = await store.ingest([
    {
      type: "aircraft",
      canonical_name: "Test aircraft",
      external_ids: [{ namespace: "icao24", value: "abc123" }],
      properties: { military: true },
      provenance: prov,
    },
  ]);
  await store.transaction(async (db) => {
    await writeObservation(db, object, {
      event_type: "POSITION",
      observed_at: new Date().toISOString(),
      source_id: "fixture",
      lat: 50,
      lon: 30,
      data: { altitude: 1000 },
      provenance: prov,
    });
  });
  observation = (
    await store.pool.query(
      "SELECT id FROM intelligence_observations WHERE event_type='POSITION'",
    )
  ).rows[0].id;
});
after(async () => {
  await store.pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
test("case create, update, archive/reopen and real counters", async () => {
  const c = await cases.create({
    title: "Question",
    description: "What happened?",
    tags: ["aviation"],
  });
  caseId = c.id;
  assert.equal(c.status, "OPEN");
  assert.equal(
    (await cases.update(c.id, { title: "Updated", status: "ARCHIVED" })).status,
    "ARCHIVED",
  );
  assert.equal((await cases.get(c.id)).title, "Updated");
  assert.equal(
    (await cases.update(c.id, { status: "OPEN" })).archived_at,
    null,
  );
  assert.equal((await cases.list({ tag: "aviation" })).items[0].id, c.id);
});
test("canonical membership, duplicate handling and immutable snapshot", async () => {
  const a = await cases.add(caseId, { kind: "object", id: object });
  const b = await cases.add(caseId, { kind: "object", id: object });
  assert.equal(a.id, b.id);
  await store.pool.query(
    "UPDATE ontology_objects SET canonical_name='Changed' WHERE id=$1",
    [object],
  );
  assert.equal(
    (await cases.items(caseId, {})).items[0].snapshot_at_add.name,
    "Test aircraft",
  );
  assert.equal(a.snapshot_at_add.provenance[0].provider, "fixture");
  await cases.remove(caseId, a.id);
  assert.equal((await store.get(object)).canonical_name, "Changed");
  await cases.add(caseId, { kind: "object", id: object });
});
test("observation membership, timeline, evidence and graph", async () => {
  await cases.add(caseId, { kind: "observation", id: observation });
  const timeline = await cases.timeline(caseId, {});
  assert.ok(timeline.items.some((i) => i.id === observation));
  const graph = await cases.graph(caseId, {});
  assert.ok(graph.nodes.some((n) => n.id === object));
  assert.equal(graph.links.length, 0);
  const result = await cases.export(caseId, "geojson");
  assert.ok(result.features.some((f) => f.geometry.coordinates[0] === 30));
});
test("plain text notes, item association and activity separation", async () => {
  const item = (await cases.items(caseId, {})).items[0];
  const n = await cases.note(caseId, {
    body: "<script>alert(1)</script> Analyst hypothesis",
    item_id: item.id,
  });
  assert.match(n.body, /<script>/);
  const edited = await cases.note(caseId, { body: "Edited" }, n.id);
  assert.equal(edited.body, "Edited");
  assert.ok(
    (await cases.activity(caseId, {})).items.some(
      (a) => a.action === "NOTE_EDITED",
    ),
  );
  const e = await cases.export(caseId, "json");
  assert.equal(e.notes[0].body, "Edited");
  assert.equal(e.classification.notes, "ANALYST_NOTES");
});
test("strict DSL, AND/OR, SQL values and bounds", async () => {
  const query = {
    kind: "objects",
    filters: [
      { field: "type", op: "eq", value: "aircraft" },
      { field: "properties.military", op: "eq", value: true },
    ],
    any: [
      { field: "name", op: "eq", value: "Changed" },
      { field: "name", op: "eq", value: "' OR 1=1 --" },
    ],
  };
  assert.equal((await sets.evaluate(query)).items.length, 1);
  for (const q of [
    { kind: "objects", filters: [{ field: "pg_sleep", op: "eq", value: 1 }] },
    {
      kind: "observations",
      from: "2000-01-01T00:00:00Z",
      to: new Date().toISOString(),
    },
    { kind: "objects", bbox: [-180, -90, 180, 90] },
    { kind: "objects", limit: 10000 },
  ])
    assert.throws(() => validateQuery(q));
  assert.equal(
    (
      await sets.evaluate({
        kind: "objects",
        filters: [{ field: "name", op: "eq", value: "' OR 1=1 --" }],
      })
    ).items.length,
    0,
  );
});
test("dynamic set changes, snapshot references stay stable; attach without permanent pinning", async () => {
  const query = {
    kind: "objects",
    filters: [{ field: "type", op: "eq", value: "aircraft" }],
  };
  const dynamic = await sets.create({
    title: "Dynamic",
    mode: "DYNAMIC",
    query,
  });
  const snapshot = await sets.create({
    title: "Snapshot",
    mode: "SNAPSHOT",
    query,
  });
  await store.ingest([
    {
      type: "aircraft",
      canonical_name: "Second",
      external_ids: [{ namespace: "icao24", value: "abcdef" }],
      provenance: prov,
    },
  ]);
  assert.equal((await sets.run(dynamic.id, {})).items.length, 2);
  assert.equal((await sets.run(snapshot.id, {})).items.length, 1);
  await cases.attach(caseId, dynamic.id);
  assert.equal((await cases.get(caseId)).counts.saved_sets, 1);
  assert.equal((await cases.get(caseId)).counts.objects, 1);
});
test("bounded deterministic pages and invalid cursor", async () => {
  const query = { kind: "objects", limit: 1 };
  const a = await sets.evaluate(query);
  const b = await sets.evaluate({ ...query, cursor: a.next_cursor });
  assert.notEqual(a.items[0].id, b.items[0].id);
  await assert.rejects(sets.evaluate({ ...query, cursor: "bad" }), /cursor/i);
  await assert.rejects(cases.get(randomUUID()), /not found/i);
  await assert.rejects(
    cases.add(caseId, { kind: "arbitrary_table", id: object }),
    /kind/i,
  );
});
test("AOI/time/relative freshness and missing observations", async () => {
  const q = {
    kind: "observations",
    last_hours: 1,
    bbox: [29, 49, 31, 51],
    filters: [
      { field: "subtype", op: "eq", value: "POSITION" },
      { field: "provider", op: "eq", value: "fixture" },
      { field: "freshness", op: "in", value: ["LIVE", "FRESH"] },
    ],
  };
  assert.equal((await sets.evaluate(q)).items.length, 1);
  assert.equal(
    (await sets.evaluate({ ...q, bbox: [0, 0, 1, 1] })).items.length,
    0,
  );
  assert.equal(
    (
      await sets.evaluate({
        ...q,
        last_hours: undefined,
        from: "2020-01-01T00:00:00Z",
        to: "2020-01-02T00:00:00Z",
      })
    ).items.length,
    0,
  );
  await assert.rejects(
    cases.add(caseId, { kind: "observation", id: randomUUID() }),
    /not found/,
  );
});
test("atomic batch add rolls back on unknown member", async () => {
  const c = await cases.create({ title: "Atomic batch" });
  await assert.rejects(
    cases.addBatch(c.id, {
      items: [
        { kind: "object", id: object },
        { kind: "observation", id: randomUUID() },
      ],
    }),
    /not found/,
  );
  assert.equal((await cases.get(c.id)).counts.items, 0);
  const r = await cases.addBatch(c.id, {
    items: [
      { kind: "object", id: object },
      { kind: "observation", id: observation },
    ],
  });
  assert.equal(r.items.length, 2);
  await cases.pin(c.id, r.items[0].id, false);
  assert.equal((await cases.get(c.id)).counts.objects, 0);
});
test("case cursor and status/tag search are deterministic", async () => {
  const a = await cases.list({ status: "all", limit: 1 });
  const b = await cases.list({
    status: "all",
    limit: 1,
    cursor: a.next_cursor,
  });
  assert.notEqual(a.items[0].id, b.items[0].id);
  await assert.rejects(cases.list({ status: "all", cursor: "!" }), /cursor/);
  assert.equal(
    (await cases.list({ q: "Updated", tag: "aviation" })).items.length,
    1,
  );
});
test("correlation snapshot uses retained version and historical lifecycle", async () => {
  const id = randomUUID(),
    early = "2026-01-01T10:00:00Z",
    late = "2026-01-01T12:00:00Z";
  await store.pool.query(
    `INSERT INTO intelligence_correlations(id,fingerprint,correlation_type,rule_id,rule_version,status,strength,related_object_ids,detected_at,created_at,last_confirmed_at,resolved_at,expires_at,window_start,window_end,geographic_context,explanation,rationale) VALUES($1::uuid,$1::text,'TEST_RISK','fixture',1,'EXPIRED','MODERATE',$2,$3,$3,$4,$4,$4,$3,$4,'{"center":{"lat":50,"lon":30}}','Potential risk only','{}')`,
    [id, [object], early, late],
  );
  await store.pool.query(
    "INSERT INTO intelligence_correlation_versions(correlation_id,recorded_at,snapshot) VALUES($1,$2,$3)",
    [
      id,
      early,
      {
        correlation_type: "TEST_RISK",
        status: "ACTIVE",
        rule_id: "fixture",
        rule_version: 1,
        expires_at: late,
        evidence: [{ provenance: prov }],
        geographic_context: { center: { lat: 50, lon: 30 } },
      },
    ],
  );
  await store.pool.query(
    "INSERT INTO intelligence_correlation_events(correlation_id,status,changed_at,reason) VALUES($1,'ACTIVE',$2,'fixture'),($1,'EXPIRED',$3,'fixture')",
    [id, early, late],
  );
  const c = await cases.create({ title: "Historical correlation" }),
    item = await cases.add(c.id, {
      kind: "correlation",
      id,
      at: "2026-01-01T11:00:00Z",
    });
  assert.equal(item.snapshot_at_add.status, "ACTIVE");
  assert.equal(item.snapshot_at_add.rule_version, 1);
  assert.equal(item.snapshot_at_add.provenance[0].provider, "fixture");
  assert.equal(
    (await cases.export(c.id, "geojson")).features[0].properties.evidence_state,
    "derived",
  );
  await cases.remove(c.id, item.id);
  assert.equal(
    (
      await store.pool.query(
        "SELECT id FROM intelligence_correlations WHERE id=$1",
        [id],
      )
    ).rowCount,
    1,
  );
});
test("timeline pages retain microsecond ordering and observation replay windows", async () => {
  const c = await cases.create({ title: "Temporal pages" });
  await cases.add(c.id, { kind: "object", id: object });
  const from = new Date(Date.now() - 300000).toISOString(),
    to = new Date().toISOString();
  await store.transaction(async (db) => {
    for (let i = 0; i < 3; i++)
      await writeObservation(db, object, {
        event_type: "POSITION",
        observed_at: new Date(Date.now() - 120000 + i).toISOString(),
        source_id: "microseconds",
        lat: 50,
        lon: 30,
        data: { i },
        provenance: prov,
      });
  });
  const rows = (
    await store.pool.query(
      "SELECT id FROM intelligence_observations WHERE source_id='microseconds' ORDER BY id",
    )
  ).rows;
  for (let i = 0; i < rows.length; i++)
    await store.pool.query(
      "UPDATE intelligence_observations SET observed_at=$2::timestamptz+($3::int*interval '1 microsecond') WHERE id=$1",
      [rows[i].id, from, i],
    );
  const seen = [],
    all = await cases.timeline(c.id, { from, to, limit: 100 });
  let cursor;
  do {
    const page = await cases.timeline(c.id, {
      from,
      to,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((r) => r.event_key));
    cursor = page.next_cursor;
    assert.ok(seen.length < 20);
  } while (cursor);
  assert.deepEqual(
    seen,
    all.items.map((r) => r.event_key),
  );
  assert.equal(new Set(seen).size, seen.length);
  const saved = await cases.add(c.id, { kind: "observation", id: rows[0].id });
  assert.ok(saved.snapshot_at_add.replay_interval.to);
  await assert.rejects(cases.timeline(c.id, { cursor: "bad" }), /cursor/);
});
test("provider filter considers every provenance entry", async () => {
  await store.pool.query(
    "UPDATE intelligence_observations SET provenance=provenance||$2::jsonb WHERE id=$1",
    [
      observation,
      JSON.stringify([{ provider: "independent-second", kind: "reported" }]),
    ],
  );
  const result = await sets.evaluate({
    kind: "observations",
    filters: [{ field: "provider", op: "eq", value: "independent-second" }],
  });
  assert.equal(result.items[0].id, observation);
});
test("air threat reports and derived analyses preserve lineage in cases", async () => {
  const { worldInput, saveWorld } = require("../../intelligence/world"),
    { AirThreatService } = require("../../intelligence/air-service");
  const at = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 2; i++) {
    const parsed = worldInput(
      {
        id: `public-report:case-event-${i}`,
        name: "Fixture reported explosion",
        provider: "Public report",
        record: {
          domain: "conflict",
          subtype: "EXPLOSION_REPORT",
          lat: 50,
          lon: 30 + i * 0.001,
          location_precision: "LOCALITY",
          geometry_precision: "representative",
          observed_at: at,
          fetched_at: at,
          properties: { provider_raw_type: "reported explosion" },
        },
      },
      false,
    );
    await store.transaction((db) => saveWorld(store, db, parsed));
  }
  const parameters = { bbox: "29,49,31,51", at },
    state = await new AirThreatService(store).state(parameters);
  assert.equal(state.clusters.length, 1);
  const c = await cases.create({ title: "Air threat evidence" }),
    cluster = await cases.analysis({
      kind: "cluster",
      parameters,
      cluster_id: state.clusters[0].id,
    });
  const item = await cases.add(c.id, cluster);
  assert.equal(item.snapshot_at_add.source_ids.length, 2);
  assert.ok(item.snapshot_at_add.model_version);
  assert.equal(item.snapshot_at_add.evidence_state, "derived");
  const acoustic = await cases.analysis({
    kind: "acoustic",
    parameters: {
      observation_id: state.reports[0].id,
      at,
      scenario: true,
      reference_db: 100,
      reference_m: 10,
      background_db: 40,
    },
  });
  const sound = await cases.add(c.id, acoustic);
  assert.ok(sound.snapshot_at_add.provenance.length);
  assert.equal(sound.snapshot_at_add.source_ids[0], state.reports[0].id);
  const report = await cases.add(c.id, {
    kind: "observation",
    id: state.reports[0].id,
  });
  assert.equal(report.snapshot_at_add.data.source_class, "PUBLIC_REPORT");
  assert.equal((await cases.graph(c.id, {})).links.length, 0);
});
test("snapshot survives canonical retention and alias merge without dangling graph", async () => {
  const [first] = await store.ingest([
    {
      type: "company",
      canonical_name: "Alias fixture",
      external_ids: [{ namespace: "test-case", value: "alias-a" }],
      provenance: prov,
    },
  ]);
  const c = await cases.create({ title: "Alias case" });
  await cases.add(c.id, { kind: "object", id: first });
  const [second] = await store.ingest([
    {
      type: "company",
      canonical_name: "Merged fixture",
      external_ids: [{ namespace: "test-case", value: "alias-b" }],
      provenance: prov,
    },
  ]);
  await store.transaction((db) => store.merge(db, second, first));
  assert.equal((await cases.graph(c.id, {})).nodes[0].id, second);
  assert.equal(
    (await cases.items(c.id, {})).items[0].snapshot_at_add.name,
    "Alias fixture",
  );
  const item = await cases.add(c.id, { kind: "observation", id: observation });
  await store.pool.query("DELETE FROM intelligence_observations WHERE id=$1", [
    observation,
  ]);
  const retained = (await cases.items(c.id, {})).items.find(
    (i) => i.id === item.id,
  );
  assert.equal(retained.observation_id, null);
  assert.equal(retained.snapshot_at_add.lat, 50);
  assert.equal(retained.snapshot_at_add.provenance[0].provider, "fixture");
});
test("snapshot references remain visible as unavailable after retention", async () => {
  const set = await sets.create({
    title: "Retained refs",
    mode: "SNAPSHOT",
    query: { kind: "observations", filters: [] },
  });
  const before = await sets.run(set.id, {});
  await store.pool.query(
    "DELETE FROM intelligence_observations WHERE id=ANY($1::uuid[])",
    [before.items.map((i) => i.id)],
  );
  const after = await sets.run(set.id, {});
  assert.equal(after.items.length, before.items.length);
  assert.ok(after.items.every((i) => i.unavailable));
});
test("filter abuse, body fields and secrets rejected or omitted", async () => {
  for (const q of [
    {
      kind: "objects",
      filters: Array.from({ length: 17 }, () => ({
        field: "type",
        op: "eq",
        value: "aircraft",
      })),
    },
    {
      kind: "objects",
      any: Array.from({ length: 7 }, () => ({
        field: "type",
        op: "eq",
        value: "aircraft",
      })),
    },
    {
      kind: "objects",
      filters: [
        {
          field: "properties.magnitude",
          op: "range",
          value: [1, "pg_sleep(20)"],
        },
      ],
    },
    { kind: "objects", sql: "SELECT * FROM secret" },
  ])
    assert.throws(() => validateQuery(q));
  await assert.rejects(
    cases.create({ title: "Bad", owner_sql: "anything" }),
    /Unknown field/,
  );
  const { snapshot } = require("../../investigations/model");
  assert.deepEqual(
    snapshot({
      api_key: "secret",
      properties: { password: "secret", magnitude: 6 },
    }),
    { properties: { magnitude: 6 } },
  );
});
test("workspace HTTP validates UUIDs and never exposes arbitrary tables", async () => {
  const app = require("express")();
  app.use(
    "/investigations",
    require("../../investigations/routes").investigationRoutes(store),
  );
  app.use((e, req, res, next) =>
    res.status(e.status || 400).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/investigations`;
    assert.equal((await fetch(base + "/cases/bad")).status, 400);
    assert.equal((await fetch(base + "/cases/" + randomUUID())).status, 404);
    assert.equal(
      (
        await fetch(base + "/sets/evaluate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "secrets" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          base +
            "/cases/" +
            caseId +
            "/timeline?from=1900-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
        )
      ).status,
      400,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("snapshot keeps full bounded lineage and strips URL credentials", () => {
  const { snapshot } = require("../../investigations/model");
  const ids = Array.from({ length: 80 }, () => randomUUID());
  const s = snapshot({
    source_ids: ids,
    url: "https://user:secret@example.com/report?token=secret&id=record",
  });
  assert.equal(s.source_ids.length, 80);
  assert.equal(s.url, "https://example.com/report?id=record");
});

test("creation status and note reassociation are explicit rather than silently ignored", async () => {
  const c = await cases.create({
    title: "Archived at creation",
    status: "ARCHIVED",
  });
  assert.equal(c.status, "ARCHIVED");
  assert.ok(c.archived_at);
  const i = await cases.add(c.id, { kind: "object", id: object });
  const n = await cases.note(c.id, { body: "Analyst note", item_id: i.id });
  assert.equal(
    (await cases.note(c.id, { body: "Detached note", item_id: null }, n.id))
      .item_id,
    null,
  );
});
