const express = require('express');
const M = require('./model');
const { recordObservation } = require('./observations');
const {HistoryService}=require('../intelligence/history');
function ontologyRoutes(store, service) {
  const router = express.Router();
  const history=new HistoryService(store);
  router.use(express.json({ limit: '128kb' }));
  router.get('/types', (_req, res) => res.json({ objects: M.OBJECT_TYPES, links: M.LINK_TYPES }));
  router.get('/objects', async (req, res) => res.json({ objects: await store.find(req.query) }));
  router.post('/ingest', async (req, res) => {
    M.check(req.body && typeof req.body === 'object', 'Invalid body');
    res.status(201).json({ object_ids: await store.ingest(req.body.objects, req.body.links) });
  });
  router.post('/resolve', async (req, res) => res.json(await service.resolve(req.body)));
  router.post('/observations', async (req, res) => res.status(201).json(await recordObservation(store, req.body)));
  router.get('/objects/:id', async (req, res) => res.json(await store.get(M.uuid(req.params.id))));
  router.get('/objects/:id/history',async(req,res)=>res.json(await history.query(M.uuid(req.params.id),req.query)));
  router.get('/objects/:id/provenance',async(req,res)=>res.json(await history.evidence(M.uuid(req.params.id),req.query.property)));
  router.get('/objects/:id/graph', async (req, res) => res.json(await store.graph(M.uuid(req.params.id), req.query)));
  router.get('/objects/:id/relationships', async (req, res) => res.json(await store.graph(M.uuid(req.params.id), { ...req.query, depth: 1 })));
  router.post('/objects/:id/expand', async (req, res) => res.json(await service.expand(M.uuid(req.params.id))));
  return router;
}
module.exports = { ontologyRoutes };
