const express=require('express');
const M=require('../ontology/model');
const {SourceHealth}=require('./health');
const {CorrelationEngine}=require('./correlations');
const {POLICIES}=require('./policy');
const {THRESHOLDS}=require('./rules');
const {IntelligenceSummary}=require('./summary');
const {investigate,objectContext}=require('./investigate');
const {TimelineService}=require('./timeline');
function intelligenceRoutes(store){
 const router=express.Router(),health=new SourceHealth(store),engine=new CorrelationEngine(store);
 const summary=new IntelligenceSummary(store);
 const timeline=new TimelineService(store);
 for(const action of ['state','events','coverage','chunk'])router.get(`/timeline/${action}`,async(req,res)=>res.json(await timeline[action](req.query)));
 router.use(express.json({limit:'128kb'}));
 router.get('/summary',async(req,res)=>{M.check(Object.keys(req.query).length===0,'Summary takes no query');res.json(await summary.get());});
 router.post('/investigate',async(req,res)=>res.json(await investigate(store,req.body)));
 router.get('/objects/:id/context',async(req,res)=>res.json(await objectContext(store,req.params.id)));
 router.get('/policies',(_req,res)=>res.json({freshness:POLICIES,correlation_thresholds:THRESHOLDS,confidence:'Numeric values are source-provided only; correlation strength is categorical rule support, not probability'}));
 router.get('/sources',async(req,res)=>res.json(await health.list(req.query)));
 router.get('/sources/:id',async(req,res)=>res.json(await health.detail(req.params.id)));
 router.get('/sources/:id/samples',async(req,res)=>res.json(await health.samples(req.params.id,req.query.limit)));
 router.get('/correlations',async(req,res)=>res.json(await engine.list(req.query)));
 router.get('/correlations/:id',async(req,res)=>res.json(await engine.get(req.params.id)));
 router.post('/correlations/:id/dismiss',async(req,res)=>res.json(await engine.dismiss(M.uuid(req.params.id))));
 // Internal observations of upstream attempts, never exposed by the public Next proxy.
 router.post('/source-reports',async(req,res)=>{
  if(req.headers['x-intelligence-key']!==(process.env.INTELLIGENCE_REPORT_KEY||'osiris-local-reports'))throw new M.InputError('Internal report key required',403);
  const records=req.body?.reports;M.check(Array.isArray(records)&&records.length>0&&records.length<=50,'Invalid reports batch');
  for(const record of records){
   M.check(record&&typeof record==='object'&&record.source&&record.sample,'Invalid source report');
   await health.register(record.source);await health.record(record.source.id,record.sample);
  }
  res.json({accepted:records.length});
 });
 return router;
}
module.exports={intelligenceRoutes};
