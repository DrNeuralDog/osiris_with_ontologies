import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {record,array,str,num,inside,type Bounds,type WorldRecord,type InfraCategory} from './types';
let cached:{until:number;records:WorldRecord[]}|null=null;
/** Optional local GeoJSON export only; never downloads GEM forms or datasets. */
export async function gem(b:Bounds,categories:InfraCategory[]):Promise<WorldRecord[]>{
 if(!cached||cached.until<Date.now()){
  const file=path.join(process.cwd(),'data','imports','gem','catalog.geojson');
  try{if((await stat(file)).size>16*1024*1024)throw new Error('GEM_FILE_LIMIT');const body=record(JSON.parse(await readFile(file,'utf8'))),meta=record(body.metadata);
   if(!str(meta.license)||!str(meta.attribution)||!str(meta.source_url).startsWith('https://globalenergymonitor.org/')||!str(meta.release))throw new Error('GEM_LICENSE_METADATA_REQUIRED');
   const records:WorldRecord[]=array(body.features).slice(0,20000).flatMap(v=>{const f=record(v),p=record(f.properties),g=record(f.geometry),coords=array(g.coordinates);const id=str(p.gem_id),lat=num(coords[1]),lon=num(coords[0]);if(!/^[\w.-]{1,100}$/.test(id)||g.type!=='Point'||lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return [];
    return [{id:`gem:${id}`,provider:'GEM',name:str(p.name)||id,domain:'infrastructure',subtype:str(p.subtype)||'power',lat,lon,observed_at:null,fetched_at:new Date().toISOString(),url:str(meta.source_url),evidence_state:'IMPORTED',confidence:null,extraction_method:'Local official GEM export; mapped columns, original IDs retained',geometry_precision:'representative',location_precision:'APPROXIMATE',source_license:str(meta.license),source_attribution:str(meta.attribution),properties:{...p,source_updated_at:meta.release,asset_kind:'infrastructure'}}];
   });cached={records,until:Date.now()+600000};
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 }
 return cached.records.filter(r=>inside(r,b)&&categories.includes(r.subtype as InfraCategory)).slice(0,500);
}
