const M = require('../ontology/model');
const POLICIES = {
 aircraft:{live:120,fresh:300,historical:86400}, maritime:{live:120,fresh:600,historical:86400},
 weather:{live:900,fresh:3600,historical:86400}, earthquake:{live:300,fresh:86400,historical:604800},
 fire:{live:900,fresh:21600,historical:172800}, news:{live:300,fresh:3600,historical:86400},
 cctv:{live:300,fresh:900,historical:86400}, cyber:{live:900,fresh:21600,historical:604800},
 satellite:{live:300,fresh:3600,historical:86400}, ontology:{live:3600,fresh:86400,historical:2592000},
 static:{live:86400,fresh:2592000,historical:31536000}, api:{live:300,fresh:900,historical:86400},
};
function policy(category, custom={}) { return {...(POLICIES[category]||POLICIES.api),...custom}; }
function freshness(at, category, now=Date.now(), custom={}) {
 if(!at || !Number.isFinite(new Date(at).getTime())) return 'UNKNOWN';
 const age=(now-new Date(at).getTime())/1000, p=policy(category,custom);
 if(age < -300) return 'UNKNOWN';
 return age<=p.live?'LIVE':age<=p.fresh?'FRESH':age<=p.historical?'STALE':'HISTORICAL';
}
function healthState(source,samples=[],now=Date.now()) {
 if(!source.enabled || !source.last_checked_at) return 'UNKNOWN';
 if(source.consecutive_failures>=5) return 'OFFLINE';
 if(source.consecutive_failures>0) return 'DEGRADED';
 const f=freshness(source.last_success_at,source.category,now,source.policy);
 if(f==='STALE'||f==='HISTORICAL') return 'STALE';
 const rate=samples.length?samples.filter(s=>s.ok).length/samples.length:null;
 if(rate!==null && rate<0.8) return 'DEGRADED';
 return source.last_success_at?'HEALTHY':'UNKNOWN';
}
const retryDelay = (failures,base=60) => Math.min(3600,base*2**Math.min(Math.max(0,failures-1),7));
function integer(raw,fallback,min,max,name='limit') {
 const value=raw===undefined?fallback:raw;
 M.check((typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isInteger(Number(value))&&Number(value)>=min&&Number(value)<=max,`Invalid ${name}`); return Number(value);
}
function historyQuery(raw={},now=Date.now()) {
 const limit=integer(raw.limit,50,1,200), order=raw.order||'desc'; M.check(['asc','desc'].includes(order),'Invalid order');
 const to=M.timestamp(raw.to)||new Date(now+60000).toISOString(), from=M.timestamp(raw.from)||new Date(new Date(to).getTime()-90*86400000).toISOString();
 M.check(new Date(to)>=new Date(from)&&new Date(to)-new Date(from)<=366*86400000,'History range must be <=366 days');
 M.check(raw.location_only===undefined||['true','false'].includes(raw.location_only),'Invalid location_only');
 let cursor=null;
 if(raw.cursor!==undefined) { try { M.check(typeof raw.cursor==='string'&&raw.cursor.length<=240,'Invalid cursor'); cursor=JSON.parse(Buffer.from(raw.cursor,'base64url').toString()); cursor={at:M.timestamp(cursor.at),id:M.uuid(cursor.id)}; M.check(cursor.at,'Invalid cursor'); } catch { throw new M.InputError('Invalid cursor'); } }
 return {from,to,limit,order,cursor,location_only:raw.location_only==='true'};
}
module.exports={POLICIES,policy,freshness,healthState,retryDelay,integer,historyQuery};
