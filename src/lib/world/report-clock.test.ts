import {it,expect,vi,afterEach} from 'vitest';
import {ReportClockBuffer} from './report-clock';
import {reported} from './conflict';
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
it('holds future batch times intact until mature and survives replacement of the upstream batch',()=>{
 const b=new ReportClockBuffer(),now=Date.parse('2026-09-22T12:00:00Z'),r=reported({id:'gdelt:clock',name:'Clock fixture',subtype:'CONFLICT_EVENT',provider:'GDELT',observed_at:'2026-09-22T12:10:00Z'});
 expect(b.collect([r],now).records).toHaveLength(0);expect(b.collect([],now+600000).records[0].observed_at).toBe(r.observed_at);expect(b.collect([],now+3600001).records).toHaveLength(0);
 expect(b.collect([{...r,observed_at:'2026-09-22T23:00:00Z'}],now).rejected).toBe(1);
});
