const P = require('./air-policy.json');
const { hash } = require('./history');
const normalizeType = type => P.taxonomy.includes(type) ? type : 'CONFLICT_EVENT';
function decay(at, now) { const age = (now - (typeof at === 'number' ? at : Date.parse(at))) / 1000; if (age < 0)
    return 'FUTURE'; for (const [key, max] of Object.entries(P.decay_seconds))
    if (age < max)
        return { recent: 'RECENT', fresh: 'FRESH', aging: 'AGING', history: 'STALE' }[key]; return 'HISTORY'; }
function family(type) { return type.startsWith('HEARD_') ? 'ACOUSTIC' : ['EXPLOSION_REPORT', 'AIRSTRIKE', 'MILITARY_STRIKE', 'CONFLICT_EVENT'].includes(type) ? 'CONFLICT' : 'AIR'; }
function distance(a, b) { const rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad; return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2))); }
const located = r => Number.isFinite(r.lat) && Number.isFinite(r.lon);
// Repeated versions from one provider are one current signal; cross-provider records remain separate.
function latestReports(rows) { const seen = new Set(); return [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id)).filter(r => { const key = `${r.provider}:${r.source_record_id || r.id}:${r.type}`; if (seen.has(key))
    return false; seen.add(key); return true; }); }
function areaGeometry(rows) { const points = rows.filter(located); if (!points.length)
    return null; const step = .05, margin = rows.some(r => ['REGION', 'DISTRICT'].includes(r.precision)) ? .25 : .05; const xs = points.map(r => r.lon), ys = points.map(r => r.lat); if (Math.max(...xs) - Math.min(...xs) > 180)
    return null; const w = Math.max(-180, Math.floor((Math.min(...xs) - margin) / step) * step), e = Math.min(180, Math.ceil((Math.max(...xs) + margin) / step) * step), s = Math.max(-85, Math.floor((Math.min(...ys) - margin) / step) * step), n = Math.min(85, Math.ceil((Math.max(...ys) + margin) / step) * step); return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }; }
function diversity(rows) { const source_families = [...new Set(rows.map(r => r.source_family || r.provider))].sort(); const unique_signals = new Set(rows.map(r => r.lineage_key || `${r.provider}:${r.source_record_id || r.id}`)).size; return { source_families, unique_signals, independent_sources: rows.every(r => r.independence_verified && r.lineage_key) ? new Set(rows.map(r => r.lineage_key)).size : null, independence_note: 'Source families are not proven independent; shared lineage counts once.' }; }
function clusters(input, now) {
    const groups = [];
    for (const r of [...input].filter(r => Date.parse(r.at) <= now && now - Date.parse(r.at) < P.decay_seconds.history * 1000 && r.type !== 'ALL_CLEAR').slice(0, P.max_reports).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))) {
        const f = family(r.type);
        let group = groups.find(g => g.family === f && Date.parse(r.at) - Date.parse(g.rows[0].at) <= P.cluster_seconds * 1000 && g.rows.every(x => (r.area_ids || []).some(id => (x.area_ids || []).includes(id)) || located(r) && located(x) && distance(r, x) <= (f === 'ACOUSTIC' ? P.acoustic_cluster_km : P.cluster_km)));
        if (!group) {
            group = { family: f, rows: [] };
            groups.push(group);
        }
        group.rows.push(r);
    }
    return groups.filter(g => g.rows.length >= 2).slice(0, P.max_clusters).map(g => { const rows = g.rows, ids = rows.map(r => r.id).sort(), admin = rows.every(r => (r.area_ids || []).some(a => (rows[0].area_ids || []).includes(a))); return { id: `cluster:${hash(ids).slice(0, 24)}`, kind: g.family === 'ACOUSTIC' ? 'ACOUSTIC_REPORT_CLUSTER' : 'AIR_THREAT_CLUSTER', evidence_state: 'DERIVED', model_version: P.version, report_ids: ids, object_ids: [...new Set(rows.map(r => r.object_id))], report_count: rows.length, ...diversity(rows), official_alerts: rows.filter(r => r.source_class === 'OFFICIAL').length, from: rows[0].at, to: rows.at(-1).at, precision: [...new Set(rows.map(r => r.precision))], state: decay(rows.at(-1).at, now), match_method: admin ? 'administrative overlap' : 'bounded distance between reported locations', geometry: areaGeometry(rows), explanation: 'Recent reported activity area; not a tracked weapon position, route or forecast. Bounds are display padding, not a measured threat perimeter.', assumptions: { max_time_seconds: P.cluster_seconds, max_distance_km: g.family === 'ACOUSTIC' ? P.acoustic_cluster_km : P.cluster_km, all_pairs: true } }; });
}
function pointFeature(r, now) { const age = Math.max(0, now - Date.parse(r.at)) / 1000, weight = (P.precision[r.precision] || 0) * Math.max(0, 1 - age / P.decay_seconds.history); return { type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { id: r.id, label: r.name || r.type, type: r.type, source_class: r.source_class, age_state: decay(r.at, now), weight, rendered_as_representative_point: r.precision !== 'EXACT_SOURCE_COORDINATE' || r.data?.geometry_precision === 'representative' } }; }
function officialStatus(rows, now) { const fresh = rows.filter(r => Date.parse(r.confirmed_until) + P.official_confirmation_seconds * 1000 >= now); if (fresh.some(r => r.status === 'ACTIVE'))
    return 'ACTIVE'; return fresh.length && fresh.every(r => r.status === 'CLEAR') ? 'CLEAR' : 'UNKNOWN'; }
function coverage(providers, count) { if (!providers.some(p => p.available))
    return 'INSUFFICIENT_REPORT_COVERAGE'; return count ? 'PARTIAL' : 'NO_REPORTS_IN_AVAILABLE_SOURCES'; }
function fromObservation(o) { const d = o.data || {}, p = o.provenance?.[0] || {}, meta = p.metadata || {}; return { id: o.id, object_id: o.object_id, name: o.canonical_name, type: normalizeType(d.subtype || o.event_type), provider: p.provider || o.source_id, source_class: P.classes.includes(d.source_class) ? d.source_class : 'STRUCTURED_OSINT', provider_raw_type: d.provider_raw_type || d.raw_event_type || d.subtype || o.event_type, at: new Date(o.timeline_at).toISOString(), lat: o.lat, lon: o.lon, precision: d.location_precision || 'UNKNOWN', area_ids: Array.isArray(d.area_ids) ? d.area_ids : [], area_name: d.area_name || d.location_title || '', source_record_id: p.source_record_id || p.source_id, source_family: d.source_family || p.provider || o.source_id, lineage_key: d.original_source_id || d.canonical_source_url || p.url || null, independence_verified: meta.independence_verified === true && meta.client_supplied !== true, provenance: o.provenance, data: d, observation: o }; }
module.exports = { P, normalizeType, decay, family, distance, located, latestReports, areaGeometry, diversity, clusters, pointFeature, officialStatus, coverage, fromObservation };
