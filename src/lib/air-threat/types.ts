import policy from '../../../intel/intelligence/air-policy.json';
import type { Provenance } from '@/lib/ontology';
import type { Observation } from '@/lib/intelligence';
export const AIR_POLICY = policy;
export type SourceClass = 'OFFICIAL' | 'STRUCTURED_OSINT' | 'PUBLIC_REPORT' | 'DERIVED';
export interface AirReport {
    id: string;
    object_id: string;
    name: string;
    type: string;
    provider: string;
    source_class: SourceClass;
    provider_raw_type: string;
    at: string;
    lat: number | null;
    lon: number | null;
    precision: string;
    area_ids: string[];
    area_name: string;
    source_family: string;
    source_record_id: string | null;
    lineage_key: string | null;
    provenance: Provenance[];
    data: Record<string, unknown>;
    observation: Observation;
}
export interface AirCluster {
    id: string;
    kind: string;
    report_ids: string[];
    object_ids: string[];
    report_count: number;
    unique_signals: number;
    source_families: string[];
    independent_sources: number | null;
    independence_note: string;
    official_alerts: number;
    from: string;
    to: string;
    precision: string[];
    state: string;
    match_method: string;
    geometry: GeoJSON.Polygon | null;
    explanation: string;
    assumptions: Record<string, unknown>;
    model_version: string;
}
export interface AirState {
    at: string;
    reports: AirReport[];
    clusters: AirCluster[];
    official: {
        id: number;
        object_id: string;
        canonical_name: string;
        status: string;
        confirmed_until: string;
        source_time: string;
        data: Record<string, unknown>;
        provenance: Provenance[];
    }[];
    official_status: string;
    providers: {
        id: string;
        name: string;
        status: string;
        credential_state: string;
        latest_update: string | null;
        available: boolean;
        metadata: {
            coverage?: string[];
        };
    }[];
    coverage: string;
    coverage_gaps: string[];
    provider_health_basis: string;
    truncated: boolean;
    counts: {
        last15: number;
        last30: number;
        last60: number;
        acoustic: number;
        official_active: number;
        clusters: number;
        classes: Record<string, number>;
    };
    features: GeoJSON.FeatureCollection;
}
export interface Audibility {
    status: string;
    model_version: string;
    model: string;
    uncertainty: string;
    location_precision: string;
    weather_state?: string;
    weather_timestamp: string | null;
    terrain_state: string;
    land_cover_state: string;
    assumptions: string[];
    zones: {
        label: string;
        geometry: GeoJSON.Polygon;
    }[];
    provenance: Provenance[];
}
export interface AOI {
    name: string;
    bbox: string;
    admin: string;
}
export const DISCLAIMER = 'Official civil-defense alerts take priority. OSIRIS provides supplementary context from delayed and potentially incomplete open sources.';
export function reportCoordinates(value: string): [number, number] | null {
    const parts = value.split(',');
    if (parts.length !== 2 || parts.some(part => !part.trim())) return null;
    const [lat, lon] = parts.map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}
export function visibleSnapshot(state: AirState | null, loadedMode: 'live' | 'replay', mode: 'live' | 'replay', at: number) { return loadedMode === mode && (mode === 'live' || !state || Date.parse(state.at) <= at) ? state : null; }
export function validAOI(a: AOI) { const b = a.bbox.split(',').map(Number); return !!a.name.trim() && a.name.length <= 100 && (!a.admin || /^[a-z0-9-]+:[\w:.-]{1,100}$/i.test(a.admin)) && (!a.bbox ? !!a.admin : b.length === 4 && b.every(Number.isFinite) && Math.abs(b[0]) <= 180 && Math.abs(b[2]) <= 180 && Math.abs(b[1]) <= 90 && Math.abs(b[3]) <= 90 && b[0] < b[2] && b[1] < b[3] && b[2] - b[0] <= policy.max_aoi_degrees && b[3] - b[1] <= policy.max_aoi_degrees); }
export function reportGroup(type: string) { return type === 'HEARD_EXPLOSION' ? 'Acoustic' : type.includes('DRONE') ? 'Drone' : type.includes('MISSILE') ? 'Missile' : type === 'ROCKET_ALERT' ? 'Rocket' : type.includes('BOMB') ? 'Guided bomb' : type === 'AIR_DEFENSE_ACTIVITY' ? 'Air defence' : type === 'INTERCEPTION_REPORT' ? 'Interception' : type === 'EXPLOSION_REPORT' ? 'Explosion' : ['AIR_RAID_ALERT', 'PRE_ALERT', 'ALL_CLEAR'].includes(type) ? 'Official alerts' : 'Other conflict'; }
export const REPORT_GROUPS = ['Official alerts', 'Drone', 'Missile', 'Rocket', 'Guided bomb', 'Air defence', 'Interception', 'Explosion', 'Acoustic', 'Other conflict'];
export function filteredFeatures(state: {
    reports: Pick<AirReport, 'id' | 'type'>[];
    features: GeoJSON.FeatureCollection;
} | null, groups: string[]) { const ids = new Set(state?.reports.filter(r => groups.includes(reportGroup(r.type))).map(r => r.id)); return { type: 'FeatureCollection' as const, features: state?.features.features.filter(f => ids.has(String(f.properties?.id))) || [] }; }
