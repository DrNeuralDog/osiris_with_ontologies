import {ProviderCache,boundedJSON} from './server-cache';
import {array,record,str,num,timestamp,type Bounds,type InfraCategory,type WorldRecord} from './types';
const cache=new ProviderCache('overpass',3600000,30000,20,100);
const FILTERS:Record<InfraCategory,string[]>={power:['[power=plant]'],substation:['[power=substation]'],transmission:['[power=line][voltage]'],pipeline:['[man_made=pipeline][substance~"^(oil|gas)$"]'],terminal:['[industrial~"^(refinery|oil|gas|lng)$"]'],'telecom':['[man_made=communications_tower]','[telecom=tower]'],data_center:['[telecom=data_center]','[building=data_center]'],dam:['[waterway=dam]'],transport:['[aeroway=aerodrome]','[harbour=yes]','[railway=station][station!=subway]']};
export function overpassQuery(b:Bounds,c:InfraCategory[]){if(b[2]-b[0]>2||b[3]-b[1]>2)throw new Error('ZOOM_IN: infrastructure viewport must be <=2 degrees');return `[out:json][timeout:15][maxsize:33554432];(${c.flatMap(k=>FILTERS[k].map(f=>`nwr${f}(${b[1]},${b[0]},${b[3]},${b[2]});`)).join('')});out meta geom 500;`;}
export function normalizeOSM(body:unknown,now=new Date().toISOString()):WorldRecord[]{
 return array(record(body).elements).slice(0,500).flatMap(v=>{
  const e=record(v),t=record(e.tags),kind=str(e.type);if(!['node','way','relation'].includes(kind)||!/^\d+$/.test(str(e.id)))return [];
  const points=(v:unknown)=>array(v).map(record).filter(p=>num(p.lon)!==null&&num(p.lat)!==null).map(p=>[Number(p.lon),Number(p.lat)]);
  const members=array(e.members).map(record).map(m=>points(m.geometry)).filter(p=>p.length>1);
  const raw=kind==='relation'?members.flat():points(e.geometry);
  // Geometry is bounded without inventing straight shortcuts through skipped vertices.
  const closed=raw.length>=4&&raw[0][0]===raw.at(-1)![0]&&raw[0][1]===raw.at(-1)![1];
  const geometry:GeoJSON.Geometry|undefined=raw.length>1&&raw.length<=400?(kind==='relation'?{type:'MultiLineString',coordinates:members}:closed?{type:'Polygon',coordinates:[raw]}:{type:'LineString',coordinates:raw}):undefined;
  const center=record(e.center),lat=num(e.lat)??num(center.lat)??raw[0]?.[1]??null,lon=num(e.lon)??num(center.lon)??raw[0]?.[0]??null;
  if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return [];
  const subtype=t.power==='plant'?'power':t.power==='substation'?'substation':t.power==='line'?'transmission':t.man_made==='pipeline'?'pipeline':t.waterway==='dam'?'dam':t.telecom==='data_center'||t.building==='data_center'?'data_center':t.telecom==='tower'||t.man_made==='communications_tower'?'telecom':t.aeroway==='aerodrome'||t.harbour==='yes'||t.railway==='station'?'transport':'terminal';
  const id=`osm:${kind}:${e.id}`;
  return [{id,provider:'OpenStreetMap',name:str(t.name)||`${subtype} ${id}`,domain:'infrastructure',subtype,lat,lon,observed_at:null,fetched_at:now,url:`https://www.openstreetmap.org/${kind}/${e.id}`,evidence_state:'IMPORTED',confidence:null,extraction_method:'OSM tagged infrastructure / bounded Overpass query',geometry,geometry_precision:kind==='node'?'source':'representative',location_precision:kind==='node'?'EXACT_SOURCE_COORDINATE':'APPROXIMATE',source_license:'ODbL 1.0',source_attribution:'© OpenStreetMap contributors',properties:{...t,source_updated_at:timestamp(e.timestamp),source_version:e.version,geometry_omitted:raw.length>400||(!geometry&&kind!=='node'),geometry_anchor:kind==='node'?'source point':'Representative vertex for display; not a proximity measurement',asset_kind:t.aeroway==='aerodrome'?'airport':t.harbour==='yes'?'port':'infrastructure'}} satisfies WorldRecord];
 });
}
export async function infrastructure(b:Bounds,c:InfraCategory[]){const query=overpassQuery(b,c);return cache.get(query,async()=>{const body=await boundedJSON('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:query}).toString()});if(record(body).remark||!Array.isArray(record(body).elements))throw new Error('OVERPASS_INCOMPLETE');const records=normalizeOSM(body);return {records,status:'AVAILABLE',truncated:array(record(body).elements).length>=500};});}
