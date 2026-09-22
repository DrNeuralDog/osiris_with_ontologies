const {hash}=require('./history');
const VERSION='civilian-source-wording-v1';
const patterns={
 clear:/\ball clear\b|alert (?:lifted|cancelled)|відбій|отбой/iu,
 alert:/air[- ]raid (?:alert|warning)|воздушн\p{L}* тревог|повітрян\p{L}* тривог/iu,
 shelter:/take shelter|seek shelter|stay (?:in shelters|indoors)|residents.{0,30}(?:warned|urged)|укрыти|укритт|небезпек|опасност|предупрежден|попереджен|\bwarning\b/iu,
 drone:/\bdrones?\b|\buav\b|\bfpv\b|бпла|дрон|шахед|shahed|герань/iu,
 missile:/\bmissiles?\b|\brockets?\b|ракет/iu,
 heard:/\bheard\b|\bhearing\b|\baudible\b|слыш|чути|чули|чутно/iu,
 blast:/\bexplosions?\b|\bblasts?\b|взрыв|вибух/iu,
 sound:/\bsound\b|\bnoise\b|звук|гул|гуркіт/iu,
 irrelevant:/photograph|festival|earnings|manufacturer|siren app|учени|учебн|навчан|фестиваль|производител|виробник|(?:no|not|never|не).{0,20}(?:heard|hearing|слыш|чути|чули)|(?:may|might|could).{0,30}(?:launch|attack)|возможн\p{L}* пуск/iu,
};
/** Classifies civil-warning wording, never weapon movements or a source position. */
function classifyCivilianReport(title,text=''){
 const lead=String(text).split(/\n\s*\n/).slice(0,2).join('\n').slice(0,400),input=`${String(title).slice(0,300)}\n${lead}`;
 if(patterns.irrelevant.test(input))return null;
 const hits=Object.entries(patterns).filter(([key,rx])=>key!=='irrelevant'&&rx.test(input));
 const has=key=>hits.some(([k])=>k===key);
 const type=has('clear')&&(has('alert')||has('shelter'))?'ALL_CLEAR':has('heard')&&has('blast')?'HEARD_EXPLOSION':has('heard')&&(has('sound')||has('drone')||has('missile'))?'HEARD_SOUND':has('shelter')&&has('drone')?'DRONE_THREAT':has('shelter')&&has('missile')?'MISSILE_THREAT':has('alert')?'AIR_RAID_ALERT':null;
 return type?{type,matched_terms:hits.map(([,rx])=>input.match(rx)[0]),method:VERSION,uncertainty:'SOURCE_CLAIM_NOT_VERIFIED'}:null;
}
function newsWarning(r){
 const classification=classifyCivilianReport(r.title,r.description||r.summary),ms=Date.parse(r.published);
 let url;try{url=new URL(r.link);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;}catch{return null;}
 if(!classification||!Number.isFinite(ms))return null;
 const place=r.place,coords=r.coords,located=place&&['region','settlement'].includes(r.location_precision)&&Array.isArray(coords)&&coords.length===2&&coords.every(Number.isFinite)&&Math.abs(coords[0])<=85&&Math.abs(coords[1])<=180;
 const at=new Date(ms).toISOString(),key=hash(r.link),acoustic=classification.type.startsWith('HEARD_');
 const data={subtype:classification.type,civilian_warning:true,classification,provider_raw_type:r.alert_kind||'public text',source_class:'PUBLIC_REPORT',source_family:r.source||r.source_name||'news',canonical_source_url:r.link,original_source_id:key,original_text:String(r.description||r.title).slice(0,2500),original_title:String(r.title).slice(0,300),area_name:place?.name||'',resolved_place_label:place?.label||'',location_precision:located?(r.location_precision==='region'?'REGION':'LOCALITY'):'UNKNOWN',geometry_precision:'representative',position_semantics:'REPORT_AREA',rendered_as_representative_point:true,sound_source_position_known:false,acoustic_report:acoustic,carriers:(r.also_reported_by||[]).slice(0,12).map(c=>({provider:String(c.source_name||c.source||'').slice(0,100),url:String(c.link||'').slice(0,1000)})),independent_sources:null};
 const provenance=[{provider:String(r.source_name||r.source||'Public report').slice(0,100),source_id:r.link,source_record_id:r.id||r.link,url:r.link,observed_at:at,confidence:null,kind:'reported',extraction_method:VERSION,metadata:{classification,location_method:'Existing Live Alerts place resolver; report area, not a detected object position',location_state:'derived',independence_verified:false}}];
 return {key,name:String(r.title).slice(0,300),type:'event',event_type:classification.type==='HEARD_EXPLOSION'?'HEARD_EXPLOSION':'CONFLICT_REPORT',observed_at:at,lat:located?coords[0]:null,lon:located?coords[1]:null,data,provenance};
}
module.exports={classifyCivilianReport,newsWarning,VERSION};
