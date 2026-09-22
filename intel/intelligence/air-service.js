const M = require('../ontology/model');
const A = require('./air-core');
const { query: timelineQuery } = require('./timeline');
const { hash } = require('./history');
const { audibility } = require('./air-acoustic');
const { SourceHealth } = require('./health');
function query(raw = {}) {
    for (const [k, v] of Object.entries(raw))
        M.check(['at', 'bbox', 'admin', 'limit'].includes(k) && typeof v === 'string' && v.length <= 200, 'Invalid awareness query');
    const q = timelineQuery({ at: raw.at || new Date().toISOString(), ...(raw.bbox ? { bbox: raw.bbox } : {}), limit: raw.limit || '500' });
    M.check(q.limit <= A.P.max_reports, 'Awareness limit exceeded');
    if (q.bbox)
        M.check(q.bbox[0] < q.bbox[2] && q.bbox[2] - q.bbox[0] <= A.P.max_aoi_degrees && q.bbox[3] - q.bbox[1] <= A.P.max_aoi_degrees, 'AOI must be <=30 degrees, without antimeridian crossing');
    const admin = raw.admin || null;
    M.check(!admin || /^[a-z0-9-]+:[\w:.-]{1,100}$/i.test(admin), 'Invalid administrative identity');
    M.check(q.bbox || admin, 'Choose a viewport or administrative AOI');
    return { ...q, admin };
}
async function confirmOfficial(db, id, observation, parsed) {
    const d = parsed.event.data;
    if (d.source_class !== 'OFFICIAL' || !d.official_relay_verified)
        return;
    const at = parsed.event.fetched_at, ps = parsed.object.provenance[0], status = d.alert_status === 'CLEAR' ? 'CLEAR' : d.alert_status === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN', areas = d.area_ids || [];
    const signature = hash([status, d.subtype, d.threat_types, d.provider_raw_type]);
    const old = (await db.query('SELECT * FROM intelligence_official_alert_states WHERE object_id=$1 ORDER BY valid_from DESC,id DESC LIMIT 1 FOR UPDATE', [id])).rows[0];
    if (old && old.signature === signature && Date.parse(at) - Date.parse(old.confirmed_until) <= A.P.official_confirmation_seconds * 1000) {
        await db.query('UPDATE intelligence_official_alert_states SET confirmed_until=GREATEST(confirmed_until,$2) WHERE id=$1', [old.id, at]);
        return;
    }
    // Confirmation time is distinct from the provider's original source time. Gaps stay gaps.
    await db.query('INSERT INTO intelligence_official_alert_states(object_id,observation_id,provider,area_ids,status,signature,valid_from,confirmed_until,source_time) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)', [id, observation.id, ps.provider, areas, status, signature, at, ps.observed_at]);
}
class AirThreatService {
    constructor(store) { this.store = store; this.cache = new Map(); this.health = new SourceHealth(store); }
    async state(raw) {
        const q = query(raw), key = JSON.stringify([raw, raw.at || Math.floor(Date.now() / 10000)]), saved = this.cache.get(key);
        if (saved && saved.until > Date.now())
            return saved.value;
        const healthRows = await this.health.list({ limit: '30', scope: 'all', ids:['feed:news','world:gdelt-conflict','world:war-tracker','world:alerts-in-ua','world:ukrainealarm','world:israel-hfc','world:detector-aero','world:acled','world:ucdp'] });
        const value = await this.store.transaction(async (db) => {
            await db.query("SET LOCAL statement_timeout='4000ms'");
            const b = q.bbox || [0, 0, 0, 0];
            const candidates = (await db.query(`WITH rows AS (SELECT s.*,o.canonical_name FROM intelligence_observations s JOIN ontology_objects o ON o.id=s.object_id
   WHERE s.event_type IN ('CONFLICT_REPORT','HEARD_EXPLOSION','OFFICIAL_ALERT') AND s.timeline_at BETWEEN $1 AND $2
   AND (($3::boolean AND s.geo <@ box(point($4,$5),point($6,$7))) OR ($8::text IS NOT NULL AND s.data->'area_ids' ? $8))
   ORDER BY s.timeline_at DESC,s.id DESC LIMIT $9), sized AS (SELECT rows.*,sum(octet_length(to_jsonb(rows)::text)) OVER(ORDER BY timeline_at DESC,id DESC) bytes FROM rows)
   SELECT CASE WHEN bytes<=4194304 THEN to_jsonb(sized)-'bytes' ELSE NULL END payload FROM sized ORDER BY timeline_at DESC,id DESC`, [q.from, q.at, !!q.bbox, ...b, q.admin, q.limit + 1])).rows;
            const reports = A.latestReports(candidates.filter(r => r.payload).slice(0, q.limit).map(r => A.fromObservation(r.payload)));
            const states = q.admin ? (await db.query(`SELECT DISTINCT ON(v.object_id) v.*,o.canonical_name,s.data,s.provenance,s.lat,s.lon FROM intelligence_official_alert_states v JOIN ontology_objects o ON o.id=v.object_id LEFT JOIN intelligence_observations s ON s.id=v.observation_id
   WHERE v.area_ids @> ARRAY[$1]::text[] AND v.valid_from<=$2 AND v.confirmed_until >= $2::timestamptz-interval '6 minutes' ORDER BY v.object_id,v.valid_from DESC,v.id DESC LIMIT 201`, [q.admin, q.at])).rows : [];
            const official = states.slice(0, 200).map(s => ({ ...s, valid_from: s.valid_from.toISOString(), confirmed_until: s.confirmed_until.toISOString() }));
            const providers = healthRows.items.filter(p => ['feed:news', 'world:gdelt-conflict', 'world:war-tracker', 'world:alerts-in-ua', 'world:ukrainealarm', 'world:israel-hfc', 'world:detector-aero', 'world:acled', 'world:ucdp'].includes(p.id) || p.id.startsWith('official:')).map(p => ({ id: p.id, name: p.name, status: p.status, credential_state: p.credential_state, metadata: p.coverage_metadata, available: ['HEALTHY', 'DEGRADED'].includes(p.status) && p.enabled !== false, latest_update: p.last_success_at }));
            const now = Date.parse(q.at), derived = A.clusters(reports, now), classes = { OFFICIAL: 0, STRUCTURED_OSINT: 0, PUBLIC_REPORT: 0 };
            for (const r of reports)
                if (r.source_class in classes)
                    classes[r.source_class]++;
            const points = reports.filter(A.located).map(r => A.pointFeature(r, now));
            for (const point of points) {
                const c = derived.find(c => c.report_ids.includes(point.properties.id));
                point.properties.weight *= c ? Math.min(1.5, 1 + .1 * (c.source_families.length - 1)) / Math.max(1, c.report_count / c.unique_signals) : 1;
            }
            return { at: q.at, range: { from: q.from, to: q.at }, reports, clusters: derived, official, official_status: A.officialStatus(official, now), providers, coverage: raw.at ? (reports.length ? 'PARTIAL_RETAINED_HISTORY' : 'HISTORICAL_COVERAGE_UNKNOWN') : A.coverage(providers.filter(p => q.bbox || p.id === 'world:' + q.admin.split(':')[0] || p.id === 'official:' + q.admin.split(':')[0]), reports.length), coverage_gaps: ['Provider coverage is not complete or independently audited.', 'Official area matching requires an exact provider administrative ID; a viewport cannot imply coverage.', 'Public warning extraction is conservative; unclassified news remains in Live Alerts.'], provider_health_basis: raw.at ? 'CURRENT_HEALTH_NOT_HISTORICAL' : 'CURRENT', truncated: candidates.length > q.limit || candidates.some(r => !r.payload) || states.length > 200, counts: { last15: reports.filter(r => now - Date.parse(r.at) < 900000).length, last30: reports.filter(r => now - Date.parse(r.at) < 1800000).length, last60: reports.filter(r => now - Date.parse(r.at) < 3600000).length, acoustic: reports.filter(r => r.type.startsWith('HEARD_')).length, official_active: official.filter(s => s.status === 'ACTIVE').length, clusters: derived.length, classes }, features: { type: 'FeatureCollection', features: points }, policy: A.P };
        });
        if (this.cache.size >= 20)
            this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { value, until: Date.now() + 10000 });
        return value;
    }
    async areas() { return { items: (await this.store.pool.query(`SELECT DISTINCT s.data->'area_ids'->>0 AS key, s.data->>'area_name' name FROM intelligence_observations s WHERE s.event_type='OFFICIAL_ALERT' AND s.data->'area_ids'->>0 IS NOT NULL AND s.timeline_at>now()-interval '90 days' ORDER BY key LIMIT 200`)).rows }; }
    async acoustic(raw) {
        M.check(raw && Object.keys(raw).every(k => ['observation_id', 'at', 'scenario', 'reference_db', 'reference_m', 'background_db'].includes(k)), 'Invalid acoustic input');
        const id = M.uuid(raw.observation_id), at = timelineQuery({ at: raw.at || new Date().toISOString() }).at;
        const r = (await this.store.pool.query("SELECT s.*,o.canonical_name FROM intelligence_observations s JOIN ontology_objects o ON o.id=s.object_id WHERE s.id=$1 AND s.timeline_at<=$2 AND s.event_type IN ('CONFLICT_REPORT','HEARD_EXPLOSION')", [id, at])).rows[0];
        if (!r)
            throw new M.InputError('Retained event not found at selected time', 404);
        const wx = r.lat == null ? null : (await this.store.pool.query("SELECT id,data,timeline_at,provenance FROM intelligence_observations WHERE event_type='WEATHER' AND timeline_at BETWEEN $1::timestamptz-interval '1 hour' AND $1 AND geo <@ box(point($2-0.2,$3-0.2),point($2+0.2,$3+0.2)) ORDER BY timeline_at DESC LIMIT 1", [at, r.lon, r.lat])).rows[0];
        return { ...audibility(A.fromObservation(r), raw, wx ? { ...wx.data, at: wx.timeline_at.toISOString() } : null, Date.parse(at)), observation_id: id, object_id: r.object_id, weather_observation_id: wx?.id || null, provenance: [...r.provenance, ...(wx?.provenance || [])] };
    }
}
module.exports = { AirThreatService, query, confirmOfficial };
