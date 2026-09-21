'use client';
import { useState } from 'react';
import EvidenceView from './EvidenceView';
import { useAirThreat } from './AirThreatProvider';
import { useWorldReplay } from './WorldReplayProvider';
import type { AirReport, Audibility } from '@/lib/air-threat/types';
import { worldSeed, type WorldRecord } from '@/lib/world/types';
export default function AirAcousticPanel({ report }: {
    report: AirReport;
}) {
    const air = useAirThreat(), replay = useWorldReplay(), [assumed, setAssumed] = useState(false), [reference, setReference] = useState(''), [distance, setDistance] = useState(''), [noise, setNoise] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    async function estimate() { setBusy(true); setError(''); try {
        const response = await fetch('/api/intelligence/air-threat/acoustic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observation_id: report.id, at: replay.state.mode === 'replay' ? new Date(replay.state.at).toISOString() : undefined, scenario: assumed, reference_db: Number(reference), reference_m: Number(distance), background_db: Number(noise) }) });
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error);
        air.setAcoustic(body as Audibility);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Acoustic estimate unavailable');
    }
    finally {
        setBusy(false);
    } }
    async function loadWeather() { if (report.lat == null || report.lon == null)
        return; setBusy(true); setError(''); try {
        const bbox = [report.lon - .05, report.lat - .05, report.lon + .05, report.lat + .05].join(',');
        const response = await fetch(`/api/world/weather?bbox=${bbox}`);
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error);
        const r = (data.records as WorldRecord[]).sort((a, b) => Math.hypot(a.lat! - report.lat!, a.lon! - report.lon!) - Math.hypot(b.lat! - report.lat!, b.lon! - report.lon!))[0];
        if (!r)
            throw new Error('Weather unavailable');
        const saved = await fetch('/api/intelligence/investigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(worldSeed(r)) });
        if (!saved.ok)
            throw new Error((await saved.json()).error);
        setError('One nearby model observation retained. Recalculate to use it if its valid time matches.');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Weather unavailable');
    }
    finally {
        setBusy(false);
    } }
    return <details className="border-t border-slate-700 pt-2"><summary>Estimated audibility · optional scenario</summary><p>SIMPLIFIED ACOUSTIC MODEL. A reported location alone cannot determine audibility. No inverse source localization.</p><label className="block py-2"><input type="checkbox" checked={assumed} onChange={e => setAssumed(e.target.checked)}/> Use explicit assumed sound levels; not source measurements</label>
 <div className="grid grid-cols-3 gap-1">{[['Reference dB', reference, setReference], ['Reference m', distance, setDistance], ['Background dB', noise, setNoise]].map(([label, value, set]) => <label key={String(label)}>{String(label)}<input className="w-full bg-slate-900 border border-slate-600 p-1" type="number" aria-label={String(label)} value={value as string} onChange={e => (set as (v: string) => void)(e.target.value)}/></label>)}</div>
 <div className="flex flex-wrap gap-2 my-2"><button disabled={busy || !assumed || !reference || !distance || !noise} onClick={() => void estimate()} className="underline disabled:opacity-40">Estimate scenario</button><button disabled={busy || replay.state.mode === 'replay'} onClick={() => void loadWeather()} className="underline disabled:opacity-40">Retain nearby model weather</button><button className="underline" onClick={() => air.setAcoustic(null)}>Clear acoustic overlay</button></div>
 {error && <p role="status">{error}</p>}{air.acoustic && <div><strong>{air.acoustic.status} · HIGH UNCERTAINTY</strong><p>Precision: {air.acoustic.location_precision} · {air.acoustic.uncertainty}</p><p>{air.acoustic.weather_state || 'Weather not evaluated'} · {air.acoustic.weather_timestamp || 'No weather time'}</p><p>Terrain: {air.acoustic.terrain_state} · Land cover: {air.acoustic.land_cover_state}</p>{air.acoustic.zones.map(z => <p key={z.label}>{z.label} · scenario only</p>)}<p>{air.acoustic.model_version}</p><EvidenceView items={air.acoustic.provenance}/><ul className="list-disc pl-4">{air.acoustic.assumptions.map(v => <li key={v}>{v}</li>)}</ul></div>}</details>;
}
