// Version only changed rule output/evidence, not every worker heartbeat.
async function retainCorrelation(db,id,at){
 await db.query(`WITH current AS (SELECT c.id,(to_jsonb(c)-'last_confirmed_at'-'evaluation_count') || jsonb_build_object('evidence',COALESCE((SELECT jsonb_agg(e.snapshot ORDER BY e.ordinal) FROM intelligence_correlation_evidence e WHERE e.correlation_id=c.id),'[]'::jsonb)) snapshot FROM intelligence_correlations c WHERE c.id=$1)
 INSERT INTO intelligence_correlation_versions(correlation_id,recorded_at,snapshot)
 SELECT id,$2,snapshot FROM current WHERE snapshot IS DISTINCT FROM (SELECT snapshot FROM intelligence_correlation_versions WHERE correlation_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1)`,[id,at]);
}
module.exports={retainCorrelation};
