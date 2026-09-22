import type {Bounds} from './types';
export interface WeatherOptions {zoom?:number;quality?:'low'|'standard'}
export interface WeatherGrid {bounds:Bounds;columns:number;rows:number;points:number[][];spacing_degrees:number[]}
export function weatherOptions(q:URLSearchParams):WeatherOptions {
 const z=q.get('zoom'),quality=q.get('quality')||'standard',zoom=z===null?5:Number(z);
 if(z===''||!Number.isFinite(zoom)||zoom<0||zoom>22||!['low','standard'].includes(quality))throw new Error('INVALID_WEATHER_OPTIONS');
 return {zoom,quality:quality as 'low'|'standard'};
}
export function mercatorY(lat:number){return Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));}
export function inverseMercatorY(y:number){return (2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;}
/** Edge-inclusive regular latitude/longitude sampling, capped independently of client input. */
export function weatherGridSpec(b:Bounds,options:WeatherOptions={}):WeatherGrid {
 const zoom=options.zoom??5,max=options.quality==='low'?6:9,n=Math.min(max,zoom<4?5:zoom<8?7:9);
 const aspect=Math.max(.5,Math.min(2,(b[2]-b[0])*Math.PI/180/(mercatorY(b[3])-mercatorY(b[1]))));
 const columns=Math.min(max,Math.max(3,Math.round(n*Math.sqrt(aspect)))),rows=Math.min(max,Math.max(3,Math.round(n/Math.sqrt(aspect))));
 const points:number[][]=[];
 for(let y=0;y<rows;y++)for(let x=0;x<columns;x++)points.push([+(b[1]+(b[3]-b[1])*y/(rows-1)).toFixed(6),+(b[0]+(b[2]-b[0])*x/(columns-1)).toFixed(6)]);
 return {bounds:b,columns,rows,points,spacing_degrees:[(b[2]-b[0])/(columns-1),(b[3]-b[1])/(rows-1)]};
}
