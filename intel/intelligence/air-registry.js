const { SourceHealth } = require('./health');
const M = require('../ontology/model');
async function updateCapabilities(store, rows) {
    M.check(Array.isArray(rows) && rows.length <= 20, 'Invalid official provider registry');
    const health = new SourceHealth(store);
    for (const p of rows) {
        M.check(/^[a-z0-9-]{1,50}$/.test(p.id), 'Invalid provider');
        const id = `world:${p.id}`;
        await health.register({ id, name: p.name, category: 'conflict', endpoint: p.documentation || p.id, enabled: p.connected === true });
        await store.pool.query('UPDATE intelligence_sources SET credential_state=$2,coverage_metadata=$3,enabled=$4 WHERE id=$1', [id, M.text(p.credential_state, 'credential state', 80), { coverage: p.coverage, attribution: p.attribution, cadence_seconds: p.cadence_seconds }, p.connected === true]);
    }
}
module.exports = { updateCapabilities };
