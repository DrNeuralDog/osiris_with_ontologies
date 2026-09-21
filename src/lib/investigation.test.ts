import { describe, expect, it } from 'vitest';
import { investigationView, mapEntitySeed, investigationPoint } from './investigation';

describe('map investigation identity', () => {
  it('preserves exact feed coordinates instead of tile-quantised hit coordinates',()=>{
    expect(investigationPoint({lat:55.584,lng:51.967},[51.9669909,55.584039])).toEqual({lat:55.584,lng:51.967});
    expect(investigationPoint({lat:0,lon:0},[0.01,0.01])).toEqual({lat:0,lng:0});
    expect(investigationPoint({},[20,10])).toEqual({lat:10,lng:20});
  });
  const records = [
    { type:'fire',lat:10,lng:20,date:'2026-09-20',time:'0842',provider:'NASA-FIRMS (VIIRS)' },
    { type:'earthquake',id:'us7000abcd',source:'USGS' },
    { type:'weather',id:'nws-alert-1',provider:'NOAA NWS' },
    { type:'infrastructure',id:'catalog-nuclear-1' },
    { type:'airport',icao:'EGLL',iata:'LHR' },
    { type:'port',catalog_id:'port-1',name:'Port',lat:10,lng:20 },
    { type:'satellite',noradId:25544,name:'ISS' },
    { type:'cctv',id:'JamCams_00001',source:'TfL' },
    { type:'news',link:'https://example.com/report#top',lat:10,lng:20,location_precision:'city' },
  ];
  for (const record of records) it(`${record.type} keeps source identity across display name changes`,()=>{
    const seed=mapEntitySeed(record),renamed=mapEntitySeed({...record,name:'Different display name'});
    expect(seed).not.toBeNull();expect(renamed?.id).toBe(seed?.id);expect(seed?.record).toBeDefined();
  });
  it('does not invent identity for unknown, imprecise, or name-only entities',()=>{
    for(const entity of [{type:'fire',name:'Fire'}, {type:'satellite',name:'ISS'}, {type:'camera',name:'Camera'}, {type:'weather',id:'random'}, {type:'aircraft',callsign:'TEST123'}, {type:'company',name:'Apple'}, {type:'earthquake',id:'bg123',source:'NIGGG-BAS'}, {type:'news',url:'https://example.com',lat:1,lng:2,location_precision:'country'}, {type:'alien',id:'42'}]) expect(mapEntitySeed(entity)).toBeNull();
  });
  it('rejects invalid locations and arbitrary URL schemes',()=>{
    expect(mapEntitySeed({type:'news',url:'javascript:alert(1)',lat:1,lng:2})).toBeNull();
    expect(mapEntitySeed({type:'port',name:'Test',lat:91,lng:2})).toBeNull();
  });
  it('keeps a valid aircraft identity without propagating missing registration as an ID',()=>{
    const seed=mapEntitySeed({type:'aircraft',icao24:'abc123',registration:'N/A'});
    expect(seed?.id).toBe('abc123');expect(seed?.registration).toBeUndefined();expect(seed?.record?.registration).toBeUndefined();
  });
  it('uses canonical news URLs',()=>expect(mapEntitySeed(records[8])?.id).toBe('https://example.com/report'));
});
describe('investigation navigation intent',()=>{
  it('opens history without loading neighbors',()=>expect(investigationView('history')).toEqual({tab:'history',depth:0}));
  it('opens evidence without loading neighbors',()=>expect(investigationView('evidence')).toEqual({tab:'details',depth:0}));
  it('opens graph and related objects at depth one',()=>{for(const intent of ['graph','related'] as const)expect(investigationView(intent)).toEqual({tab:'details',depth:1});});
});
