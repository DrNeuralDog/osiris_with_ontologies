const { createHash } = require('node:crypto');
const M = require('./model');

/** An observation records a report at a time; a map coordinate alone is not an observation. */
async function recordObservation(store, raw) {
  M.check(raw && typeof raw === 'object', 'Observation required');
  const object = await store.get(M.uuid(raw.object_id));
  const lat = raw.lat, lon = raw.lon;
  M.check(typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 && typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180, 'Invalid observation coordinates');
  const observed_at = M.timestamp(raw.observed_at); M.check(observed_at, 'Observation time required');
  const provenance = M.provenance({ ...raw.provenance, observed_at });
  const key = createHash('sha256').update(JSON.stringify([object.id, lat, lon, observed_at, provenance.provider, provenance.source_id])).digest('hex');
  const point = `${lat},${lon}`;
  return store.transaction(async db => {
    const observation = await store.putObject(db, { type: 'observation', canonical_name: `${object.canonical_name} @ ${observed_at}`, external_ids: [{ namespace: 'observation', value: key }], properties: { lat, lon, observed_at }, provenance: [provenance] });
    const location = await store.putObject(db, { type: 'location', canonical_name: `WGS84 ${point}`, external_ids: [{ namespace: 'wgs84', value: point }], properties: { lat, lon, coordinate_system: 'WGS84' }, provenance: [provenance] });
    await store.putLink(db, { source_object_id: object.id, target_object_id: observation, link_type: 'OBSERVED_AT', valid_from: observed_at, valid_to: observed_at, confidence: provenance.confidence, provenance: [provenance] });
    await store.putLink(db, { source_object_id: observation, target_object_id: location, link_type: 'LOCATED_IN', confidence: provenance.confidence, provenance: [provenance] });
    return { observation_id: observation, location_id: location, object_id: object.id };
  });
}
module.exports = { recordObservation };
