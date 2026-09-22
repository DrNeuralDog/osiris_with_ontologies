import type {Map} from 'maplibre-gl';
export function reportSymbol(type:string){return type.startsWith('HEARD_')?'sound':type==='ALL_CLEAR'?'clear':type.includes('DRONE')?'drone':/MISSILE|ROCKET/.test(type)?'rocket':/EXPLOSION|STRIKE|ARTILLERY|SHELLING/.test(type)?'impact':'warning';}
const PATHS:Record<string,string>={
 drone:'M9 9L5 5M15 9L19 5M9 15L5 19M15 15L19 19M9 9H15V15H9ZM2 5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M16 5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M2 19a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M16 19a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
 rocket:'M9 15C8 8 14 3 21 3C21 10 16 16 9 15ZM9 10L4 11L3 16L9 15M14 15L13 20L8 21L9 15M6 18L3 21M15 8L17 8',
 impact:'M12 2L14 8L20 4L17 10L23 12L17 14L20 20L14 17L12 23L10 17L4 20L7 14L1 12L7 10L4 4L10 8Z',
 sound:'M3 9H7L12 5V19L7 15H3ZM16 8Q21 12 16 16M19 4Q27 12 19 20',
 warning:'M12 3L22 21H2ZM12 9V14M12 17V18',
 clear:'M3 12L9 18L21 5',
};
/** Small WebGL sprites; no DOM marker per report. Icons denote source wording. */
export function ensureReportSymbols(map:Map){
 for(const [name,path]of Object.entries(PATHS)){
  const id=`report-${name}`;if(map.hasImage(id))continue;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const c=canvas.getContext('2d');if(!c)continue;
  c.scale(1.15,1.15);c.translate(2,2);c.strokeStyle='#ffffff';c.lineWidth=1.7;c.lineCap='round';c.lineJoin='round';c.stroke(new Path2D(path));
  map.addImage(id,{width:32,height:32,data:c.getImageData(0,0,32,32).data});
 }
}
