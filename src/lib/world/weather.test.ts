import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('@/lib/source-health-reporter',()=>({recordSourceCheck:vi.fn()}));
import {recordSourceCheck} from '@/lib/source-health-reporter';
import {normalizeWeather,weatherRequest,weather} from './weather';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
describe('Open-Meteo contract',()=>{
 it('normalizes all multi-location results beyond the old 16-item truncation',()=>{
  const points=Array.from({length:81},(_,i)=>[50,i]);
  const r=normalizeWeather(points.map(()=>({latitude:50.01,longitude:30.01,current:{time:'2026-09-22T10:15',temperature_2m:0,relative_humidity_2m:72,precipitation:0,cloud_cover:90,pressure_msl:1010,wind_speed_10m:4,wind_direction_10m:240,wind_gusts_10m:7},hourly:{time:['2026-09-22T10:00'],visibility:[9000]}})),points);
  expect(r).toHaveLength(81);expect(r[0].properties).toMatchObject({temperature_c:0,humidity_percent:72,precipitation_mm:0,cloud_percent:90,pressure_hpa:1010,wind_speed_ms:4,wind_from_deg:240,wind_gust_ms:7,visibility_m:9000,model_lat:50.01});expect(r[0].confidence).toBeNull();expect(r[0].evidence_state).toBe('DERIVED');
 });
 it('free is default even if an unrelated or stale key exists',()=>{
  vi.stubEnv('OPEN_METEO_API_MODE','');vi.stubEnv('OPEN_METEO_API_KEY','old-key');
  const u=weatherRequest([[50,30],[51,31]]);expect(u.hostname).toBe('api.open-meteo.com');expect(u.searchParams.has('apikey')).toBe(false);expect(u.searchParams.get('latitude')).toBe('50,51');expect(u.searchParams.get('wind_speed_unit')).toBe('ms');
 });
 it('customer is explicit and requires a non-placeholder credential',()=>{
  vi.stubEnv('OPEN_METEO_API_MODE','customer');vi.stubEnv('OPEN_METEO_API_KEY','');expect(()=>weatherRequest([[50,30]])).toThrow('KEY_REQUIRED');
  vi.stubEnv('OPEN_METEO_API_KEY','replace-me');expect(()=>weatherRequest([[50,30]])).toThrow('KEY_REQUIRED');
  vi.stubEnv('OPEN_METEO_API_KEY','fixture-legitimate-key');const u=weatherRequest([[50,30]]);expect(u.hostname).toBe('customer-api.open-meteo.com');expect(u.searchParams.get('apikey')).toBe('fixture-legitimate-key');
 });
 it('invalid customer credential is surfaced; no silent downgrade or secret leakage',async()=>{
  vi.stubEnv('OPEN_METEO_API_MODE','customer');vi.stubEnv('OPEN_METEO_API_KEY','invalid-secret-fixture');const f=vi.fn().mockResolvedValue(new Response('{}',{status:401}));vi.stubGlobal('fetch',f);
  const r=await weather([30,50,31,51]);expect(r.status).toBe('UNAVAILABLE');expect(r.diagnostics.error).toContain('HTTP_401');expect(JSON.stringify(r)).not.toContain('invalid-secret-fixture');expect(f).toHaveBeenCalledOnce();expect(recordSourceCheck).toHaveBeenCalledWith(expect.objectContaining({sample:expect.objectContaining({ok:false,error_category:'HTTP_401'})}));
 });
 it('zero returned records is a visible no-data failure, never HEALTHY',async()=>{
  vi.stubEnv('OPEN_METEO_API_MODE','free');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('[]')));
  const r=await weather([10,10,11,11]);expect(r.diagnostics.error).toBe('NO_USABLE_MODEL_DATA');expect(r.diagnostics.received).toBe(0);expect(r.status).toBe('UNAVAILABLE');
 });
 it('coalesces batches, reports cache hits, and permits only same-grid stale fallback',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));vi.stubEnv('OPEN_METEO_API_MODE','free');
  const f=vi.fn().mockImplementation(async(input:string)=>{const u=new URL(input);return new Response(JSON.stringify(u.searchParams.get('latitude')!.split(',').map(()=>({current:{time:'2030-01-01T10:00',temperature_2m:10}}))));});vi.stubGlobal('fetch',f);
  const b:[number,number,number,number]=[20,30,21,31];
  const [a,coalesced]=await Promise.all([weather(b),weather(b)]);expect(a.diagnostics.cache).toBe('MISS');expect(coalesced.diagnostics.cache).toBe('COALESCED');expect(f).toHaveBeenCalledOnce();
  expect((await weather(b)).diagnostics.cache).toBe('HIT');expect(f).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(601000);f.mockResolvedValue(new Response('{}',{status:503}));const stale=await weather(b);expect(stale.status).toBe('STALE');expect(stale.records.length).toBe(a.records.length);expect(stale.diagnostics.error).toBe('HTTP_503');
  expect((await weather([22,30,23,31])).records).toHaveLength(0);
 });
 it('retries a transient transport failure once, but never retries indefinitely',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2031-01-01T10:00:00Z'));vi.stubEnv('OPEN_METEO_API_MODE','free');
  const f=vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response(JSON.stringify({current:{time:'2031-01-01T10:00',temperature_2m:10}})));vi.stubGlobal('fetch',f);
  const r=await weather([40,50,41,51]);expect(r.records).toHaveLength(1);expect(f).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(10000);f.mockReset().mockRejectedValue(new TypeError('fetch failed'));const failed=await weather([42,50,43,51]);expect(failed.diagnostics.error).toBe('NETWORK_CONNECTION_FAILED');expect(f).toHaveBeenCalledTimes(2);
 });
});
