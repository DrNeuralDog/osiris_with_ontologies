import {NextResponse} from 'next/server';
import {getClientIp,isRateLimited} from '@/lib/ssrf-guard';
import {bounds,categories} from '@/lib/world/types';
import {infrastructure} from '@/lib/world/infrastructure';
import {weather,radar} from '@/lib/world/weather';
import {weatherOptions} from '@/lib/world/weather-grid';
import {conflicts,warTrackerCapability} from '@/lib/world/conflict';
import {enrichment} from '@/lib/world/enrichment';
import {gem} from '@/lib/world/gem';
export const dynamic='force-dynamic';
export async function GET(req:Request,{params}:{params:Promise<{kind:string}>}){
 if(isRateLimited(`world:${getClientIp(req)}`,40,60000))return NextResponse.json({error:'Rate limit exceeded'},{status:429});
 const {kind}=await params,q=new URL(req.url).searchParams;
 if(req.url.length>1800||[...q.keys()].some(k=>!['bbox','categories','from','to','provider','hours','cursor','limit',...(kind==='weather'?['zoom','quality']:[])].includes(k)||q.getAll(k).length>1))return NextResponse.json({error:'Invalid query'},{status:400});
 try{
  if(kind==='infrastructure'){const b=bounds(q.get('bbox')),c=categories(q.get('categories'));const local=await gem(b,c);try{const osm=await infrastructure(b,c);return NextResponse.json({...osm,records:[...osm.records,...local].slice(0,700),gem_records:local.length});}catch(e){if(local.length)return NextResponse.json({records:local,status:'PARTIAL',message:'OSM unavailable; local GEM only',truncated:local.length>=500});throw e;}}
  if(kind==='weather'){
   if([...q.keys()].some(k=>!['bbox','zoom','quality'].includes(k)))throw new Error('INVALID_WEATHER_QUERY');
   const result=await weather(bounds(q.get('bbox')),weatherOptions(q));
   return NextResponse.json(result,{status:result.status==='UNAVAILABLE'?503:200,headers:{'Cache-Control':'no-store'}});
  }
  if(kind==='radar')return NextResponse.json(await radar());
  if(kind==='conflicts'){
   if(q.has('bbox')){
    bounds(q.get('bbox'));if([...q.keys()].some(k=>!['bbox','hours','limit','cursor'].includes(k)))throw new Error('INVALID_QUERY');
    const base=process.env.INTEL_URL||(process.env.NODE_ENV==='production'?'http://osiris-intel:4000':'http://localhost:4000');
    // One transport retry for transient Docker DNS / stale keep-alive connections.
    // Only a fixed internal read endpoint; no provider re-fetch or mutation is retried.
    let response:Response|undefined;
    for(let attempt=0;attempt<2;attempt++){
     try{response=await fetch(`${base}/intelligence/reports?${q}`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(6000)});break;}
     catch(error){if(attempt===1)throw error;}
    }
    if(!response)throw new Error('INTELLIGENCE_UNAVAILABLE');
    return NextResponse.json(await response.json(),{status:response.status,headers:{'Cache-Control':'no-store'}});
   }
   return NextResponse.json(await conflicts());
  }
  if(kind==='enrichment'){const p=q.get('provider');if(p!=='acled'&&p!=='ucdp')throw new Error('INVALID_PROVIDER');return NextResponse.json(await enrichment(p,q.get('from')||'',q.get('to')||'',bounds(q.get('bbox'))));}
  if(kind==='providers')return NextResponse.json({providers:[
   {id:'overpass',status:'ON_DEMAND',message:'OSM / ODbL · viewport <=2° · local prototype use'},
   {id:'open-meteo',status:'ON_DEMAND',message:'DERIVED model fields · CC BY 4.0 · free non-commercial API'},
   {id:'rainviewer',status:'ON_DEMAND',message:'Past 2h only · best effort · attribution required'},
   {...warTrackerCapability(),message:'Civil alert query; public access attempted without a key. Provider access restrictions are respected.'},
   {id:'alerts-in-ua',status:process.env.ALERTS_IN_UA_TOKEN?'CONFIGURED':'KEY_REQUIRED'},
   {id:'ukrainealarm',status:process.env.UKRAINE_ALARM_API_KEY?'AWAITING_DOCUMENTATION':'KEY_REQUIRED',message:'Provider approval and supplied API contract required'},
   {id:'acled',status:process.env.ACLED_USERNAME&&process.env.ACLED_PASSWORD?'CONFIGURED':'KEY_REQUIRED',message:'Historical enrichment; account license applies'},
   {id:'ucdp',status:process.env.UCDP_API_TOKEN?'CONFIGURED':'KEY_REQUIRED',message:'Historical GED 26.1; bounded manual enrichment'},
   {id:'goes',status:'NOT_CONNECTED',message:'NOAA regional imagery adapter reserved; no viewer scraping'},
   {id:'detector-aero',status:'NOT_CONNECTED',message:'No documented public API / permission supplied'},
  ]});
  return NextResponse.json({error:'Unknown world data endpoint'},{status:404});
 }catch(e){const message=e instanceof Error?e.message:'UNAVAILABLE';return NextResponse.json({error:message,status:'UNAVAILABLE'},{status:/INVALID|ZOOM_IN/.test(message)?400:message==='PROVIDER_BACKOFF'?429:502});}
}
