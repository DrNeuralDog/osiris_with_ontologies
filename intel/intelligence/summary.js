const {healthState}=require('./policy');
function workerState(row,now=Date.now()) {
 if(!row)return {status:'UNKNOWN',last_cycle_at:null,last_ingestion_at:null};
 const status=!row.enabled?'STOPPED':now-new Date(row.heartbeat_at).getTime()>180000||row.last_error?'DEGRADED':'RUNNING';
 return {...row,status};
}
class IntelligenceSummary {
 constructor(store){this.store=store;this.cached=null;this.until=0;this.pending=null;}
 async get(){
  if(this.cached&&Date.now()<this.until)return this.cached;
  if(this.pending)return this.pending;
  this.pending=this.read().then(result=>{this.cached=result;this.until=Date.now()+15000;return result;}).finally(()=>{this.pending=null;});return this.pending;
 }
 async read(){
  try {
   const [counts,sources,worker,latest]=await Promise.all([
    this.store.pool.query(`SELECT (SELECT count(*)::int FROM ontology_objects) objects,(SELECT count(*)::int FROM ontology_links) relationships,
      (SELECT count(*)::int FROM intelligence_observations) observations,
      (SELECT count(*)::int FROM intelligence_correlations WHERE status='ACTIVE') active_correlations,(SELECT count(*)::int FROM intelligence_correlations WHERE status='EXPIRED') expired_correlations`),
    this.store.pool.query(`SELECT s.*,a.rate FROM intelligence_sources s LEFT JOIN LATERAL (SELECT avg(ok::int) rate FROM (SELECT ok FROM intelligence_source_samples WHERE source_id=s.id ORDER BY checked_at DESC,id DESC LIMIT 100) recent) a ON true`),
    this.store.pool.query("SELECT * FROM intelligence_worker_state WHERE id='main'"),
    this.store.pool.query("SELECT id,correlation_type,strength,last_confirmed_at FROM intelligence_correlations WHERE status='ACTIVE' ORDER BY last_confirmed_at DESC,id DESC LIMIT 1")
   ]);
   const states={HEALTHY:0,DEGRADED:0,OFFLINE:0,STALE:0,UNKNOWN:0};
   for(const s of sources.rows){let status=healthState(s);if(status==='HEALTHY'&&s.rate!=null&&Number(s.rate)<.8)status='DEGRADED';states[status]++;}
   this.cached={...counts.rows[0],sources:states,source_scope:'all',database:'HEALTHY',worker:workerState(worker.rows[0]),latest_correlation:latest.rows[0]||null,checked_at:new Date().toISOString(),cache_seconds:15};this.until=Date.now()+15000;return this.cached;
  }catch{return {database:'ERROR',worker:{status:'UNKNOWN'},sources:null,objects:null,relationships:null,observations:null,active_correlations:null,expired_correlations:null,latest_correlation:null,checked_at:new Date().toISOString()};}
 }
}
module.exports={IntelligenceSummary,workerState};
