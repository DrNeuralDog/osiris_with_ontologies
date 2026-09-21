import {describe,it,expect} from 'vitest';
import {historyReplayItem,replayLiveLayers,normalizeReplayBounds,replayInvestigation,initialReplay,sliderTime,sliderValue,advanceReplay,jumpReplay,returnLive,replayURL,parseReplayURL,replayItemsAt,replayFeatures,chunkRange,type ReplayChunk,type ReplayItem} from './replay';
const now=Date.parse('2026-09-21T12:00:00Z');
const item:ReplayItem={id:'a',object_id:'o',name:'Aircraft',domain:'aircraft',from:new Date(now-60000).toISOString(),to:new Date(now+60000).toISOString(),lat:10,lon:20};
describe('World Replay pure semantics',()=>{
 it('slider maps exact endpoints and midpoint',()=>{const r={from:now-3600000,to:now};expect(sliderTime(0,r)).toBe(r.from);expect(sliderTime(1000,r)).toBe(now);expect(sliderValue(sliderTime(500,r),r)).toBe(500);});
 it.each([1,5,20,60])('%sx is elapsed wall time times speed',speed=>{const s={...initialReplay(now),mode:'replay' as const,at:now-600000,playing:true,speed};expect(advanceReplay(s,1000).at-s.at).toBe(speed*1000);});
 it('pauses at the end, and live never plays',()=>{expect(advanceReplay({...initialReplay(now),mode:'replay',playing:true},1000).playing).toBe(false);expect(advanceReplay(initialReplay(now),1000).at).toBe(now);});
 it('jump opens replay and live return retains range/context-independent layer preferences',()=>{const s=jumpReplay(initialReplay(now),now-300000);expect(s.mode).toBe('replay');expect(s.open).toBe(true);expect(returnLive(s)).toEqual({...s,mode:'live',playing:false});});
 it('URL roundtrip preserves existing layers and rejects invalid/future/excessive ranges',()=>{const s=jumpReplay(initialReplay(now),now-60000),url=replayURL('http://localhost/?layers=flights,weather',s);expect(url).toContain('layers=flights%2Cweather');expect(parseReplayURL('http://localhost'+url,now).at).toBe(s.at);expect(replayURL('http://localhost'+url,returnLive(s))).not.toContain('replay=');for(const value of ['bad','2027-01-01T00:00:00Z'])expect(parseReplayURL('http://localhost/?replay='+value,now).mode).toBe('live');});
 it('only explicit intervals are visible, features contain no paths/interpolation',()=>{const c={items:[item],policies:{}} as ReplayChunk;expect(replayItemsAt(c,now)).toHaveLength(1);expect(replayItemsAt(c,now+60000)).toHaveLength(0);expect(replayFeatures([item]).features[0].geometry.type).toBe('Point');expect(replayFeatures([{...item,domain:'correlations',status:'EXPIRED'}]).features).toHaveLength(0);});
 it('request chunks are bounded to one hour and selected range',()=>{const r=chunkRange({...initialReplay(now),at:now-1});expect(r.to-r.from).toBeLessThanOrEqual(3600000);expect(r.to).toBe(now);});
});

it('masks all live overlays without mutating layer preferences and handles dateline bounds',()=>{
 const prefs={flights:true,weather:true,terrain_3d:true};const masked=replayLiveLayers(prefs);expect(masked.flights).toBe(false);expect(masked.conflict_zones).toBe(false);expect(prefs.flights).toBe(true);expect(masked.terrain_3d).toBe(true);
 expect(normalizeReplayBounds({west:170,east:190,south:-10,north:10})).toEqual([170,-10,-170,10]);
 expect(replayInvestigation({lat:1,lng:2,label:'old',track:true,points:[{lat:1,lng:2,at:new Date(now+1).toISOString()}]},initialReplay(now))?.points).toEqual([]);
});

it('history jumps keep supported domains and never relabel ontology changes as news',()=>{
 const observation={id:'x',object_id:'y',event_type:'POSITION',timeline_at:new Date(now).toISOString(),lat:1,lon:2} as import('./intelligence').Observation;
 expect(historyReplayItem(observation,'aircraft','CMP815')?.domain).toBe('aircraft');
 expect(historyReplayItem({...observation,event_type:'EARTHQUAKE'},'event','Quake')?.domain).toBe('earthquake');
 expect(historyReplayItem({...observation,event_type:'OBJECT_CREATED'},'event','Quake')).toBeUndefined();
});
