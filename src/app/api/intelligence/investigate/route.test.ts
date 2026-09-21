import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ssrf-guard',()=>({getClientIp:()=> 'test',isRateLimited:()=>false}));
vi.mock('@/lib/cctv-snapshot',()=>({lookupCachedCamera:vi.fn()}));
import { lookupCachedCamera } from '@/lib/cctv-snapshot';
import { POST } from './route';
const request=(body:unknown,headers:Record<string,string>={})=>new Request('http://localhost/api/intelligence/investigate',{method:'POST',headers,body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({object:{id:'canonical'}})));vi.mocked(lookupCachedCamera).mockResolvedValue(null);});
afterEach(()=>vi.unstubAllGlobals());
it('rejects malformed, oversized and cross-origin requests before forwarding',async()=>{
  expect((await POST(request(null))).status).toBe(400);
  expect((await POST(request({type:'camera',id:'x',record:'x'.repeat(33000)}))).status).toBe(413);
  expect((await POST(request({type:'camera',id:'x'},{origin:'https://untrusted.example'}))).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it('unknown cameras never trigger a catalog fan-out',async()=>{
  const response=await POST(request({type:'camera',id:'unknown',record:{feed_url:'http://localhost/secret'}}));
  expect(response.status).toBe(404);expect((await response.json()).code).toBe('NOT_AVAILABLE');expect(fetch).not.toHaveBeenCalled();
});
it('replaces user camera records with locally known catalog data',async()=>{
  vi.mocked(lookupCachedCamera).mockResolvedValue({id:'cam-1',name:'Known camera',source:'TfL',feed_url:'https://known.example/image'});
  expect((await POST(request({type:'camera',id:'cam-1',record:{feed_url:'http://localhost/secret'}}))).status).toBe(200);
  const [url,options]=vi.mocked(fetch).mock.calls[0];expect(String(url)).toMatch(/\/intelligence\/investigate$/);
  const body=JSON.parse(String(options?.body));expect(body.record.feed_url).toBe('https://known.example/image');expect(options?.redirect).toBe('error');
});
it('forwards backend validation errors',async()=>{
  vi.mocked(fetch).mockResolvedValue(Response.json({error:'Unsupported investigation type'},{status:400}));
  expect((await POST(request({type:'alien',id:'1'}))).status).toBe(400);
});
