/** OSIRIS Intelligence Layer: compatible /resolve plus persistent ontology. */
const express = require('express');
const { OntologyStore } = require('./ontology/store');
const { OntologyService, resolveInput } = require('./ontology/sources');
const { ontologyRoutes } = require('./ontology/routes');
const { InputError } = require('./ontology/model');
const legacy = require('./resolvers');
const {intelligenceRoutes}=require('./intelligence/routes');
const {IntelligenceWorker}=require('./intelligence/worker');
const {setSourceObserver}=require('./ontology/fetch-source');
function createApp(store, service = new OntologyService(store)) {
  const app = express(), rateMap = new Map();
  let active = 0;
  app.disable('x-powered-by');
  app.get('/health', async (_req, res) => {
    try { await store.pool.query('SELECT 1'); res.json({ status: 'ok', database: 'ok', ...legacy.getStats(), uptime_seconds: Math.floor(process.uptime()) }); }
    catch { res.status(503).json({ status: 'degraded', database: 'unavailable' }); }
  });
  app.use((req, res, next) => {
    const now = Date.now(), ip = req.ip;
    for (const [key, value] of rateMap) if (now > value.until) rateMap.delete(key);
    const rate = rateMap.get(ip) || { count: 0, until: now + 60000 };
    rateMap.set(ip, rate);
    if (++rate.count > 120) return res.status(429).json({ error: 'Rate limit exceeded' });
    const costly = req.path === '/resolve' || req.method === 'POST';
    if (costly && active >= 4) return res.status(429).json({ error: 'Resolution capacity reached' });
    if (costly) {
      active++; let released = false;
      const release = () => { if (!released) { active--; released = true; } };
      res.once('finish', release);
      // Abandoned requests retain capacity until bounded upstream work has expired.
      res.once('close', () => { if (!released) setTimeout(release, 60000).unref(); });
    }
    res.set('Cache-Control', 'no-store'); next();
  });
  app.use('/ontology', ontologyRoutes(store, service));
  app.use('/intelligence',intelligenceRoutes(store));
  app.use('/investigations',require('./investigations/routes').investigationRoutes(store));
  app.get('/resolve', async (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type.toLowerCase().trim() : '';
    if (!Object.hasOwn(legacy.RESOLVERS, type)) throw new InputError('Invalid type');
    const props = {};
    for (const key of ['registration', 'model', 'icao24', 'imo', 'mmsi']) {
      if (req.query[key] !== undefined) { if (typeof req.query[key] !== 'string' || req.query[key].length > 200) throw new InputError(`Invalid ${key}`); props[key] = req.query[key]; }
    }
    const { id: raw } = resolveInput({ type, id: req.query.id, ...props });
    if (raw.length < 2) throw new InputError('Invalid id (2-200 chars)');
    const id = type === 'ip' ? raw : legacy.sanitizeId(raw);
    if (id.length < 2) throw new InputError('Invalid id');
    const result = await legacy.resolveLegacy(type, id, props);
    const canonical_id = await service.persistLegacy(type, id, props, result);
    res.json({ nodes: result.nodes, links: result.links, entity: { type, id }, canonical_id,
      source: 'OSIRIS Intelligence Layer', sanctions_index_size: legacy.getStats().sanctions_entries,
      wikidata_cache_hits: legacy.getStats().wikidata_cache_size, timestamp: new Date().toISOString() });
  });
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
  app.use((error, _req, res, _next) => {
    const status = error instanceof InputError ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    if (status === 500) console.error('[INTEL]', error.message);
    res.status(status).json({ error: status === 500 ? 'Intelligence operation failed' : error.message, nodes: [], links: [] });
  });
  return app;
}
async function boot() {
  const store = OntologyStore.connect();
  await store.migrate();
  const worker=new IntelligenceWorker(store);
  const sourceNames={'www.wikidata.org':'Wikidata entity API','query.wikidata.org':'Wikidata SPARQL','data.opensanctions.org':'OpenSanctions CSV','ip-api.com':'IP geolocation','stat.ripe.net':'RIPE network data'};
  for(const [host,name]of Object.entries(sourceNames))await worker.health.register({id:`ontology:${host}`,name,category:'ontology',endpoint:host});
  setSourceObserver((host,sample)=>worker.health.record(`ontology:${host}`,sample).catch(e=>console.warn('[health]',e.message)));
  const server = createApp(store).listen(process.env.INTEL_PORT || 4000, '0.0.0.0', () => console.log('[INTEL] Persistent ontology ready'));
  if(process.env.INTELLIGENCE_WORKER!=='0')await worker.start();
  else await store.pool.query("INSERT INTO intelligence_worker_state(id,enabled) VALUES('main',false) ON CONFLICT(id) DO UPDATE SET enabled=false,heartbeat_at=now()");
  void legacy.loadSanctions();
  // Retry a failed initial download without waiting a whole day; keep fresh indexes for 24h.
  const refresh = setInterval(() => {
    if (Date.now() - legacy.getStats().sanctions_loaded_at >= 24 * 60 * 60 * 1000) void legacy.loadSanctions();
  }, 30 * 60 * 1000);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { clearInterval(refresh);await worker.stop(); server.close(() => store.pool.end().then(() => process.exit(0))); });
}
if (require.main === module) boot().catch(error => { console.error('[INTEL] Startup failed:', error.message); process.exit(1); });
module.exports = { createApp };
