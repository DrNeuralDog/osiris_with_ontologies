import { describe, expect, it } from 'vitest';
import { mapInvestigationSeed, mergeGraph, type OntologyGraph, type OntologyObject } from './ontology';
const node = (id: string): OntologyObject => ({ id, type: 'person', canonical_name: id, external_ids: [], properties: {}, provenance: [], created_at: '', updated_at: '' });
const graph = (ids: string[]): OntologyGraph => ({ root_id: ids[0], nodes: ids.map(node), links: [], truncated: false });
describe('ontology explorer', () => {
  it('deduplicates repeated expansion without changing investigation root', () => {
    const root = graph(['a','b']); const next = graph(['b','c']);
    const merged = mergeGraph(root, next); expect(merged.root_id).toBe('a'); expect(merged.nodes.map(n => n.id)).toEqual(['a','b','c']);
    expect(mergeGraph(merged, next).nodes).toHaveLength(3);
  });
  it('bounds a long investigation and removes dangling edges', () => {
    const merged = mergeGraph(graph(Array.from({length:250},(_,i)=>String(i))), { ...graph(['overflow']), links:[{ id:'edge',source:'0',target:'overflow',link_type:'CEO',provenance:[],properties:{},confidence:null,valid_from:null,valid_to:null }] });
    expect(merged.nodes).toHaveLength(250); expect(merged.links).toHaveLength(0); expect(merged.truncated).toBe(true);
  });
  it('keeps stable map identities and does not fabricate identifiers from names', () => {
    expect(mapInvestigationSeed({ type:'aircraft',icao24:'abc123',callsign:'AFL1' })).toMatchObject({ id:'abc123',icao24:'abc123',name:'AFL1' });
    expect(mapInvestigationSeed({ type:'vessel',mmsi:123456789,name:'Ship' })).toMatchObject({id:'123456789',mmsi:'123456789'});
    expect(mapInvestigationSeed({type:'company',name:'Same name'})).not.toHaveProperty('source_id');
    expect(mapInvestigationSeed({type:'person',wikidata:'Q42',name:'Douglas'})).toMatchObject({id:'Q42',wikidata:'Q42'});
    expect(mapInvestigationSeed({type:'cctv',id:'camera'})).toBeNull();
    expect(mapInvestigationSeed({type:'aircraft',icao24:'abc123',registration:'N/A'})).not.toHaveProperty('registration');
    expect(mapInvestigationSeed({type:'vessel',mmsi:0,name:'Unknown vessel'})).not.toHaveProperty('mmsi');
  });
  it('reconciles canonical aliases after the backend merges older records', () => {
    const merged = mergeGraph(graph(['old','canonical']), { ...graph(['canonical']), aliases:{ old:'canonical' } });
    expect(merged.root_id).toBe('canonical'); expect(merged.nodes).toHaveLength(1);
  });
});
