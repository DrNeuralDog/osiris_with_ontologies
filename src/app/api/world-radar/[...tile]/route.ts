import {NextResponse} from 'next/server';
import {radar} from '@/lib/world/weather';
import {isRateLimited} from '@/lib/ssrf-guard';
const tiles=new Map<string,{bytes:Uint8Array;until:number}>();
const pending=new Map<string,Promise<Uint8Array>>();
export async function GET(_req:Request,{params}:{params:Promise<{tile:string[]}>}){
 const parts=(await params).tile;if(parts.length!==4||parts.some(p=>!/^\d{1,13}$/.test(p)))return new Response('Invalid tile',{status:400});
 const [time,z,x,y]=parts.map(Number);if(z>7||x>=2**z||y>=2**z)return new Response('Invalid tile bounds',{status:400});
 const key=parts.join('/'),saved=tiles.get(key);if(saved&&saved.until>Date.now())return new Response(Buffer.from(saved.bytes),{headers:{'Content-Type':'image/png','Cache-Control':'private,max-age=120'}});
 try{const frame=(await radar()).frames.find(f=>f.time===time);if(!frame)return new Response('Frame outside available range',{status:404});
  let job=pending.get(key);if(!job){if(isRateLimited('rainviewer-total',80,60000)||pending.size>=8)return new Response('Radar budget exceeded',{status:429});job=(async()=>{
   const res=await fetch(`https://tilecache.rainviewer.com${frame.path}/256/${z}/${x}/${y}/2/1_1.png`,{redirect:'error',signal:AbortSignal.timeout(10000)});if(!res.ok)throw new Error(`HTTP_${res.status}`);const reader=res.body!.getReader();const chunks:Uint8Array[]=[];let size=0;try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>512000){await reader.cancel();throw new Error('Tile too large');}chunks.push(r.value);}}finally{reader.releaseLock();}const bytes=Buffer.concat(chunks);if(bytes.length<8||bytes.readUInt32BE(0)!==0x89504e47)throw new Error('Invalid PNG');if(tiles.size>=64)tiles.delete(tiles.keys().next().value!);tiles.set(key,{bytes,until:Date.now()+600000});return bytes;
  })().finally(()=>pending.delete(key));pending.set(key,job);}
  return new Response(Buffer.from(await job),{headers:{'Content-Type':'image/png','Cache-Control':'private,max-age=120'}});
 }catch{return NextResponse.json({error:'Radar tile unavailable'},{status:502});}
}
