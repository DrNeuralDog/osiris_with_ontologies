import {describe,it,expect,vi,beforeEach} from 'vitest';
vi.mock('@/lib/ssrf-guard',()=>({getClientIp:()=> 'test',isRateLimited:()=>false}));
vi.mock('@/lib/world/infrastructure',()=>({infrastructure:vi.fn(async()=>({records:[],status:'AVAILABLE'}))}));
vi.mock('@/lib/world/weather',()=>({weather:vi.fn(),radar:vi.fn()}));
vi.mock('@/lib/world/conflict',()=>({conflicts:vi.fn()}));
vi.mock('@/lib/world/gem',()=>({gem:vi.fn(async()=>[])}));
vi.mock('@/lib/world/enrichment',()=>({enrichment:vi.fn()}));
import {GET} from './[kind]/route';
import {infrastructure} from '@/lib/world/infrastructure';
const get=(kind:string,q='')=>GET(new Request(`http://localhost/api/world/${kind}${q}`),{params:Promise.resolve({kind})});
beforeEach(()=>vi.clearAllMocks());
describe('world API',()=>{
 it.each(['?bbox=NaN,2,3,4&categories=power','?bbox=1,2,3,4&categories=unknown','?bbox=1,2,3,4&categories=power&url=https://internal','?bbox=4,3,2,1&categories=power'])('rejects malformed request %s before provider call',async q=>{expect((await get('infrastructure',q)).status).toBe(400);expect(infrastructure).not.toHaveBeenCalled();});
 it('passes only parsed numeric viewport and enumerated categories',async()=>{expect((await get('infrastructure','?bbox=13,52,13.1,52.1&categories=power')).status).toBe(200);expect(infrastructure).toHaveBeenCalledWith([13,52,13.1,52.1],['power']);});
 it('provider availability contains no credentials',async()=>{vi.stubEnv('WAR_TRACKER_API_KEY','secret-fixture');const r=await get('providers');expect(await r.text()).not.toContain('secret-fixture');vi.unstubAllEnvs();});
 it('rejects unknown provider and route',async()=>{expect((await get('enrichment','?provider=arbitrary')).status).toBe(400);expect((await get('url')).status).toBe(404);});
});
