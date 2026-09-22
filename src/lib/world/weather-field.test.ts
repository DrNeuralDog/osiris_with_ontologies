import {describe,it,expect} from 'vitest';
import {weatherGridSpec,weatherOptions} from './weather-grid';
import {normalizeWeather} from './weather';
import {toggleWorldLayerGroup} from './types';
import {scalarFeatures,windFeatures,windPixelSize,selectedWeatherField} from './weather-field';

describe('adaptive weather field',()=>{
 it('validates zoom/device options before network',()=>{
  expect(weatherOptions(new URLSearchParams('zoom=8&quality=low'))).toEqual({zoom:8,quality:'low'});
  for(const q of ['zoom=NaN','zoom=99','quality=unlimited','zoom='])expect(()=>weatherOptions(new URLSearchParams(q))).toThrow('INVALID');
 });
 it('bounds sampling by zoom, aspect and device; samples include viewport edges',()=>{
  for(const zoom of [0,3,6,12,20])for(const quality of ['low','standard'] as const){
   const s=weatherGridSpec([-180,-85,180,85],{zoom,quality});
   expect(s.points.length).toBeLessThanOrEqual(quality==='low'?36:81);
   expect(s.points[0]).toEqual([-85,-180]);expect(s.points.at(-1)).toEqual([85,180]);
  }
  expect(weatherGridSpec([30,49,32,51],{zoom:8}).points.length).toBeGreaterThan(weatherGridSpec([30,49,32,51],{zoom:2}).points.length);
 });
 it('bilinear display field has bounded polygons and retains zeros; missing data is not zero',()=>{
  const spec=weatherGridSpec([0,0,2,2],{zoom:2});
  const records=normalizeWeather(spec.points.map(([lat,lon])=>({current:{time:'2026-09-22T10:00',temperature_2m:lat+lon,precipitation:0,wind_speed_10m:3,wind_direction_10m:270}})),spec.points);
  const field=scalarFeatures(records,spec,'temperature_c');
  expect(field.features.length).toBeGreaterThan(1000);expect(field.features.length).toBeLessThanOrEqual(4096);
  expect(field.features[0].properties?.value).toBeGreaterThan(0);
  expect(field.features.at(-1)?.properties?.value).toBeLessThan(4);
  expect(scalarFeatures(records,spec,'precipitation_mm').features.length).toBe(field.features.length);
  expect(scalarFeatures(records,spec,'visibility_m').features).toHaveLength(0);
  expect(field.features[0].properties?.interpolated).toBe(true);
 });
 it('wind arrows are screen-sized at world, regional and city zoom without fake displacement',()=>{
  const records=normalizeWeather({current:{time:'2026-09-22T10:00',wind_speed_10m:2,wind_direction_10m:270}},[[50,30]]);
  const f=windFeatures(records).features[0];expect(f.geometry).toEqual({type:'Point',coordinates:[30,50]});expect(f.properties?.bearing).toBe(90);
  for(const z of [0,4,8,16,22])for(const s of [0,2,20,100]){expect(windPixelSize(s,z)).toBeGreaterThanOrEqual(18);expect(windPixelSize(s,z)).toBeLessThanOrEqual(42);}
 });
 it('scalar switches never affect wind or radar; disabling clears field',()=>{
  expect(selectedWeatherField({wx_wind:true,wx_radar:true})).toBeNull();
  expect(selectedWeatherField({wx_cloud:true})?.property).toBe('cloud_percent');
  expect(selectedWeatherField({wx_pressure:true})?.property).toBe('pressure_hpa');
 });
 it('group ALL still permits only one scalar field; group NONE clears weather only',()=>{
  const keys=['wx_wind','wx_precipitation','wx_cloud','wx_visibility','wx_temperature','wx_pressure','wx_radar'];
  const on=toggleWorldLayerGroup({flights:true},keys);expect(keys.filter(k=>k!=='wx_wind'&&k!=='wx_radar'&&on[k])).toEqual(['wx_pressure']);expect(on.wx_wind&&on.wx_radar&&on.flights).toBe(true);
  const off=toggleWorldLayerGroup(on,keys);expect(keys.some(k=>off[k])).toBe(false);expect(off.flights).toBe(true);
 });
});
