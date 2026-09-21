import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/ssrf-guard', () => ({ getClientIp: () => 'test', isRateLimited: () => false }));
import { proxyOntology } from './[...path]/route';
const id='11111111-2222-3333-4444-555555555555';
const context=(...path:string[])=>({params:Promise.resolve({path})});
describe('ontology proxy boundary', () => {
  beforeEach(()=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({nodes:[],links:[]}),{status:200}))));
  afterEach(()=>vi.unstubAllGlobals());
  it('only forwards known endpoints to configured intel service',async()=>{
    const response=await proxyOntology(new Request(`http://localhost/api/ontology/objects/${id}/graph?depth=2`),context('objects',id,'graph'));
    expect(response.status).toBe(200); expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`http://localhost:4000/ontology/objects/${id}/graph?depth=2`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects arbitrary paths, ingestion, duplicate query keys and URLs',async()=>{
    for(const path of [['http:','evil.example'],['ingest'],['objects','..','health']]) expect((await proxyOntology(new Request('http://localhost/api/ontology/x'),context(...path))).status).toBe(404);
    expect((await proxyOntology(new Request(`http://localhost/api/ontology/objects?depth=1&depth=2`),context('objects'))).status).toBe(400);
    expect((await proxyOntology(new Request(`http://localhost/api/ontology/objects?url=http://evil`),context('objects'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects cross-origin writes and malformed JSON',async()=>{
    expect((await proxyOntology(new Request('http://localhost/api/ontology/resolve',{method:'POST',headers:{origin:'http://evil.example'},body:'{}'}),context('resolve'))).status).toBe(403);
    expect((await proxyOntology(new Request('http://localhost/api/ontology/resolve',{method:'POST',body:'{'}),context('resolve'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns an actionable unavailable state',async()=>{
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    expect((await proxyOntology(new Request('http://localhost/api/ontology/types'),context('types'))).status).toBe(502);
  });
  it('accepts the browser Host when Next standalone uses its Docker bind address',async()=>{
    const response=await proxyOntology(new Request('http://0.0.0.0:3000/api/ontology/resolve',{method:'POST',headers:{host:'localhost:3000',origin:'http://localhost:3000'},body:'{}'}),context('resolve'));
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds bodies even when Content-Length is absent',async()=>{
    expect((await proxyOntology(new Request('http://localhost/api/ontology/resolve',{method:'POST',body:JSON.stringify({id:'x'.repeat(17000)})}),context('resolve'))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
});
