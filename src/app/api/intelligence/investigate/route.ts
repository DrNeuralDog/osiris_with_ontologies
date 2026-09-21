import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { lookupCachedCamera } from '@/lib/cctv-snapshot';
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  try { if (origin && new URL(origin).host !== (req.headers.get('host') || new URL(req.url).host)) return NextResponse.json({ error: 'Cross-origin mutation denied' }, { status: 403 }); } catch { return NextResponse.json({ error: 'Invalid origin' }, { status: 403 }); }
  if (new URL(req.url).search || Number(req.headers.get('content-length')) > 32768) return NextResponse.json({ error: 'Invalid request size or query' }, { status: 400 });
  if (isRateLimited(`investigate:${getClientIp(req)}`, 30, 60000)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  try {
    const reader=req.body?.getReader();let text='',size=0;const decoder=new TextDecoder();
    if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32768){await reader.cancel();return NextResponse.json({error:'Record too large'},{status:413});}text+=decoder.decode(part.value,{stream:true});}}finally{reader.releaseLock();}
    let body;try { body=JSON.parse(text+decoder.decode()); } catch { return NextResponse.json({ error:'Invalid JSON' },{status:400}); }
    if (!body || typeof body.type!=='string' || typeof body.id!=='string' || body.id.length>500) return NextResponse.json({error:'Stable investigation seed required'},{status:400});
    if(body.type==='camera') {
      const camera=await lookupCachedCamera(body.id);
      if(!camera)return NextResponse.json({error:'Camera not available in local catalog yet',code:'NOT_AVAILABLE'},{status:404});
      body={type:'camera',id:body.id,name:camera.name,provider:camera.source||'OSIRIS camera catalog',record:camera};
    }
    const base=process.env.INTEL_URL || (process.env.NODE_ENV==='production'?'http://osiris-intel:4000':'http://localhost:4000');
    const response=await fetch(`${base}/intelligence/investigate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    return NextResponse.json(await response.json(),{status:response.status});
  } catch { return NextResponse.json({error:'Investigation storage unavailable'},{status:502}); }
}
