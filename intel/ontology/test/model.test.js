const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model');
const { legacyGraph, resolveInput, wdObject, countryQid } = require('../sources');
const { fetchSource } = require('../fetch-source');
const legacy = require('../../resolvers');
test('stable identifiers normalize across feeds', () => {
  for (const [namespace, value, expected] of [['icao24','ABC123','abc123'],['registration','ra-12345','RA12345'],['wikidata','q42','Q42'],['asn','00042','AS42'],['imo','IMO 1234567','1234567'],['ip','2001:4860:4860:0:0:0:0:8888','2001:4860:4860::8888']]) assert.equal(M.identifier(namespace,value).value,expected);
});
test('malformed model input is rejected', () => {
  for (const [ns, value] of [['icao24','not-ip'],['wikidata','Q1 UNION'],['asn','-2'],['ip','http://localhost'],['mmsi','1']]) assert.throws(() => M.identifier(ns,value));
  for (const depth of [100000,-1,1.5,'',[],null]) assert.throws(() => M.graphOptions({ depth }));
  assert.throws(() => M.provenance({ provider:'source', url:'javascript:alert(1)' }));
  assert.throws(() => M.provenance({ provider:'source', confidence: 2 }));
  assert.throws(() => resolveInput({ type: 'ip', id: 'localhost' }));
  assert.throws(() => M.objectInput({ type:'company', canonical_name:'Example', external_ids:[null], provenance:[{provider:'test'}] }), M.InputError);
});
test('callsigns are not persistent aircraft identifiers', () => {
  assert.equal(resolveInput({ type:'aircraft',id:'AFL123' }).root.external_ids.length,0);
  assert.equal(resolveInput({ type:'aircraft',id:'ABC123' }).root.external_ids[0].namespace,'icao24');
});
test('legacy sanctions never imply confirmed identity or observed links', () => {
  const { root } = resolveInput({ type:'aircraft',id:'abc123' });
  const graph = legacyGraph('aircraft','abc123',{ nodes:[{ id:'sanction:target-1',type:'sanction',label:'Example',properties:{ schema:'Person' } }], links:[{ source:'aircraft:abc123',target:'sanction:target-1',label:'SANCTIONS MATCH' }] },root);
  assert.equal(graph.objects[1].external_ids[0].namespace,'opensanctions');
  assert.equal(graph.links[0].link_type,'SANCTIONS_MATCH'); assert.equal(graph.links[0].provenance[0].kind,'inferred');
});
test('Wikidata identifiers retain QIDs independent of display labels', () => {
  const input = { id:'Q42',labels:{en:{value:'Same name'}},claims:{P31:[{rank:'normal',mainsnak:{snaktype:'value',datavalue:{value:{id:'Q5'}}}}]} };
  const object = wdObject(input,'company'); assert.equal(object.type,'person'); assert.equal(object.external_ids[0].value,'Q42');
});
test('source redirects follow published OpenSanctions artifacts but cannot escape the allowlist', async () => {
  const original = global.fetch; const requested = [];
  try {
    global.fetch = async url => { requested.push(url); return requested.length === 1 ? new Response(null, { status:307, headers:{ location:'https://data.opensanctions.org/artifacts/test.csv' } }) : new Response('id,name'); };
    assert.equal(await (await fetchSource('https://data.opensanctions.org/datasets/latest/test.csv')).text(), 'id,name');
    assert.equal(requested.length, 2);
    global.fetch = async () => new Response(null, { status:302, headers:{location:'http://127.0.0.1/private'} });
    await assert.rejects(fetchSource('https://data.opensanctions.org/test'), /Blocked source/);
    await assert.rejects(fetchSource('https://evil.example/'), /Blocked source/);
    global.fetch = async () => new Response(null, {status:307,headers:{location:'/loop'}});
    await assert.rejects(fetchSource('https://data.opensanctions.org/test'), /Too many/);
  } finally { global.fetch = original; }
});
test('country fallback verifies ISO identity instead of adopting the first name match', async () => {
  const original = global.fetch;
  try {
    global.fetch = async url => {
      if (url.includes('query.wikidata.org')) throw new Error('SPARQL offline');
      if (url.includes('wbsearchentities')) return Response.json({search:[{id:'Q1'},{id:'Q219'}]});
      return Response.json({entities:{Q1:{id:'Q1',claims:{P297:[{mainsnak:{snaktype:'value',datavalue:{value:'XX'}}}]}},Q219:{id:'Q219',claims:{P297:[{mainsnak:{snaktype:'value',datavalue:{value:'BG'}}}]}}}});
    };
    assert.equal(await countryQid('BG','Bulgaria'),'Q219');
    assert.equal(await countryQid('US','Bulgaria'),undefined);
  } finally { global.fetch = original; }
});
test('OpenSanctions CSV ingestion retains source IDs and keeps the last index on failure', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => new Response('id,schema,name,aliases,countries,program_ids,sanctions,first_seen\nfixture-id,Person,"Example, Person",Example Alias,xx,fixture,test,2026-01-01\n');
    await legacy.loadSanctions();
    assert.equal(legacy.sanctionsSearch('Example Alias')[0].id,'fixture-id');
    assert.equal(legacy.getStats().sanctions_entries,1);
    global.fetch = async () => { throw new Error('fixture offline'); };
    await legacy.loadSanctions();
    assert.equal(legacy.sanctionsSearch('Example Alias')[0].schema,'Person');
  } finally { global.fetch = original; }
});
