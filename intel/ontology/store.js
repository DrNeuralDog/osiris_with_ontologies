const { randomUUID, createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const M = require('./model');

class OntologyStore {
  constructor(pool) { this.pool = pool; }
  static connect() {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 });
    pool.on('error', error => console.warn('[ontology] idle PostgreSQL connection:', error.message));
    return new OntologyStore(pool);
  }
  async transaction(work) {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
    catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async migrate() {
    await this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(782341001)');
      await db.query('CREATE TABLE IF NOT EXISTS ontology_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
      for (const file of readdirSync(join(__dirname, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
        if ((await db.query('SELECT 1 FROM ontology_migrations WHERE version=$1', [file])).rowCount) continue;
        await db.query(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
        await db.query('INSERT INTO ontology_migrations(version) VALUES($1)', [file]);
      }
      for (const type of M.OBJECT_TYPES) await db.query('INSERT INTO ontology_object_types VALUES($1) ON CONFLICT DO NOTHING', [type]);
      for (const type of M.LINK_TYPES) await db.query('INSERT INTO ontology_link_types VALUES($1) ON CONFLICT DO NOTHING', [type]);
    });
  }
  async evidence(db, objectId, linkId, evidence, snapshot) {
    for (const p of evidence) {
      const metadata = { ...p.metadata, ...(snapshot ? { properties: snapshot } : {}) };
      const fingerprint = createHash('sha256').update(JSON.stringify([p.provider, p.source_id, p.url, p.observed_at, p.confidence, p.kind, metadata])).digest('hex');
      await db.query(`INSERT INTO ontology_provenance(id,object_id,link_id,provider,source_id,url,observed_at,fetched_at,confidence,kind,metadata,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (object_id,link_id,fingerprint) DO UPDATE SET fetched_at=GREATEST(ontology_provenance.fetched_at,excluded.fetched_at)`,
      [randomUUID(), objectId, linkId, p.provider, p.source_id, p.url, p.observed_at, p.fetched_at, p.confidence, p.kind, metadata, fingerprint]);
    }
  }
  async canonical(db, id) {
    M.uuid(id);
    return (await db.query('SELECT object_id FROM ontology_aliases WHERE old_id=$1', [id])).rows[0]?.object_id || id;
  }
  async putObject(db, raw) {
    const input = M.objectInput(raw);
    // V1 serializes small ingestion transactions. No network calls occur under this lock.
    await db.query('SELECT pg_advisory_xact_lock(782341002)');
    const found = new Set();
    for (const i of input.external_ids) {
      const row = (await db.query('SELECT object_id FROM ontology_identifiers WHERE namespace=$1 AND value=$2', [i.namespace, i.value])).rows[0];
      if (row) found.add(row.object_id);
    }
    const ids = [...found].sort();
    for (const id of ids) {
      const old = (await db.query('SELECT type FROM ontology_objects WHERE id=$1', [id])).rows[0];
      // Never merge a company/person (or network/owner) merely because a source misclassified it.
      if (old.type !== input.type) throw new M.InputError('Identifier belongs to a different object type', 409);
    }
    const id = ids[0] || randomUUID();
    if (!ids.length) await db.query('INSERT INTO ontology_objects(id,type,canonical_name) VALUES($1,$2,$3)', [id, input.type, input.canonical_name]);
    for (const duplicate of ids.slice(1)) await this.merge(db, id, duplicate);
    const identifierOnlyName = input.external_ids.some(i => i.value === input.canonical_name);
    await db.query('UPDATE ontology_objects SET canonical_name=CASE WHEN $4 AND canonical_name<>$2 THEN canonical_name ELSE $2 END, properties=properties || $3::jsonb, updated_at=now() WHERE id=$1', [id, input.canonical_name, input.properties, identifierOnlyName]);
    for (const i of input.external_ids) await db.query('INSERT INTO ontology_identifiers VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, i.namespace, i.value]);
    await this.evidence(db, id, null, input.provenance, input.properties);
    return id;
  }
  async merge(db, canonical, duplicate) {
    await db.query(`UPDATE ontology_objects SET properties=(SELECT properties FROM ontology_objects WHERE id=$2) || properties WHERE id=$1`, [canonical, duplicate]);
    await db.query('UPDATE ontology_identifiers SET object_id=$1 WHERE object_id=$2', [canonical, duplicate]);
    const objectEvidence = (await db.query('SELECT * FROM ontology_provenance WHERE object_id=$1', [duplicate])).rows;
    for (const p of objectEvidence) await this.evidence(db, canonical, null, [p]);
    await db.query('DELETE FROM ontology_provenance WHERE object_id=$1', [duplicate]);
    const links = (await db.query('SELECT * FROM ontology_links WHERE source_object_id=$1 OR target_object_id=$1', [duplicate])).rows;
    for (const l of links) {
      const prov = (await db.query('SELECT * FROM ontology_provenance WHERE link_id=$1', [l.id])).rows;
      await this.putLink(db, { ...l, source_object_id: l.source_object_id === duplicate ? canonical : l.source_object_id, target_object_id: l.target_object_id === duplicate ? canonical : l.target_object_id, provenance: prov }, false);
      await db.query('DELETE FROM ontology_provenance WHERE link_id=$1', [l.id]);
      await db.query('DELETE FROM ontology_links WHERE id=$1', [l.id]);
    }
    await db.query('UPDATE ontology_aliases SET object_id=$1 WHERE object_id=$2', [canonical, duplicate]);
    await db.query('INSERT INTO ontology_aliases VALUES($1,$2) ON CONFLICT(old_id) DO UPDATE SET object_id=excluded.object_id', [duplicate, canonical]);
    await db.query('DELETE FROM ontology_objects WHERE id=$1', [duplicate]);
  }
  async putLink(db, raw, validate = true) {
    const source = await this.canonical(db, raw.source_object_id), target = await this.canonical(db, raw.target_object_id);
    M.check(M.LINK_TYPES.includes(raw.link_type), 'Invalid relationship type');
    M.check(Array.isArray(raw.provenance) && raw.provenance.length > 0 && raw.provenance.length <= 32, 'Link provenance required');
    const evidence = validate ? raw.provenance.map(M.provenance) : raw.provenance;
    const from = validate ? M.timestamp(raw.valid_from) : raw.valid_from, to = validate ? M.timestamp(raw.valid_to) : raw.valid_to;
    M.check(!from || !to || new Date(to) >= new Date(from), 'Invalid validity interval');
    if ((await db.query('SELECT id FROM ontology_objects WHERE id=ANY($1::uuid[])', [[...new Set([source, target])]])).rowCount !== new Set([source, target]).size) throw new M.InputError('Object not found', 404);
    const row = (await db.query(`INSERT INTO ontology_links(id,source_object_id,target_object_id,link_type,properties,confidence,valid_from,valid_to)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(source_object_id,target_object_id,link_type,valid_from,valid_to)
      DO UPDATE SET properties=ontology_links.properties || excluded.properties, confidence=GREATEST(ontology_links.confidence,excluded.confidence),updated_at=now() RETURNING id`,
    [randomUUID(), source, target, raw.link_type, M.jsonObject(raw.properties), M.confidence(raw.confidence), from, to])).rows[0];
    await this.evidence(db, null, row.id, evidence, raw.properties);
    return row.id;
  }
  async ingest(objects, links = []) {
    M.check(Array.isArray(objects) && objects.length > 0 && objects.length <= 100 && Array.isArray(links) && links.length <= 200, 'Invalid ingestion size');
    return this.transaction(async db => {
      const ids = [];
      for (const o of objects) ids.push(await this.putObject(db, o));
      for (const l of links) {
        M.check(l && typeof l === 'object' && !Array.isArray(l), 'Invalid link');
        M.check(Number.isInteger(l.source) && Number.isInteger(l.target) && ids[l.source] && ids[l.target], 'Invalid link endpoint');
        await this.putLink(db, { ...l, source_object_id: ids[l.source], target_object_id: ids[l.target] });
      }
      const canonical = [];
      for (const id of ids) canonical.push(await this.canonical(db, id));
      return canonical;
    });
  }
  async objects(ids, db = this.pool) {
    if (!ids.length) return [];
    return (await db.query(`SELECT o.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('namespace',namespace,'value',value) ORDER BY namespace,value) FROM ontology_identifiers i WHERE i.object_id=o.id),'[]') external_ids,
      COALESCE((SELECT jsonb_agg(p ORDER BY fetched_at DESC) FROM (SELECT provider,source_id,url,observed_at,fetched_at,confidence,kind,metadata FROM ontology_provenance WHERE object_id=o.id ORDER BY fetched_at DESC LIMIT 50) p),'[]') provenance
      FROM ontology_objects o WHERE id=ANY($1::uuid[])`, [ids])).rows;
  }
  async get(id, db = this.pool) {
    const canonical = await this.canonical(db, id);
    const object = (await this.objects([canonical], db))[0];
    if (!object) throw new M.InputError('Object not found', 404);
    return object;
  }
  async find({ q = '', type, namespace, value, limit = 30 }) {
    M.check(typeof q === 'string' && q.length <= 200, 'Invalid search');
    if (type) M.objectType(type);
    M.check(Number.isInteger(Number(limit)) && Number(limit) > 0 && Number(limit) <= 100, 'Invalid search limit');
    const i = namespace || value ? M.identifier(namespace, value) : null;
    const rows = (await this.pool.query(`SELECT o.id FROM ontology_objects o WHERE ($1::text IS NULL OR type=$1) AND
      ($2::text IS NULL OR EXISTS(SELECT 1 FROM ontology_identifiers i WHERE i.object_id=o.id AND namespace=$2 AND value=$3)) AND
      ($4='' OR strpos(lower(canonical_name),lower($4))>0) ORDER BY updated_at DESC,id LIMIT $5`, [type || null, i?.namespace || null, i?.value || null, q, Number(limit)])).rows;
    return this.objects(rows.map(r => r.id));
  }
  async graph(id, raw = {}) {
    const options = M.graphOptions(raw);
    return this.transaction(async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const root = await this.get(id, db), nodes = new Set([root.id]), links = new Map();
      let frontier = [root.id], truncated = false;
      for (let depth = 0; depth < options.depth && frontier.length; depth++) {
        const remaining = options.max_edges - links.size;
        const rows = (await db.query(`SELECT * FROM ontology_links WHERE
          (($2 IN ('both','out') AND source_object_id=ANY($1::uuid[])) OR ($2 IN ('both','in') AND target_object_id=ANY($1::uuid[])))
          AND NOT(id=ANY($3::uuid[])) ORDER BY id LIMIT $4`, [frontier, options.direction, [...links.keys()], remaining + 1])).rows;
        const next = [];
        for (const l of rows) {
          const missing = [...new Set([l.source_object_id, l.target_object_id])].filter(n => !nodes.has(n));
          if (links.size >= options.max_edges || nodes.size + missing.length > options.max_nodes) { truncated = true; continue; }
          links.set(l.id, l); missing.forEach(n => { nodes.add(n); next.push(n); });
        }
        frontier = next;
        if (links.size >= options.max_edges) { if (frontier.length && depth + 1 < options.depth) truncated = true; break; }
      }
      const evidence = (await db.query(`SELECT * FROM (SELECT p.*,row_number() OVER(PARTITION BY link_id ORDER BY fetched_at DESC) rn FROM ontology_provenance p WHERE link_id=ANY($1::uuid[])) ranked WHERE rn<=50`, [[...links.keys()]])).rows;
      const aliases = (await db.query('SELECT old_id,object_id FROM ontology_aliases WHERE object_id=ANY($1::uuid[])', [[...nodes]])).rows;
      return { root_id: root.id, aliases: Object.fromEntries(aliases.map(a => [a.old_id,a.object_id])), nodes: await this.objects([...nodes], db), links: [...links.values()].map(l => ({ ...l, source: l.source_object_id, target: l.target_object_id, provenance: evidence.filter(p => p.link_id === l.id) })), limits: options, truncated };
    });
  }
}
module.exports = { OntologyStore };
