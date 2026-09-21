const { isIP } = require('node:net');

const OBJECT_TYPES = ['aircraft', 'vessel', 'company', 'person', 'country', 'ip', 'location', 'organization', 'event', 'observation', 'infrastructure', 'domain', 'satellite', 'airport', 'port'];
const LINK_TYPES = ['OPERATED_BY', 'OWNED_BY', 'REGISTERED_IN', 'HEADQUARTERED_IN', 'CEO', 'PARENT_ORG', 'EMPLOYED_BY', 'NATIONALITY', 'MEMBER_OF', 'LOCATED_IN', 'OBSERVED_AT', 'ASSOCIATED_WITH', 'SANCTIONS_MATCH'];
class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function check(ok, message) { if (!ok) throw new InputError(message); }
function text(value, name, max = 200) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value), `Invalid ${name}`);
  return value.trim();
}
function uuid(value) { check(typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value), 'Invalid object UUID'); return value; }
function objectType(value) { check(OBJECT_TYPES.includes(value), 'Invalid object type'); return value; }
function jsonObject(value = {}) { check(value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 32768, 'Invalid properties'); return value; }
function confidence(value) { if (value == null) return null; check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'Invalid confidence'); return value; }
function timestamp(value) { if (value == null) return null; check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid timestamp'); return new Date(value).toISOString(); }
function identifier(namespace, raw) {
  namespace = text(namespace, 'identifier namespace', 80).toLowerCase();
  check(/^[a-z][a-z0-9_.:-]*$/.test(namespace), 'Invalid identifier namespace');
  let value = text(raw, 'identifier', 300);
  if (namespace === 'icao24') { value = value.toLowerCase(); check(/^[0-9a-f]{6}$/.test(value), 'Invalid ICAO24'); }
  if (namespace === 'registration') { value = value.toUpperCase().replace(/[\s-]/g, ''); check(/^[A-Z0-9]{3,12}$/.test(value), 'Invalid registration'); }
  if (namespace === 'wikidata') { value = value.toUpperCase(); check(/^Q[1-9][0-9]*$/.test(value), 'Invalid Wikidata QID'); }
  if (namespace === 'imo') { value = value.replace(/^IMO\s*/i, ''); check(/^\d{7}$/.test(value), 'Invalid IMO'); }
  if (namespace === 'mmsi') check(/^\d{9}$/.test(value), 'Invalid MMSI');
  if (namespace === 'asn') { value = value.toUpperCase().replace(/^AS/, ''); check(/^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 4294967295, 'Invalid ASN'); value = `AS${Number(value)}`; }
  if (namespace === 'ip') { check(isIP(value) !== 0, 'Invalid IP'); value = isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value; }
  if (namespace === 'iso3166') { value = value.toUpperCase(); check(/^[A-Z]{2}$/.test(value), 'Invalid country code'); }
  return { namespace, value };
}
function provenance(raw) {
  check(raw && typeof raw === 'object', 'Provenance required');
  const kind = raw.kind || 'reported';
  check(['observed', 'reported', 'derived', 'inferred'].includes(kind), 'Invalid evidence kind');
  const url = raw.url == null ? null : text(raw.url, 'source URL', 2000);
  if (url) { let parsed; try { parsed = new URL(url); } catch { throw new InputError('Invalid source URL'); } check(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'Invalid source URL'); }
  return { provider: text(raw.provider, 'provider', 100), source_id: raw.source_id == null ? null : text(raw.source_id, 'source id', 500), url, observed_at: timestamp(raw.observed_at), fetched_at: timestamp(raw.fetched_at) || new Date().toISOString(), confidence: confidence(raw.confidence), kind, metadata: jsonObject(raw.metadata) };
}
function objectInput(raw) {
  check(raw && typeof raw === 'object', 'Object required');
  const external = raw.external_ids || [];
  check(Array.isArray(external) && external.length <= 32, 'Invalid external identifiers');
  const ids = external.map(i => { check(i && typeof i === 'object' && !Array.isArray(i), 'Invalid external identifier'); return identifier(i.namespace, i.value); });
  const evidence = raw.provenance;
  check(Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 32, 'Provenance required');
  return { type: objectType(raw.type), canonical_name: text(raw.canonical_name, 'canonical name', 300), external_ids: [...new Map(ids.map(i => [`${i.namespace}:${i.value}`, i])).values()], properties: jsonObject(raw.properties), provenance: evidence.map(provenance) };
}
function graphOptions(raw = {}) {
  const number = (key, fallback, min, max) => { const v = raw[key] === undefined ? fallback : raw[key]; check((typeof v === 'number' || typeof v === 'string' && /^\d+$/.test(v)) && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max, `Invalid ${key} (${min}-${max})`); return Number(v); };
  const direction = raw.direction || 'both';
  check(['both', 'out', 'in'].includes(direction), 'Invalid direction');
  return { depth: number('depth', 1, 0, 4), max_nodes: number('max_nodes', 100, 1, 250), max_edges: number('max_edges', 250, 1, 500), direction };
}
module.exports = { OBJECT_TYPES, LINK_TYPES, InputError, check, text, uuid, objectType, jsonObject, confidence, timestamp, identifier, provenance, objectInput, graphOptions };
