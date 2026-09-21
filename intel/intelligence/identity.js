const {hash}=require('./history');
/** Carry temporal identity through V1's canonical object merge, without losing evidence. */
async function mergeIntelligence(db,canonical,duplicate){
 await db.query('SELECT pg_advisory_xact_lock(782341004)');
 const history=(await db.query('SELECT * FROM intelligence_observations WHERE object_id=$1',[duplicate])).rows;
 for(const o of history){
  const fingerprint=hash([canonical,o.event_type,o.observed_at?.toISOString()||null,o.dedup_key,o.lat,o.lon,o.data,o.provenance.map(p=>[p.provider,p.source_id,p.source_record_id,p.kind])]);
  const exists=(await db.query('SELECT id FROM intelligence_observations WHERE fingerprint=$1',[fingerprint])).rows[0];
  if(exists){await db.query('UPDATE intelligence_correlation_evidence SET observation_id=$1 WHERE observation_id=$2',[exists.id,o.id]);await db.query('DELETE FROM intelligence_observations WHERE id=$1',[o.id]);}
  else await db.query('UPDATE intelligence_observations SET object_id=$1,fingerprint=$2 WHERE id=$3',[canonical,fingerprint,o.id]);
 }
 await db.query(`INSERT INTO intelligence_object_locations(object_id,kind,name,lat,lon,observed_at,fetched_at,provenance)
  SELECT $1,kind,name,lat,lon,observed_at,fetched_at,provenance FROM intelligence_object_locations WHERE object_id=$2
  ON CONFLICT(object_id) DO UPDATE SET lat=excluded.lat,lon=excluded.lon,observed_at=excluded.observed_at,fetched_at=excluded.fetched_at,provenance=excluded.provenance
  WHERE COALESCE(excluded.observed_at,excluded.fetched_at)>COALESCE(intelligence_object_locations.observed_at,intelligence_object_locations.fetched_at)`,[canonical,duplicate]);
 await db.query('DELETE FROM intelligence_object_locations WHERE object_id=$1',[duplicate]);
 const correlations=(await db.query('SELECT * FROM intelligence_correlations WHERE $1=ANY(related_object_ids)',[duplicate])).rows;
 for(const c of correlations){
  const ids=c.related_object_ids.map(id=>id===duplicate?canonical:id),fingerprint=hash([c.correlation_type,c.rule_version,ids[0],ids[1]]);
  const collision=(await db.query('SELECT id FROM intelligence_correlations WHERE fingerprint=$1 AND id<>$2',[fingerprint,c.id])).rows[0];
  if(collision||ids[0]===ids[1]){
   await db.query("UPDATE intelligence_correlations SET status='EXPIRED',resolved_at=now(),fingerprint=$2,related_object_ids=$3 WHERE id=$1",[c.id,`merged:${c.id}`,[...new Set(ids)]]);
   await db.query("INSERT INTO intelligence_correlation_events(correlation_id,status,changed_at,reason) VALUES($1,'EXPIRED',now(),$2)",[c.id,collision?`Canonical identity merged; current correlation ${collision.id}. Historical evidence retained.`:'Canonical identities collapsed to the same object; correlation withdrawn.']);
  }else await db.query('UPDATE intelligence_correlations SET fingerprint=$2,related_object_ids=$3 WHERE id=$1',[c.id,fingerprint,[...new Set(ids)]]);
 }
 // Snapshots retain their original observation/source identity; the canonical object reference follows the merge.
 await db.query("UPDATE intelligence_correlation_evidence SET snapshot=jsonb_set(snapshot,'{object_id}',to_jsonb($1::text)) WHERE snapshot->>'object_id'=$2",[canonical,duplicate]);
}
module.exports={mergeIntelligence};
