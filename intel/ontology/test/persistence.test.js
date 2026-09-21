const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { OntologyStore } = require('../store');
const { createApp } = require('../../server');
const { OntologyService } = require('../sources');
const legacy = require('../../resolvers');
const { recordObservation } = require('../observations');

// A real PostgreSQL schema per run: no mocks, no truncation of application data.
const schema = `ontology_test_${randomUUID().replaceAll('-', '')}`;
let admin, store, server, base;
const prov = (source = 'fixture') => [{ provider: 'ontology-test', source_id: source, kind: 'reported', confidence: 0.8, observed_at: '2026-09-21T00:00:00Z', metadata: { fixture: true } }];
const object = (id, type = 'company', extra = {}) => ({ type, canonical_name: id, external_ids: [{ namespace: 'test', value: id }], properties: { example: 'value' }, provenance: prov(id), ...extra });
const link = (source, target, type = 'ASSOCIATED_WITH') => ({ source, target, link_type: type, confidence: 0.7, provenance: prov('relationship') });
before(async () => {
  admin = new Pool(); await admin.query(`CREATE SCHEMA ${schema}`);
  store = new OntologyStore(new Pool({ options: `-c search_path=${schema},public`, max: 8, statement_timeout: 10000 }));
  await store.migrate();
  server = createApp(store).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await store?.pool.end();
  if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});

test('object, link and provenance survive another store connection and migration rerun', async () => {
  const ids = await store.ingest([object('persist-A'), object('persist-B')], [link(0, 1, 'OWNED_BY')]);
  const other = new OntologyStore(new Pool({ options: `-c search_path=${schema},public` }));
  try {
    await other.migrate(); const graph = await other.graph(ids[0]);
    assert.equal(graph.nodes.length, 2); assert.equal(graph.links[0].link_type, 'OWNED_BY');
    assert.equal(graph.nodes[0].provenance[0].provider, 'ontology-test');
    assert.equal(graph.links[0].provenance[0].kind, 'reported');
    assert.equal(graph.links[0].confidence, 0.7);
  } finally { await other.pool.end(); }
});
test('normalization and concurrent ingestion deduplicate objects and relationships', async () => {
  const objects = [object('plane', 'aircraft', { external_ids: [{ namespace: 'icao24', value: 'AB12CD' }] }), object('operator')];
  const results = await Promise.all(Array.from({ length: 8 }, () => store.ingest(objects, [link(0, 1, 'OPERATED_BY')])));
  assert.equal(new Set(results.map(r => r[0])).size, 1);
  const graph = await store.graph(results[0][0]); assert.equal(graph.links.length, 1); assert.equal(graph.nodes.length, 2);
  assert.equal((await store.find({ namespace: 'icao24', value: 'ab12cd' }))[0].id, results[0][0]);
});
test('same names without stable ids stay separate; conflicting object types reject atomically', async () => {
  const [a, b] = await store.ingest([object('same', 'person', { external_ids: [] }), object('same', 'person', { external_ids: [] })]);
  assert.notEqual(a, b);
  await assert.rejects(store.ingest([object('plane', 'person', { external_ids: [{ namespace: 'icao24', value: 'ab12cd' }] })]), /different object type/);
});
test('identifier bridge merges earlier records preserving links, evidence and old IDs', async () => {
  const [a, b, c] = await store.ingest([
    object('bridge-A', 'aircraft', { external_ids: [{ namespace: 'icao24', value: 'ff1234' }] }),
    object('bridge-B', 'aircraft', { external_ids: [{ namespace: 'registration', value: 'RA-12345' }] }), object('bridge-C'),
  ], [link(0, 2, 'OWNED_BY'), link(1, 2, 'OWNED_BY')]);
  const [merged] = await store.ingest([object('bridge', 'aircraft', { external_ids: [{ namespace: 'icao24', value: 'FF1234' }, { namespace: 'registration', value: 'ra 12345' }] })]);
  assert.equal((await store.get(a)).id, merged); assert.equal((await store.get(b)).id, merged);
  const graph = await store.graph(c); assert.equal(graph.nodes.length, 2); assert.equal(graph.links.length, 1);
  const result = await store.get(merged); assert.equal(result.external_ids.length, 2); assert.ok(result.provenance.length >= 3);
});
test('reverse traversal, depth, cycles, node and edge bounds', async () => {
  const ids = await store.ingest(['cycle-A', 'cycle-B', 'cycle-C', 'cycle-D'].map(id => object(id)), [link(0, 1), link(1, 2), link(2, 0), link(2, 3)]);
  assert.equal((await store.graph(ids[3], { direction: 'in' })).nodes.length, 2);
  assert.equal((await store.graph(ids[3], { direction: 'out' })).nodes.length, 1);
  assert.equal((await store.graph(ids[0], { depth: 0 })).nodes.length, 1);
  assert.equal((await store.graph(ids[0], { depth: 4 })).nodes.length, 4);
  const limited = await store.graph(ids[0], { depth: 4, max_nodes: 2, max_edges: 1 });
  assert.ok(limited.nodes.length <= 2 && limited.links.length <= 1); assert.equal(limited.truncated, true);
  await assert.rejects(store.graph(ids[0], { depth: 100000 }), /Invalid depth/);
});
test('time-scoped links remain distinct; repeat evidence does not grow indefinitely', async () => {
  const objects = [object('time-A'), object('time-B')];
  const dated = { ...link(0, 1), valid_from: '2025-01-01T00:00:00Z', valid_to: '2025-12-01T00:00:00Z' };
  const ids = await store.ingest(objects, [dated, { ...dated, valid_from: '2026-01-01T00:00:00Z', valid_to: null }]);
  await store.ingest(objects, [dated]);
  const graph = await store.graph(ids[0]); assert.equal(graph.links.length, 2); assert.equal(graph.links[0].provenance.length, 1);
  await assert.rejects(store.ingest(objects, [{ ...dated, valid_to: '2024-01-01T00:00:00Z' }]), /validity/);
});
test('malformed API input, unknown UUIDs, bounded limits and injection', async () => {
  for (const path of ['/ontology/objects/not-a-uuid', '/ontology/objects?limit=100000', '/ontology/objects?type=unknown', '/resolve?type[]=ip&id=1.1.1.1', '/resolve?type=ip&id=127.1', '/ontology/objects?namespace=wikidata&value=Q1%22']) assert.equal((await fetch(base + path)).status, 400, path);
  assert.equal((await fetch(`${base}/ontology/objects/${randomUUID()}`)).status, 404);
  const [id] = await store.ingest([object('api')]);
  for (const depth of ['100000', '-1', 'NaN', '2.5']) assert.equal((await fetch(`${base}/ontology/objects/${id}/graph?depth=${depth}`)).status, 400);
  assert.equal((await fetch(`${base}/ontology/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/ontology/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objects: [object('bad', 'company', { provenance: [] })] }) })).status, 400);
  for (const malformed of [{ objects:[object('bad-id','company',{external_ids:[null]})] }, { objects:[object('bad-link')], links:[null] }]) {
    assert.equal((await fetch(`${base}/ontology/ingest`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(malformed)})).status,400);
  }
  assert.equal((await store.find({ q: "'; DROP TABLE ontology_objects;--" })).length, 0);
  assert.equal((await store.get(id)).canonical_name, 'api');
});
test('ingestion rolls back whole graph on malformed link', async () => {
  await assert.rejects(store.ingest([object('rollback')], [link(0, 99)]), /endpoint/);
  assert.equal((await store.find({ namespace: 'test', value: 'rollback' })).length, 0);
});
test('expansion of saved object uses persisted reverse links without external calls', async () => {
  const ids = await store.ingest([object('expand-A'), object('expand-B')], [link(0, 1, 'CEO')]);
  const response = await fetch(`${base}/ontology/objects/${ids[1]}/expand`, { method: 'POST' });
  assert.equal(response.status, 200); assert.equal((await response.json()).nodes.length, 2);
});
test('legacy /resolve preserves fields, nodes/links while persisting uncertain name matches', async () => {
  const original = legacy.resolveLegacy;
  legacy.resolveLegacy = async () => ({ nodes: [{ id: 'country:Example', label: 'Example', type: 'country', properties: {} }], links: [{ source: 'company:LegacyName', target: 'country:Example', label: 'HEADQUARTERED' }] });
  try {
    const response = await fetch(`${base}/resolve?type=company&id=LegacyName`); assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.entity.id, 'LegacyName'); assert.equal(data.nodes[0].id, 'country:Example'); assert.equal(data.links[0].label, 'HEADQUARTERED');
    const graph = await store.graph(data.canonical_id); assert.equal(graph.links[0].provenance[0].kind, 'inferred');
  } finally { legacy.resolveLegacy = original; }
});
test('source outage retains stable root and returns a visible warning', async () => {
  const original = global.fetch; global.fetch = async () => { throw new Error('offline'); };
  try {
    const result = await new OntologyService(store).resolve({ type: 'person', id: 'Q999999987654' });
    assert.equal(result.nodes.length, 1); assert.ok(result.warnings.length); assert.equal(result.nodes[0].external_ids[0].value, 'Q999999987654');
  } finally { global.fetch = original; }
});
test('expanding an unresolved legacy company adds candidates without changing or duplicating its root', async () => {
  const [id] = await store.ingest([object('Airline name','company',{properties:{identity_status:'source_record'}})]);
  const original = global.fetch;
  try {
    global.fetch = async url => url.includes('wbsearchentities') ? Response.json({search:[{id:'Q123456789',description:'Candidate airline'}]}) : Response.json({entities:{Q123456789:{id:'Q123456789',labels:{en:{value:'Airline name'}},claims:{}}}});
    const service = new OntologyService(store);
    const first = await service.expand(id);
    assert.equal(first.root_id,id); assert.equal(first.nodes.length,2);
    assert.equal(first.links[0].provenance[0].kind,'inferred');
    assert.equal(first.links[0].properties.candidate,true);
    service.lastExpanded.clear();
    assert.equal((await service.expand(id)).nodes.length,2);
    assert.equal((await store.find({q:'Airline name'})).length,2);
  } finally { global.fetch = original; }
});
test('observations are time-scoped, deduplicated and preserve reported rather than invented measurement time', async () => {
  const [id] = await store.ingest([object('observed-plane', 'aircraft')]);
  const input = { object_id: id, lat: 55.75, lon: 37.61, observed_at: new Date(Date.now()-60000).toISOString(), provenance: prov('feed-row')[0] };
  const first = await recordObservation(store, input), second = await recordObservation(store, input);
  assert.equal(first.observation_id, second.observation_id);
  const graph = await store.graph(id, { depth: 2 }); assert.equal(graph.nodes.length, 1); assert.equal(graph.links.length, 0);
  const history=await new (require('../../intelligence/history').HistoryService)(store).query(id,{location_only:'true'});
  assert.equal(history.items[0].provenance[0].kind,'reported');
  await assert.rejects(recordObservation(store, { ...input, observed_at: undefined }), /time required/);
  await assert.rejects(recordObservation(store, { ...input, lat: 91 }), /coordinates/);
});
