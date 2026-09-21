'use client';
import { useState } from 'react';
import type { WorldRecord } from '@/lib/world/types';
import { worldSeed } from '@/lib/world/types';
import { reportCoordinates } from '@/lib/air-threat/types';
export default function PublicAcousticReport() {
    const [url, setUrl] = useState(''), [record, setRecord] = useState(''), [description, setDescription] = useState(''), [point, setPoint] = useState(''), [at, setAt] = useState(() => new Date().toISOString()), [precision, setPrecision] = useState('LOCALITY'), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    async function save() { setBusy(true); setMessage(''); try {
        const source = new URL(url);
        if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password)
            throw new Error('Public HTTP(S) source link required');
        source.hash = '';
        const coordinates = reportCoordinates(point);
        if (!record.trim() || !description.trim() || !coordinates || !Number.isFinite(Date.parse(at)) || !/(Z|[+-]\d{2}:\d{2})$/i.test(at) || Date.parse(at) > Date.now())
            throw new Error('Complete record ID, report time, description and latitude,longitude');
        const [lat, lon] = coordinates;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${source.href}|${record.trim()}`));
        const id = 'public-report:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        const r: WorldRecord = { id, provider: 'Public report', name: `Heard explosion report · ${record.trim().slice(0, 100)}`, domain: 'conflict', subtype: 'HEARD_EXPLOSION', lat, lon, observed_at: new Date(at).toISOString(), fetched_at: new Date().toISOString(), url: source.href, evidence_state: 'REPORTED', confidence: null, geometry_precision: 'representative', location_precision: precision as WorldRecord['location_precision'], extraction_method: 'User-transcribed public report; not independently verified', source_license: 'Original source terms apply', source_attribution: source.hostname, properties: { source_class: 'PUBLIC_REPORT', provider_raw_type: 'heard explosion', raw_description: description.slice(0, 2000), source_record_id: record.trim(), canonical_source_url: source.href, source_family: source.hostname, listener_location: true } };
        const response = await fetch('/api/intelligence/investigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(worldSeed(r)) });
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error);
        setMessage('Report retained. The AOI refresh will include it. Location identifies the report area, never an inferred sound source.');
    }
    catch (e) {
        setMessage(e instanceof Error ? e.message : 'Unable to retain report');
    }
    finally {
        setBusy(false);
    } }
    return <details className="border-t border-slate-700 pt-2"><summary>Retain a public heard-explosion report</summary><p>Transcribe a real public source only. This is an unverified PUBLIC REPORT; it does not identify a weapon or sound source.</p><form onSubmit={e => { e.preventDefault(); void save(); }} className="space-y-1">{[['Public source URL', url, setUrl], ['Source record ID', record, setRecord], ['Reported at (ISO timezone)', at, setAt], ['Report latitude,longitude', point, setPoint]].map(([label, value, set]) => <label key={String(label)} className="block">{String(label)}<input required maxLength={500} aria-label={String(label)} className="w-full bg-slate-900 border border-slate-600 p-1" value={value as string} onChange={e => (set as (v: string) => void)(e.target.value)}/></label>)}<label className="block">Report precision<select aria-label="Report precision" className="bg-slate-900" value={precision} onChange={e => setPrecision(e.target.value)}>{['LOCALITY', 'DISTRICT', 'REGION', 'APPROXIMATE', 'EXACT_SOURCE_COORDINATE'].map(p => <option key={p}>{p}</option>)}</select></label><label className="block">Original description<textarea required maxLength={2000} aria-label="Original description" className="w-full bg-slate-900" value={description} onChange={e => setDescription(e.target.value)}/></label><button disabled={busy} className="underline">Retain public report</button></form>{message && <p role="status">{message}</p>}</details>;
}
