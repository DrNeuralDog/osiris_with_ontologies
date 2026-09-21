'use client';
import { useEffect, type RefObject } from 'react';
import type { Map, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { useAirThreat } from './AirThreatProvider';
import { filteredFeatures } from '@/lib/air-threat/types';
export default function AirThreatMap({ mapRef, ready }: {
    mapRef: RefObject<Map | null>;
    ready: boolean;
}) {
    const { open, state, groups, heat, envelopes, acoustic, select, setAcoustic, setViewport } = useAirThreat();
    useEffect(() => { const map = mapRef.current; if (!ready || !map)
        return; const update = () => { const b = map.getBounds(); setViewport([Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())].map(v => v.toFixed(4)).join(',')); }; update(); map.on('moveend', update); return () => { map.off('moveend', update); }; }, [ready, mapRef, setViewport]);
    useEffect(() => {
        const m = mapRef.current;
        if (!ready || !m)
            return;
        const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
        for (const id of ['civilian-reports', 'civilian-clusters', 'civilian-acoustic'])
            if (!m.getSource(id))
                m.addSource(id, { type: 'geojson', data: empty });
        if (!m.getLayer('civilian-heat'))
            m.addLayer({ id: 'civilian-heat', type: 'heatmap', source: 'civilian-reports', paint: { 'heatmap-weight': ['get', 'weight'], 'heatmap-radius': 35, 'heatmap-opacity': .45, 'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .3, '#6366f1', .6, '#e879f9', 1, '#f9a8d4'] } });
        if (!m.getLayer('civilian-envelopes'))
            m.addLayer({ id: 'civilian-envelopes', type: 'fill', source: 'civilian-clusters', paint: { 'fill-color': '#a78bfa', 'fill-opacity': .12, 'fill-outline-color': '#c4b5fd' } });
        if (!m.getLayer('civilian-acoustic'))
            m.addLayer({ id: 'civilian-acoustic', type: 'fill', source: 'civilian-acoustic', paint: { 'fill-color': '#67e8f9', 'fill-opacity': .1, 'fill-outline-color': '#67e8f9' } });
        if (!m.getLayer('civilian-points'))
            m.addLayer({ id: 'civilian-points', type: 'circle', source: 'civilian-reports', paint: { 'circle-color': ['match', ['get', 'source_class'], 'OFFICIAL', '#fbbf24', 'PUBLIC_REPORT', '#c4b5fd', '#7dd3fc'], 'circle-radius': ['case', ['==', ['get', 'source_class'], 'OFFICIAL'], 9, 5], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': ['match', ['get', 'age_state'], 'RECENT', 1, 'FRESH', .8, 'AGING', .55, .3] } });
        const features = open ? filteredFeatures(state, groups) : empty, visible = new Set(features.features.map(f => f.properties?.id));
        (m.getSource('civilian-reports') as GeoJSONSource).setData(features);
        m.setLayoutProperty('civilian-heat', 'visibility', open && heat ? 'visible' : 'none');
        (m.getSource('civilian-clusters') as GeoJSONSource).setData({ type: 'FeatureCollection', features: open && envelopes ? state?.clusters.filter(c => c.geometry && c.report_ids.every(id => visible.has(id))).map(c => ({ type: 'Feature' as const, properties: { id: c.id }, geometry: c.geometry! })) || [] : [] });
        (m.getSource('civilian-acoustic') as GeoJSONSource).setData({ type: 'FeatureCollection', features: open ? acoustic?.zones.map(z => ({ type: 'Feature' as const, properties: { label: z.label }, geometry: z.geometry })) || [] : [] });
        m.getContainer().dataset.airThreatPoints = String(features.features.length);
        const click = (e: MapLayerMouseEvent) => { const id = e.features?.[0]?.properties?.id; const item = state?.reports.find(r => r.id === id) || state?.clusters.find(r => r.id === id); if (item) {
            select(item);
            setAcoustic(null);
        } };
        m.on('click', 'civilian-points', click);
        m.on('click', 'civilian-envelopes', click);
        return () => { m.off('click', 'civilian-points', click); m.off('click', 'civilian-envelopes', click); };
    }, [ready, mapRef, open, state, groups, heat, envelopes, acoustic, select, setAcoustic]);
    return null;
}
