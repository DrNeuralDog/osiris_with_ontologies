import { array, record, str, timestamp, type WorldRecord, type ProviderResult } from '@/lib/world/types';
import { ProviderCache, readBoundedJSON } from '@/lib/world/server-cache';
export interface OfficialAlertProvider {
    id: string;
    name: string;
    coverage: string[];
    credentialState: () => string;
    cadenceSeconds: number | null;
    documentation: string;
    attribution: string;
    fetch?: () => Promise<ProviderResult>;
    taxonomy: Readonly<Record<string, string>>;
}
export const officialType = (provider: OfficialAlertProvider, rawType: string) => provider.taxonomy[rawType] || null;
export const ALERTS_TAXONOMY: Readonly<Record<string, string>> = { air_raid: 'AIR_RAID_ALERT', drones: 'DRONE_THREAT', unspecified_missiles: 'MISSILE_THREAT', ballistic_missiles: 'BALLISTIC_MISSILE_THREAT', cruise_missiles: 'CRUISE_MISSILE_THREAT', guided_aerial_bombs: 'GUIDED_BOMB_THREAT', air_defense: 'AIR_DEFENSE_ACTIVITY' };
/** Only explicitly documented subtype mapping. Aviation activity is retained raw, not guessed. */
export function normalizeAlerts(body: unknown, fetchedAt = new Date().toISOString()): WorldRecord[] {
    return array(record(body).alerts).slice(0, 200).flatMap(value => {
        const r = record(value), id = str(r.id), started = timestamp(r.started_at), finished = timestamp(r.finished_at), updated = timestamp(r.updated_at) || started, uid = str(r.location_uid);
        if (!/^\d+$/.test(id) || !started || !/^\d+$/.test(uid) || r.alert_type !== 'air_raid')
            return [];
        const threats = array(r.threats).map(record), mapped = threats.map(t => ALERTS_TAXONOMY[str(t.threat_type)]).filter(Boolean), subtype = finished ? 'ALL_CLEAR' : 'AIR_RAID_ALERT';
        return [{ id: `alerts-in-ua:${id}`, provider: 'alerts.in.ua', name: `${subtype.replaceAll('_', ' ')} · ${str(r.location_title_en || r.location_title)}`, domain: 'conflict', subtype, lat: null, lon: null, observed_at: finished || updated, fetched_at: fetchedAt, url: 'https://alerts.in.ua/', evidence_state: 'REPORTED', confidence: null, geometry_precision: 'representative', location_precision: r.location_type === 'oblast' ? 'REGION' : ['raion', 'hromada'].includes(String(r.location_type)) ? 'DISTRICT' : r.location_type === 'city' ? 'LOCALITY' : 'UNKNOWN', extraction_method: 'Documented civil alert relay; only explicit provider threat taxonomy', source_license: 'alerts.in.ua API terms; supplementary use only', source_attribution: 'alerts.in.ua — official-source relay operated by volunteers', properties: { source_class: 'OFFICIAL', official_relay: true, provider_raw_type: r.alert_type, provider_raw_metadata: r, threat_types: mapped, unmapped_threat_types: threats.map(t => str(t.threat_type)).filter(t => !ALERTS_TAXONOMY[t]), alert_status: finished ? 'CLEAR' : 'ACTIVE', source_family: 'alerts.in.ua', area_ids: [`alerts-in-ua:${uid}`, ...(/^\d+$/.test(str(r.location_oblast_uid)) && str(r.location_oblast_uid) !== uid ? [`alerts-in-ua:${r.location_oblast_uid}`] : [])], area_name: str(r.location_title_en || r.location_title), country: 'UA', valid_from: started, valid_to: finished, source_updated_at: updated, coordinates_unavailable: true } } satisfies WorldRecord];
    });
}
const cache = new ProviderCache('alerts-in-ua', 120000, 120000, 1, 1500);
const responses = new Map<string, {
    modified?: string;
    body: unknown;
}>();
const regions = new Map<string, number>();
let historyCursor = 0;
export async function conditionalAlerts(path: string, token: string) {
    const saved = responses.get(path), res = await fetch(`https://api.alerts.in.ua${path}`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token}`, ...(saved?.modified ? { 'If-Modified-Since': saved.modified } : {}) } });
    if (res.status === 304) {
        if (!saved)
            throw new Error('INVALID_304');
        return saved.body;
    }
    if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP_${res.status}`);
    }
    const body = await readBoundedJSON(res, 2 * 1024 * 1024);
    if (responses.size >= 34 && !responses.has(path))
        responses.delete(responses.keys().next().value!);
    responses.set(path, { modified: res.headers.get('last-modified') || undefined, body });
    return body;
}
export async function alertsInUA(): Promise<ProviderResult> {
    const token = process.env.ALERTS_IN_UA_TOKEN;
    if (!token)
        return { records: [], status: 'KEY_REQUIRED' };
    return cache.get('active', async () => {
        const at = new Date().toISOString(), body = await conditionalAlerts('/v1/alerts/active.json', token), active = normalizeAlerts(body, at);
        for (const r of active) {
            const uid = String((r.properties.area_ids as string[])[0]).split(':')[1];
            if (regions.size >= 32 && !regions.has(uid))
                regions.delete(regions.keys().next().value!);
            regions.set(uid, Date.now());
        }
        // One documented regional history request per cycle, for explicit finished_at/all-clear.
        // Absence from the active list NEVER synthesizes an ALL_CLEAR.
        const ids = [...regions.keys()];
        let historical: WorldRecord[] = [];
        if (ids.length) {
            const uid = ids[historyCursor++ % ids.length];
            const past = await conditionalAlerts(`/v1/regions/${uid}/alerts/month_ago.json`, token);
            historical = normalizeAlerts(past, at).filter(r => r.properties.alert_status === 'CLEAR' && Date.now() - Date.parse(r.observed_at!) < 21600000);
        }
        return { records: [...new Map([...active, ...historical].map(r => [r.id, r])).values()].slice(0, 200), status: 'AVAILABLE', fetched_at: at };
    });
}
export const OFFICIAL_PROVIDERS: OfficialAlertProvider[] = [
    { id: 'alerts-in-ua', name: 'alerts.in.ua · official-source relay', coverage: ['UA'], credentialState: () => process.env.ALERTS_IN_UA_TOKEN ? 'CONFIGURED' : 'KEY_REQUIRED', cadenceSeconds: 120, documentation: 'https://devs.alerts.in.ua/', attribution: 'alerts.in.ua', fetch: alertsInUA, taxonomy: ALERTS_TAXONOMY },
    { id: 'ukrainealarm', name: 'UkraineAlarm', coverage: ['UA'], credentialState: () => process.env.UKRAINE_ALARM_API_KEY ? 'DOCUMENTED_API_CONTRACT_REQUIRED' : 'KEY_REQUIRED', cadenceSeconds: null, documentation: 'https://api.ukrainealarm.com/', attribution: 'UkraineAlarm', taxonomy: {} },
    { id: 'israel-hfc', name: 'Israel Home Front Command', coverage: ['IL'], credentialState: () => 'DOCUMENTED_API_REQUIRED', cadenceSeconds: null, documentation: 'https://www.oref.org.il/eng', attribution: 'Home Front Command', taxonomy: {} },
    { id: 'detector-aero', name: 'Detector AERO · optional future provider', coverage: ['RU'], credentialState: () => 'WRITTEN_PERMISSION_OR_DOCUMENTED_API_REQUIRED', cadenceSeconds: null, documentation: '', attribution: 'Not connected', taxonomy: {} }
];
export const providerCapabilities = () => OFFICIAL_PROVIDERS.map(p => ({ id: p.id, name: p.name, coverage: p.coverage, credential_state: p.credentialState(), cadence_seconds: p.cadenceSeconds, documentation: p.documentation, attribution: p.attribution, connected: !!p.fetch && p.credentialState() === 'CONFIGURED' }));
