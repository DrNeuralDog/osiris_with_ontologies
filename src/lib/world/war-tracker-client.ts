import {get} from 'node:https';
/** Fixed documented provider. No Origin spoofing, redirects, payments or user URLs. */
export function warTrackerJSON(query:URLSearchParams,key:string|undefined):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  const req=get(new URL(`/api/v1/events?${query}`,'https://war-tracker.com'),{maxHeaderSize:65536,headers:{Accept:'application/json','User-Agent':'OSIRIS-civilian-awareness/1.0',...(key?{'X-API-Key':key}:{})}},res=>{
   if(res.statusCode!==200){res.destroy();finish(new Error(`HTTP_${res.statusCode}`));return;}
   const parts:Buffer[]=[];let size=0;
   res.on('data',(part:Buffer)=>{size+=part.length;if(size>2*1024*1024){res.destroy();finish(new Error('PAYLOAD_LIMIT'));}else parts.push(part);});
   res.on('end',()=>{try{finish(null,JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{finish(new Error('INVALID_PROVIDER_JSON'));}});
   res.on('error',finish);
  });
  const timer=setTimeout(()=>{req.destroy();finish(new Error('PROVIDER_TIMEOUT'));},15000);
  let done=false;
  function finish(error:Error|null,value?:unknown){if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);}
  req.on('error',finish);
 });
}
