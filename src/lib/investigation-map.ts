import type { InvestigationMapFocus } from './intelligence';
/** Only the selected investigation is drawn. Gaps are not claimed as observed paths. */
export function investigationFeatures(focus: InvestigationMapFocus | null): GeoJSON.Feature[] {
  if (!focus) return [];
  const points: {lat: number; lng: number; at?: string}[] = (focus.points?.length ? focus.points : [focus]).slice(0, 200).filter(p => Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180);
  const features: GeoJSON.Feature[] = points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { label: focus.label } }));
  for (let i = 1; i < points.length; i++) {
    if (focus.track) continue; // Discrete retained points; no implied route between them.
    const a = points[i - 1], b = points[i];
    if (Math.abs(a.lng - b.lng) > 180) continue;
    if (focus.track && (!a.at || !b.at || Math.abs(Date.parse(b.at) - Date.parse(a.at)) > 30 * 60000)) continue;
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] }, properties: { label: focus.track ? 'Sampled historical positions; intervening path unknown' : 'Related signals; not causation' } });
  }
  return features;
}
