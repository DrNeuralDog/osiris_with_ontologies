import { it, expect } from 'vitest';
import { validAOI, reportCoordinates, reportGroup, visibleSnapshot, filteredFeatures, type AirState } from './types';
import { OFFICIAL_PROVIDERS, officialType } from './providers';
it('blank acoustic report coordinates never become invented zero coordinates', () => {
    for (const value of ['', ',', ' , ', '50,', ',30', 'NaN,30', '91,30', '50,181']) expect(reportCoordinates(value)).toBeNull();
    expect(reportCoordinates('0,0')).toEqual([0,0]);
    expect(reportCoordinates('50,30')).toEqual([50,30]);
});
it('AOI switches are country-neutral and hard bounded', () => { for (const a of [{ name: 'Any city', bbox: '20,30,21,31', admin: '' }, { name: 'District', bbox: '', admin: 'new-provider:7' }])
    expect(validAOI(a)).toBe(true); expect(validAOI({ name: 'world', bbox: '-180,-90,180,90', admin: '' })).toBe(false); expect(validAOI({ name: 'bad', bbox: 'a,2,3,4', admin: '' })).toBe(false); });
it('official adapter can represent new permitted taxonomy without endpoint fallback', () => { const adapter = { ...OFFICIAL_PROVIDERS.find(p => p.id === 'israel-hfc')!, taxonomy: { fixture_rocket: 'ROCKET_ALERT' } }; expect(officialType(adapter, 'fixture_rocket')).toBe('ROCKET_ALERT'); expect(officialType(adapter, 'unknown')).toBeNull(); expect(adapter.fetch).toBeUndefined(); });
it('live data cannot bleed into replay or be shown before its retained time', () => { const s = { at: '2026-09-21T10:00:00Z' } as AirState; expect(visibleSnapshot(s, 'live', 'replay', Date.parse(s.at))).toBeNull(); expect(visibleSnapshot(s, 'replay', 'replay', Date.parse(s.at) - 1)).toBeNull(); expect(visibleSnapshot(s, 'replay', 'live', Date.parse(s.at))).toBeNull(); expect(visibleSnapshot(s, 'replay', 'replay', Date.parse(s.at))).toBe(s); });
it('category toggles filter retained reports without creating paths', () => { expect(reportGroup('HEARD_EXPLOSION')).toBe('Acoustic'); expect(reportGroup('AIR_RAID_ALERT')).toBe('Official alerts'); expect(reportGroup('GUIDED_BOMB_THREAT')).toBe('Guided bomb'); const s = { reports: [{ id: '1', type: 'DRONE_REPORT' }, { id: '2', type: 'HEARD_EXPLOSION' }], features: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: '1' }, geometry: { type: 'Point', coordinates: [30, 50] } }, { type: 'Feature', properties: { id: '2' }, geometry: { type: 'Point', coordinates: [30, 50] } }] } } satisfies {
    reports: {
        id: string;
        type: string;
    }[];
    features: GeoJSON.FeatureCollection;
}; const f = filteredFeatures(s, ['Acoustic']); expect(f.features.length).toBe(1); expect(f.features[0].geometry.type).toBe('Point'); });
