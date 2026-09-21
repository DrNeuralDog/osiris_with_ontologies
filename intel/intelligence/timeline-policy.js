const {freshness}=require('./policy');
const DOMAINS=['aircraft','vessel','satellite','fire','earthquake','weather','news','cyber','infrastructure','correlations'];
// Visibility is a display policy, not an assertion that a position/event persists.
const WINDOWS={aircraft:300,vessel:900,satellite:300,fire:21600,earthquake:86400,weather:604800,news:21600,cyber:21600,infrastructure:2592000};
const TYPES={FIRE:'fire',EARTHQUAKE:'earthquake',SEVERE_WEATHER:'weather',WEATHER:'weather',NEWS_EVENT:'news',CYBER_INDICATOR:'cyber',REFERENCE_LOCATION:'infrastructure'};
const moving=d=>['aircraft','vessel','satellite'].includes(d);
function domain(o){return o.event_type==='POSITION'&&moving(o.object_type)?o.object_type:TYPES[o.event_type]||null;}
function inBounds(lat,lon,b){return !b||lat>=b[1]&&lat<=b[3]&&(b[0]<=b[2]?lon>=b[0]&&lon<=b[2]:lon>=b[0]||lon<=b[2]);}
function intervals(rows){
 const result=[],next=new Map();
 // Later points invalidate earlier ones even if the later point is outside the viewport.
 for(const o of [...rows].sort((a,b)=>new Date(b.timeline_at)-new Date(a.timeline_at)||b.id.localeCompare(a.id))){
  const d=domain(o);if(!d)continue;
  const at=new Date(o.timeline_at).getTime(),start=Math.max(at,o.valid_from?Date.parse(o.valid_from):at);
  let end=at+WINDOWS[d]*1000;
  if(d==='weather'&&!o.valid_to)end=at+21600000;
  if(o.valid_to)end=d==='weather'?Date.parse(o.valid_to):Math.min(end,Date.parse(o.valid_to));
  const key=`${o.object_id}:${o.event_type}`;
  if(moving(d)||d==='infrastructure'){end=Math.min(end,next.get(key)??Infinity);next.set(key,at);}
  if(end<=start)continue;
  result.push({id:o.id,object_id:o.object_id,name:o.canonical_name,domain:d,from:new Date(start).toISOString(),to:new Date(end).toISOString(),lat:o.lat,lon:o.lon,observation:o});
 }
 return result;
}
function correlationAt(events,at){
 const t=Date.parse(at),rows=events.filter(e=>Date.parse(e.changed_at)<=t).sort((a,b)=>Date.parse(b.changed_at)-Date.parse(a.changed_at)||Number(b.id)-Number(a.id));
 return rows[0]?.status||'UNKNOWN';
}
function relativeFreshness(item,at){return freshness(item.observation?.observed_at,{vessel:'maritime',infrastructure:'static'}[item.domain]||item.domain,Date.parse(at));}
module.exports={DOMAINS,WINDOWS,TYPES,moving,domain,inBounds,intervals,correlationAt,relativeFreshness};
