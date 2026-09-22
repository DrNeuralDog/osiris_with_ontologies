import type {WorldRecord} from './types';
/** A bounded holding buffer, not timestamp correction. Future records become visible only at source time. */
export class ReportClockBuffer{
 private rows=new Map<string,{record:WorldRecord;seen:number}>();
 collect(incoming:WorldRecord[],now=Date.now()){
  let rejected=0;
  for(const r of incoming.slice(0,1000)){
   const at=Date.parse(r.observed_at||'');
   if(!Number.isFinite(at)||at>now+20*60000||at<now-86400000){rejected++;continue;}
   const prior=this.rows.get(r.id);this.rows.set(r.id,{record:r,seen:prior?.seen??now});
  }
  for(const [id,value]of this.rows)if(now-value.seen>3600000)this.rows.delete(id);
  while(this.rows.size>1200)this.rows.delete(this.rows.keys().next().value!);
  const all=[...this.rows.values()].map(v=>v.record),pending=all.filter(r=>Date.parse(r.observed_at!)>now);
  return {records:all.filter(r=>Date.parse(r.observed_at!)<=now),pending:pending.length,rejected};
 }
}
