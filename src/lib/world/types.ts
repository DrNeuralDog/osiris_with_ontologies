export type Bounds = [number, number, number, number];
export const INFRA_CATEGORIES = ['power','substation','transmission','pipeline','terminal','telecom','data_center','dam','transport'] as const;
export type InfraCategory = typeof INFRA_CATEGORIES[number];
export const CONFLICT_TYPES = ['AIR_RAID_ALERT','DRONE_REPORT','DRONE_ATTACK','MISSILE_REPORT','MISSILE_LAUNCH','GUIDED_BOMB_REPORT','AIR_DEFENSE_ACTIVITY','INTERCEPTION_REPORT','EXPLOSION_REPORT','AIRSTRIKE','MILITARY_STRIKE','ARTILLERY','GROUND_CLASH','INFRASTRUCTURE_STRIKE_REPORT','CONFLICT_EVENT'] as const;
export type Precision = 'EXACT_SOURCE_COORDINATE'|'LOCALITY'|'DISTRICT'|'REGION'|'APPROXIMATE'|'UNKNOWN';
export interface WorldRecord {
 id:string; provider:string; name:string; domain:'infrastructure'|'weather'|'conflict'; subtype:string;
 lat:number|null; lon:number|null; observed_at:string|null; fetched_at:string; url:string;
 evidence_state:'IMPORTED'|'DERIVED'|'REPORTED'; confidence:number|null; extraction_method:string;
 geometry?:GeoJSON.Geometry; geometry_precision:'source'|'representative'; location_precision:Precision;
 source_license:string; source_attribution:string; properties:Record<string,unknown>;
}
export interface ProviderResult {records:WorldRecord[]; status:string; message?:string; truncated?:boolean; fetched_at?:string}
export const record = (v:unknown):Record<string,unknown> => v && typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export const array = (v:unknown):unknown[] => Array.isArray(v)?v:[];
export const str = (v:unknown,max=500) => typeof v==='string'?v.slice(0,max):typeof v==='number'?String(v):'';
export const num = (v:unknown):number|null => typeof v==='number'&&Number.isFinite(v)?v:typeof v==='string'&&v.trim()&&Number.isFinite(Number(v))?Number(v):null;
export const timestamp = (v:unknown):string|null => typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
export function bounds(raw:string|null):Bounds {
 const p=raw?.split(',').map(Number);if(!p||p.length!==4||!p.every(Number.isFinite)||p[0]<-180||p[2]>180||p[1]<-85||p[3]>85||p[0]>=p[2]||p[1]>=p[3])throw new Error('INVALID_BOUNDS');return p as Bounds;
}
export const inside=(r:Pick<WorldRecord,'lat'|'lon'>,b:Bounds)=>r.lat!==null&&r.lon!==null&&r.lon>=b[0]&&r.lon<=b[2]&&r.lat>=b[1]&&r.lat<=b[3];
export function categories(raw:string|null):InfraCategory[]{const c=[...new Set(raw?.split(',')||[])];if(!c.length||c.some(v=>!INFRA_CATEGORIES.includes(v as InfraCategory)))throw new Error('INVALID_CATEGORIES');return c as InfraCategory[];}
export const worldSeed=(r:WorldRecord)=>({type:'world',id:r.id,name:r.name,provider:r.provider,record:{...r,lng:r.lon}});
export const WORLD_LAYERS = {
 infra_power:'Power plants',infra_substation:'Substations',infra_transmission:'Transmission',infra_pipeline:'Oil / gas pipelines',infra_terminal:'Energy terminals',infra_telecom:'Telecom',infra_data_center:'Data centers',infra_dam:'Dams',infra_transport:'Transport hubs',
 wx_wind:'Wind / gusts',wx_precipitation:'Precipitation',wx_cloud:'Cloud cover',wx_visibility:'Visibility',wx_temperature:'Temperature',wx_pressure:'Pressure',wx_radar:'Rain radar',
 conflict_drone:'Drone reports',conflict_missile:'Missile reports',conflict_air:'Air alerts / strikes',conflict_other:'Other conflict reports',
};
export const WORLD_DEFAULTS=Object.fromEntries(Object.keys(WORLD_LAYERS).map(k=>[k,false])) as Record<keyof typeof WORLD_LAYERS,boolean>;
export function toggleWorldLayer(prev:Record<string,boolean>,key:string){const next={...prev,[key]:!prev[key]};if(next[key]&&['wx_precipitation','wx_cloud','wx_visibility','wx_temperature','wx_pressure'].includes(key))for(const k of ['wx_precipitation','wx_cloud','wx_visibility','wx_temperature','wx_pressure'])if(k!==key)next[k]=false;return next;}
export function conflictLayer(type:string){return /DRONE/.test(type)?'conflict_drone':/MISSILE/.test(type)?'conflict_missile':/AIR|BOMB|INTERCEPTION/.test(type)?'conflict_air':'conflict_other';}
