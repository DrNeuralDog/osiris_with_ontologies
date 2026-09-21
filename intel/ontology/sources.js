const { createHash, randomUUID } = require('node:crypto');
const M = require('./model');
const legacy = require('../resolvers');
const { fetchSource } = require('./fetch-source');

const SOURCE_HOSTS = new Set(['www.wikidata.org']);
async function sourceJson(url) {
  const parsed = new URL(url);
  M.check(parsed.protocol === 'https:' && SOURCE_HOSTS.has(parsed.hostname), 'Source not allowed');
  const res = await fetchSource(url, { headers: { 'User-Agent': 'OSIRIS-Ontology/1.0 (local investigation)', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }, SOURCE_HOSTS);
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return res.json();
}
const evidence = (provider, source_id, kind = 'reported', extra = {}) => ({ provider, source_id, kind, fetched_at: new Date().toISOString(), ...extra });
const qidOf = value => typeof value === 'string' && /^Q[1-9]\d*$/.test(value) ? value : null;
// This table attaches ISO identities only to the existing registration-prefix decoder.
const REG_COUNTRIES = { 'United States':'US', 'United Kingdom':'GB', France:'FR', Germany:'DE', Italy:'IT', Japan:'JP', 'South Korea':'KR', China:'CN', India:'IN', Turkey:'TR', Russia:'RU', Ukraine:'UA', UAE:'AE', Qatar:'QA', Singapore:'SG', Australia:'AU', Canada:'CA', Brazil:'BR', Spain:'ES', Philippines:'PH', Thailand:'TH', Malaysia:'MY', Pakistan:'PK', Indonesia:'ID', Iran:'IR', Iraq:'IQ', 'Saudi Arabia':'SA', Israel:'IL', Greece:'GR', Austria:'AT', Switzerland:'CH', Sweden:'SE', Finland:'FI', Norway:'NO', Denmark:'DK', Netherlands:'NL', Belgium:'BE', Portugal:'PT', Poland:'PL', 'Czech Republic':'CZ', Hungary:'HU', Romania:'RO', Bulgaria:'BG', Ireland:'IE', Belarus:'BY', Estonia:'EE', Latvia:'LV', Lithuania:'LT' };
const claims = (entity, property) => (entity.claims?.[property] || []).filter(c => c.rank !== 'deprecated' && c.mainsnak?.snaktype === 'value');
const claimIds = (entity, property) => claims(entity, property).map(c => c.mainsnak.datavalue?.value?.id).filter(Boolean);
const stringClaims = (entity, property) => claims(entity, property).map(c => c.mainsnak.datavalue?.value).filter(v => typeof v === 'string');

const RELATIONS = {
  P137: ['OPERATED_BY', 'company'], P127: ['OWNED_BY', 'company'], P17: ['ASSOCIATED_WITH', 'country'],
  P159: ['HEADQUARTERED_IN', 'location'], P169: ['CEO', 'person'], P749: ['PARENT_ORG', 'company'],
  P108: ['EMPLOYED_BY', 'company'], P27: ['NATIONALITY', 'country'], P463: ['MEMBER_OF', 'organization'],
  P131: ['LOCATED_IN', 'location'], P35: ['ASSOCIATED_WITH', 'person'], P36: ['ASSOCIATED_WITH', 'location'], P47: ['ASSOCIATED_WITH', 'country'],
};
function entityType(entity, fallback = 'organization') {
  const instances = claimIds(entity, 'P31');
  if (instances.includes('Q5')) return 'person';
  if (instances.some(i => ['Q6256', 'Q3624078'].includes(i))) return 'country';
  if (instances.some(i => ['Q4830453', 'Q6881511', 'Q891723', 'Q46970'].includes(i))) return 'company';
  if (instances.some(i => ['Q515', 'Q486972'].includes(i))) return 'location';
  return fallback;
}
async function getEntities(ids) {
  if (!ids.length) return {};
  const params = new URLSearchParams({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|descriptions|claims', languages: 'en|ru', format: 'json' });
  return (await sourceJson(`https://www.wikidata.org/w/api.php?${params}`)).entities || {};
}
async function countryQid(iso, name) {
  iso = M.identifier('iso3166', iso).value;
  try {
    const rows = await legacy.sparql(`SELECT ?item WHERE { ?item wdt:P297 "${iso}" } LIMIT 2`);
    if (rows.length === 1) return rows[0].item?.value?.match(/\/(Q[1-9]\d*)$/)?.[1];
  } catch { /* SPARQL and the entity API have independent availability. */ }
  const params = new URLSearchParams({action:'wbsearchentities',search:name,language:'en',limit:'5',format:'json'});
  const candidates = (await sourceJson(`https://www.wikidata.org/w/api.php?${params}`)).search || [];
  const entities = await getEntities(candidates.map(c => c.id).filter(qidOf));
  // A matching name is only a candidate; ISO 3166 is the identity evidence.
  const matches = Object.values(entities).filter(e => stringClaims(e,'P297').includes(iso));
  return matches.length === 1 ? matches[0].id : undefined;
}
function wdObject(entity, fallback) {
  const ids = [{ namespace: 'wikidata', value: entity.id }];
  const type = entityType(entity, fallback);
  const fields = { aircraft: { P426: 'registration' }, vessel: { P458: 'imo', P587: 'mmsi' }, country: { P297: 'iso3166' } }[type] || {};
  for (const [property, namespace] of Object.entries(fields)) for (const value of stringClaims(entity, property)) {
    try { ids.push(M.identifier(namespace, value)); } catch { /* malformed upstream identifier is not an identity assertion */ }
  }
  return { type, canonical_name: entity.labels?.en?.value || entity.labels?.ru?.value || entity.id, external_ids: ids,
    properties: { description: entity.descriptions?.en?.value || '', wikidata: entity.id },
    provenance: [evidence('Wikidata', entity.id, 'reported', { url: `https://www.wikidata.org/wiki/${entity.id}`, metadata: { revision: entity.lastrevid || null } })] };
}
function qualifierTime(claim, property) {
  const value = claim.qualifiers?.[property]?.[0]?.datavalue?.value;
  if (!value?.time || value.precision < 11) return null; // do not invent day precision for year-only dates
  const time = value.time.replace(/^\+/, '');
  return Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
}
async function nameCandidates(type, id, root) {
  const graph = {objects:[root],links:[],warnings:['Name matches are candidates. Select the correct Wikidata object to investigate it.']};
  const params = new URLSearchParams({action:'wbsearchentities',search:id,language:'en',limit:'5',format:'json'});
  const candidates = (await sourceJson(`https://www.wikidata.org/w/api.php?${params}`)).search || [];
  const valid = candidates.filter(c => qidOf(c.id));
  const entities = await getEntities(valid.map(c => c.id));
  for (const c of valid) {
    const candidate = entities[c.id]; if (!candidate || 'missing' in candidate) continue;
    graph.objects.push({...wdObject(candidate,type),properties:{description:c.description || '',identity_status:'candidate'}});
    graph.links.push({source:0,target:graph.objects.length-1,link_type:'ASSOCIATED_WITH',confidence:null,
      properties:{candidate:true,warning:'Name search candidate, not a confirmed identity match.'},
      provenance:[evidence('OSIRIS resolution',id,'inferred',{metadata:{method:'name search',confirmed_identity:false}})]});
  }
  return graph;
}
async function wikidataGraph(qid, fallback) {
  const entity = (await getEntities([qid]))[qid];
  if (!entity || 'missing' in entity) throw new M.InputError('Wikidata object not found', 404);
  const selected = [];
  for (const [property, [type, targetType]] of Object.entries(RELATIONS)) {
    for (const claim of claims(entity, property)) {
      const target = claim.mainsnak.datavalue?.value?.id;
      if (qidOf(target)) selected.push({ property, type, targetType, claim, target });
    }
  }
  const targets = [...new Set(selected.map(s => s.target))].slice(0, 40);
  const entities = await getEntities(targets);
  const objects = [wdObject(entity, fallback)], indices = new Map([[qid, 0]]), links = [];
  for (const s of selected.slice(0, 100)) {
    const e = entities[s.target]; if (!e || 'missing' in e) continue;
    if (!indices.has(s.target)) { indices.set(s.target, objects.length); objects.push(wdObject(e, s.targetType)); }
    links.push({ source: 0, target: indices.get(s.target), link_type: s.type, confidence: null,
      valid_from: qualifierTime(s.claim, 'P580'), valid_to: qualifierTime(s.claim, 'P582'),
      properties: { wikidata_property: s.property, rank: s.claim.rank },
      provenance: [evidence('Wikidata', s.claim.id || `${qid}:${s.property}:${s.target}`, 'reported', { url: `https://www.wikidata.org/wiki/${qid}`, metadata: { property: s.property, references: s.claim.references || [], qualifiers: s.claim.qualifiers || {} } })] });
  }
  return { objects, links, warnings: selected.length > links.length ? ['Wikidata results are bounded; some relationships may be omitted.'] : [] };
}

// Legacy graph adapter: preserve the old response, but keep uncertain matches separate.
function legacyGraph(type, id, result, root) {
  const objects = [root], indices = new Map([[`${type}:${id}`, 0]]), links = [];
  const assertionKey = root.external_ids.length ? root.external_ids.map(i => `${i.namespace}:${i.value}`).sort().join('|') : randomUUID();
  const labels = { 'OPERATED BY': 'OPERATED_BY', 'OWNED BY': 'OWNED_BY', 'REGISTERED IN': 'REGISTERED_IN', 'FLAG STATE': 'REGISTERED_IN', HEADQUARTERED: 'ASSOCIATED_WITH', CEO: 'CEO', 'PARENT ORG': 'PARENT_ORG', EMPLOYER: 'EMPLOYED_BY', NATIONALITY: 'NATIONALITY', 'MEMBER OF': 'MEMBER_OF', LOCATED_IN: 'LOCATED_IN', GEOLOCATED: 'LOCATED_IN', 'SANCTIONS MATCH': 'SANCTIONS_MATCH' };
  for (const n of result.nodes) {
    if (n.id === `${type}:${id}`) {
      root.properties = { ...root.properties, ...n.properties };
      root.provenance.push(evidence(n.properties?.source || 'legacy-resolver', id, 'reported', { metadata: { properties: n.properties || {} } }));
      continue;
    }
    const p = n.properties || {}, provider = p.source || (n.type === 'sanction' ? 'OpenSanctions' : 'legacy-resolver');
    let objectType = n.type;
    if (n.type === 'sanction') objectType = p.schema === 'Person' ? 'person' : p.schema === 'Vessel' ? 'vessel' : 'organization';
    if (p.as_number || n.id.startsWith('ip:') && n.label.includes('/')) objectType = 'infrastructure';
    if (p.role === 'Capital' || p.lat != null) objectType = 'location';
    if (p.role === 'Abuse Contact' || p.type === 'model') objectType = 'infrastructure';
    if (p.role === 'Organization') objectType = 'organization';
    const ids = [...(n.external_ids || [])];
    if (p.as_number) ids.push(M.identifier('asn', (String(p.as_number).match(/^AS\d+/i) || [])[0] || String(p.as_number)));
    if (p.code && /^[a-z]{2}$/i.test(p.code)) ids.push(M.identifier('iso3166', p.code));
    if (provider === 'Registration prefix' && REG_COUNTRIES[n.label]) ids.push(M.identifier('iso3166', REG_COUNTRIES[n.label]));
    if (n.type === 'sanction') ids.push({ namespace: 'opensanctions', value: n.id.slice('sanction:'.length) });
    // A source/name alone is not a global identity. Scope legacy records to this source assertion.
    if (!ids.length) ids.push({ namespace: 'legacy-record', value: createHash('sha256').update(`${assertionKey}|${provider}|${n.id}`).digest('hex') });
    indices.set(n.id, objects.length);
    objects.push({ type: M.OBJECT_TYPES.includes(objectType) ? objectType : 'event', canonical_name: n.label, external_ids: ids, properties: { ...p, identity_status: n.external_ids?.length || p.as_number || p.code || n.type === 'sanction' ? 'identified' : 'source_record' },
      provenance: [evidence(provider, n.type === 'sanction' ? n.id.slice(9) : n.id, 'reported', { url: n.type === 'sanction' ? `https://www.opensanctions.org/entities/${encodeURIComponent(n.id.slice(9))}/` : undefined })] });
  }
  for (const l of result.links) {
    const source = indices.get(l.source), target = indices.get(l.target);
    if (source === undefined || target === undefined) continue;
    const kind = l.label === 'SANCTIONS MATCH' || type === 'aircraft' && source === 0 ? 'inferred' : 'reported';
    const provider = objects[target].provenance[0].provider;
    const link_type = labels[l.label] || 'ASSOCIATED_WITH';
    links.push({ source, target, link_type, confidence: kind === 'inferred' ? 0.5 : null,
      properties: { original_relationship: l.label, ...(kind === 'inferred' ? { warning: 'Candidate based on name, callsign or registration prefix; verify independently.' } : {}) },
      provenance: [evidence(provider, `${type}:${id}:${l.label}`, kind, { confidence: kind === 'inferred' ? 0.5 : null, metadata: { method: kind === 'inferred' ? 'legacy heuristic' : 'source report' } })] });
  }
  if (result.fetched_at) {
    for (const object of objects.slice(1)) for (const p of object.provenance) p.fetched_at = result.fetched_at;
    for (const link of links) for (const p of link.provenance) p.fetched_at = result.fetched_at;
  }
  return { objects, links, warnings: result.warnings || [] };
}

function resolveInput(raw) {
  M.check(raw && typeof raw === 'object', 'Resolve input required');
  const type = M.objectType(raw.type), id = M.text(raw.id, 'id');
  const external_ids = [];
  for (const namespace of ['icao24', 'registration', 'imo', 'mmsi', 'wikidata', 'iso3166', 'asn']) if (raw[namespace]) external_ids.push(M.identifier(namespace, raw[namespace]));
  if (type === 'ip') external_ids.push(M.identifier('ip', id));
  if (qidOf(id)) external_ids.push(M.identifier('wikidata', id));
  if (!raw.provider && type === 'aircraft' && /^[a-f\d]{6}$/i.test(id) && !raw.icao24) external_ids.push(M.identifier('icao24', id));
  if (!raw.provider && type === 'vessel' && /^\d{9}$/.test(id) && !raw.mmsi) external_ids.push(M.identifier('mmsi', id));
  if (!raw.provider && type === 'vessel' && /^\d{7}$/.test(id) && !raw.imo) external_ids.push(M.identifier('imo', id));
  if (raw.source_id) external_ids.push(M.identifier(`source:${M.text(raw.provider, 'provider', 60).toLowerCase()}:${type}`, raw.source_id));
  const root = { type, canonical_name: raw.name ? M.text(raw.name, 'name', 300) : id, external_ids, properties: { ...(raw.model ? { model: M.text(raw.model, 'model') } : {}), ...(raw.callsign ? { callsign: M.text(raw.callsign, 'callsign') } : {}), identity_status: external_ids.length ? 'identified' : 'unresolved' }, provenance: [evidence(raw.provider ? M.text(raw.provider, 'provider', 100) : 'OSIRIS user selection', raw.source_id || id, 'reported')] };
  return { type, id, root };
}
class OntologyService {
  constructor(store) { this.store = store; this.inflight = new Map(); this.lastExpanded = new Map(); }
  async resolve(raw) {
    const { type, id, root } = resolveInput(raw);
    let graph = { objects: [root], links: [] }, warnings = [];
    let qid = root.external_ids.find(i => i.namespace === 'wikidata')?.value;
    try {
      const iso = root.external_ids.find(i => i.namespace === 'iso3166')?.value;
      if (!qid && type === 'country' && iso) {
        qid = await countryQid(iso, root.canonical_name);
      }
      if (qid) graph = await wikidataGraph(qid, type);
      else if (['aircraft', 'ip', 'vessel'].includes(type) && root.external_ids.length) {
        const lookup = type === 'aircraft' ? raw.callsign || id : id;
        graph = legacyGraph(type, lookup, await legacy.resolveLegacy(type, type === 'ip' ? lookup : legacy.sanitizeId(lookup), raw), root);
      } else {
        // A free-text query creates candidates, never silently adopts the first search hit.
        graph = await nameCandidates(type, id, root);
      }
    } catch (e) {
      if (e instanceof M.InputError) throw e;
      warnings.push('External source unavailable; showing persisted information.');
      console.warn('[ontology] source unavailable:', e.message);
    }
    if (qid) {
      graph.objects[0].external_ids.push(...root.external_ids);
      graph.objects[0].properties = { ...root.properties, ...graph.objects[0].properties };
      for (const match of legacy.sanctionsSearch(graph.objects[0].canonical_name)) {
        const target = graph.objects.length;
        graph.objects.push({ type: match.schema === 'Person' ? 'person' : match.schema === 'Vessel' ? 'vessel' : 'organization', canonical_name: match.name,
          external_ids: [{ namespace: 'opensanctions', value: match.id }], properties: { schema: match.schema, programs: match.programs, countries: match.countries, identity_status: 'sanctions_candidate' },
          provenance: [evidence('OpenSanctions', match.id, 'reported', { fetched_at: new Date(legacy.getStats().sanctions_loaded_at).toISOString(), url: `https://www.opensanctions.org/entities/${encodeURIComponent(match.id)}/` })] });
        graph.links.push({ source: 0, target, link_type: 'SANCTIONS_MATCH', confidence: 0.5, properties: { candidate: true, warning: 'Name match only; this does not establish sanctions status.' }, provenance: [evidence('OSIRIS sanctions matching', match.id, 'inferred', { confidence: 0.5, metadata: { method: 'name or alias match', confirmed_identity: false } })] });
      }
    }
    if (!legacy.getStats().sanctions_loaded_at) warnings.push('Sanctions index unavailable; no sanctions conclusion can be drawn.');
    const ids = await this.store.ingest(graph.objects, graph.links);
    return { ...await this.store.graph(ids[0]), warnings: [...warnings, ...(graph.warnings || [])] };
  }
  async expand(id) {
    const object = await this.store.get(id);
    if (this.inflight.has(object.id)) return this.inflight.get(object.id);
    if (Date.now() - (this.lastExpanded.get(object.id) || 0) < 60000) return this.store.graph(object.id);
    M.check(this.inflight.size < 4, 'Expansion capacity reached; retry shortly');
    const work = (async () => {
      const ids = Object.fromEntries(object.external_ids.map(i => [i.namespace, i.value]));
      let result;
      if (ids.wikidata || ids.iso3166 || ['aircraft', 'vessel', 'ip'].includes(object.type) && (ids.icao24 || ids.registration || ids.imo || ids.mmsi || ids.ip)) {
        result = await this.resolve({ type: object.type, id: ids.wikidata || ids.ip || ids.icao24 || ids.imo || ids.mmsi || object.canonical_name, ...ids, callsign: object.properties.callsign, model: object.properties.model });
      } else if (['source_record','unresolved','sanctions_candidate'].includes(object.properties.identity_status)) {
        try {
          const graph = await nameCandidates(object.type, object.canonical_name, object);
          // Keep the selected UUID, including name-only roots without external identifiers.
          await this.store.transaction(async db => {
            const resolved = [object.id];
            for (const candidate of graph.objects.slice(1)) resolved.push(await this.store.putObject(db,candidate));
            for (const link of graph.links) await this.store.putLink(db,{...link,source_object_id:object.id,target_object_id:resolved[link.target]});
          });
          result = graph;
        } catch (error) {
          if (error instanceof M.InputError) throw error;
          result = {warnings:['External source unavailable; showing persisted information.']};
        }
      }
      if (this.lastExpanded.size >= 1000) this.lastExpanded.delete(this.lastExpanded.keys().next().value);
      this.lastExpanded.set(object.id, Date.now());
      return { ...await this.store.graph(object.id), warnings: result?.warnings || [] };
    })().finally(() => this.inflight.delete(object.id));
    this.inflight.set(object.id, work); return work;
  }
  async persistLegacy(type, id, props, result) {
    const { root } = resolveInput({ type, id, ...props });
    const graph = legacyGraph(type, id, result, root);
    // Legacy name-based relationships remain explicitly uncertain.
    if (!root.external_ids.length) for (const l of graph.links) l.provenance = l.provenance.map(p => ({ ...p, kind: 'inferred', confidence: 0.5, metadata: { method: 'legacy name search', confirmed_identity: false } }));
    return (await this.store.ingest(graph.objects, graph.links))[0];
  }
}
module.exports = { OntologyService, resolveInput, legacyGraph, wikidataGraph, wdObject, evidence, countryQid };
