import {it,expect} from 'vitest';
import {reportSymbol} from './symbols';
import {recordMatchesThreatLayer} from '@/lib/world/types';
it('icons describe explicit reported category without direction or trajectory',()=>{
 for(const [type,icon] of [['DRONE_THREAT','drone'],['MISSILE_THREAT','rocket'],['ARTILLERY','impact'],['HEARD_SOUND','sound'],['HEARD_EXPLOSION','sound'],['ALL_CLEAR','clear'],['UNKNOWN','warning']])expect(reportSymbol(type)).toBe(icon);
});
it('official primary alert and explicit threat types match multiple layers without duplicating the record',()=>{
 const r={subtype:'AIR_RAID_ALERT',properties:{threat_types:['DRONE_THREAT','BALLISTIC_MISSILE_THREAT']}};
 for(const layer of ['conflict_air','conflict_drone','conflict_missile'])expect(recordMatchesThreatLayer(r,layer)).toBe(true);
 expect(recordMatchesThreatLayer({subtype:'ALL_CLEAR',properties:{}},'conflict_air')).toBe(true);expect(recordMatchesThreatLayer(r,'conflict_other')).toBe(false);expect(recordMatchesThreatLayer({subtype:'AIR_RAID_ALERT',properties:{}},'conflict_drone')).toBe(false);
});
