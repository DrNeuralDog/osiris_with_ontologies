import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
vi.mock('@/lib/ssrf-guard',()=>({getClientIp:()=> 'test',isRateLimited:()=>false}));
vi.mock('@/lib/world/infrastructure',()=>({infrastructure:vi.fn(async()=>({records:[],status:'AVAILABLE'}))}));
vi.mock('@/lib/world/weather',()=>({weather:vi.fn(),radar:vi.fn()}));
vi.mock('@/lib/world/conflict',()=>({conflicts:vi.fn(),warTrackerCapability:()=>({id:'war-tracker',status:'NOT_CHECKED'})}));
vi.mock('@/lib/world/gem',()=>({gem:vi.fn(async()=>[])}));
vi.mock('@/lib/world/enrichment',()=>({enrichment:vi.fn()}));
import {GET} from './[kind]/route';
import {conflicts} from '@/lib/world/conflict';
import {infrastructure} from '@/lib/world/infrastructure';
import {weather} from '@/lib/world/weather';
const get=(kind:string,q='')=>GET(new Request(`http://localhost/api/world/${kind}${q}`),{params:Promise.resolve({kind})});
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>vi.unstubAllGlobals());
describe('world API',()=>{
 it.each(['?bbox=NaN,2,3,4&categories=power','?bbox=1,2,3,4&categories=unknown','?bbox=1,2,3,4&categories=power&url=https://internal','?bbox=4,3,2,1&categories=power'])('rejects malformed request %s before provider call',async q=>{expect((await get('infrastructure',q)).status).toBe(400);expect(infrastructure).not.toHaveBeenCalled();});
 it('passes only parsed numeric viewport and enumerated categories',async()=>{expect((await get('infrastructure','?bbox=13,52,13.1,52.1&categories=power')).status).toBe(200);expect(infrastructure).toHaveBeenCalledWith([13,52,13.1,52.1],['power']);});
 it('provider availability contains no credentials',async()=>{vi.stubEnv('WAR_TRACKER_API_KEY','secret-fixture');const r=await get('providers');expect(r.status).toBe(200);expect(await r.text()).not.toContain('secret-fixture');vi.unstubAllEnvs();});
 it('rejects unknown provider and route',async()=>{expect((await get('enrichment','?provider=arbitrary')).status).toBe(400);expect((await get('url')).status).toBe(404);});
});

describe('weather route validation and diagnostics',()=>{
 it.each(['?bbox=1,2,3,4&zoom=99','?bbox=1,2,3,4&quality=unlimited','?bbox=1,2,3,4&limit=999','?bbox=1,2,3,4&zoom=4&zoom=5','?bbox=1,2,3,4&zoom='])('rejects %s before weather upstream',async q=>{expect((await get('weather',q)).status).toBe(400);expect(weather).not.toHaveBeenCalled();});
 it('passes bounded options and returns diagnostics rather than masking an upstream failure',async()=>{
  vi.mocked(weather).mockResolvedValueOnce({status:'UNAVAILABLE',records:[],grid:{bounds:[1,2,3,4],columns:2,rows:2,points:[],spacing_degrees:[2,2]},diagnostics:{provider:'Open-Meteo',mode:'customer',status:'UNAVAILABLE',error:'HTTP_401',cache:'MISS',requested:4,received:0,normalized:0,fetched_at:null,data_at:null,http_status:401,retry_after_seconds:120,duration_ms:1}});
  const r=await get('weather','?bbox=1,2,3,4&zoom=8&quality=low');expect(r.status).toBe(503);expect((await r.json()).diagnostics.error).toBe('HTTP_401');expect(weather).toHaveBeenCalledWith([1,2,3,4],{zoom:8,quality:'low'});
 });
});

it('viewport reads retained DB reports without any global upstream fan-out',async()=>{
 const f=vi.fn().mockResolvedValue(new Response(JSON.stringify({records:[],basis:'RETAINED_SOURCE_REPORTS'})));vi.stubGlobal('fetch',f);
 const r=await get('conflicts','?bbox=20,40,40,60&hours=6');expect(r.status).toBe(200);expect(conflicts).not.toHaveBeenCalled();expect(f.mock.calls[0][0]).toContain('/intelligence/reports?bbox=20%2C40%2C40%2C60&hours=6');expect(f.mock.calls[0][1].redirect).toBe('error');
});
it('invalid bbox never contacts intel or public providers',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);expect((await get('conflicts','?bbox=50,60,20,40')).status).toBe(400);expect(f).not.toHaveBeenCalled();expect(conflicts).not.toHaveBeenCalled();});
it('retries a transient internal transport failure once without polling external sources',async()=>{const f=vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(new Response(JSON.stringify({records:[]})));vi.stubGlobal('fetch',f);expect((await get('conflicts','?bbox=20,40,40,60')).status).toBe(200);expect(f).toHaveBeenCalledTimes(2);expect(conflicts).not.toHaveBeenCalled();});
