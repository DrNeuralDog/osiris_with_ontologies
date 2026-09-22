const express = require("express");
const { CaseService } = require("./cases");
const { ObjectSets } = require("./sets");
const M = require("./model");
function investigationRoutes(store) {
  const r = express.Router(),
    cases = new CaseService(store),
    sets = new ObjectSets(store);
  r.use(express.json({ limit: "64kb" }));
  r.get("/cases", async (req, res) => res.json(await cases.list(req.query)));
  r.post("/cases", async (req, res) =>
    res.status(201).json(await cases.create(req.body)),
  );
  r.get("/cases/:id", async (req, res) =>
    res.json(await cases.get(req.params.id)),
  );
  r.patch("/cases/:id", async (req, res) =>
    res.json(await cases.update(req.params.id, req.body)),
  );
  r.get("/cases/:id/items", async (req, res) =>
    res.json(await cases.items(req.params.id, req.query)),
  );
  r.post("/cases/:id/items", async (req, res) =>
    res.json(await cases.add(req.params.id, req.body)),
  );
  r.post("/cases/:id/items/batch", async (req, res) =>
    res.json(await cases.addBatch(req.params.id, req.body)),
  );
  r.get("/cases/:id/set-counts", async (req, res) =>
    res.json(await cases.setCounts(req.params.id)),
  );
  r.delete("/cases/:id/items/:item", async (req, res) =>
    res.json(await cases.remove(req.params.id, req.params.item)),
  );
  r.patch("/cases/:id/items/:item", async (req, res) => {
    M.fields(req.body, ["pinned"]);
    res.json(await cases.pin(req.params.id, req.params.item, req.body.pinned));
  });
  r.get("/cases/:id/notes", async (req, res) =>
    res.json(await cases.notes(req.params.id)),
  );
  r.post("/cases/:id/notes", async (req, res) =>
    res.json(await cases.note(req.params.id, req.body)),
  );
  r.patch("/cases/:id/notes/:note", async (req, res) =>
    res.json(await cases.note(req.params.id, req.body, req.params.note)),
  );
  r.get("/cases/:id/activity", async (req, res) =>
    res.json(await cases.activity(req.params.id, req.query)),
  );
  r.get("/cases/:id/timeline", async (req, res) =>
    res.json(await cases.timeline(req.params.id, req.query)),
  );
  r.get("/cases/:id/graph", async (req, res) =>
    res.json(await cases.graph(req.params.id, req.query)),
  );
  r.post("/cases/:id/sets", async (req, res) => {
    M.fields(req.body, ["set_id"]);
    res.json(await cases.attach(req.params.id, req.body.set_id));
  });
  r.delete("/cases/:id/sets/:set", async (req, res) =>
    res.json(await cases.detach(req.params.id, req.params.set)),
  );
  r.get("/cases/:id/export", async (req, res) => {
    M.fields(req.query, ["format"]);
    res.json(await cases.export(req.params.id, req.query.format || "json"));
  });
  r.post("/analyses", async (req, res) =>
    res.json(await cases.analysis(req.body)),
  );
  r.post("/sets/evaluate", async (req, res) =>
    res.json(await sets.evaluate(req.body)),
  );
  r.get("/sets", async (req, res) => res.json(await sets.list(req.query)));
  r.post("/sets", async (req, res) =>
    res.status(201).json(await sets.create(req.body)),
  );
  r.get("/sets/:id", async (req, res) =>
    res.json(await sets.get(req.params.id)),
  );
  r.get("/sets/:id/results", async (req, res) =>
    res.json(await sets.run(req.params.id, req.query)),
  );
  return r;
}
module.exports = { investigationRoutes };
