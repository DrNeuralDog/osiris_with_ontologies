import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
export async function POST(req: Request) {
    const origin = req.headers.get('origin');
    try {
        if (origin && new URL(origin).host !== (req.headers.get('host') || new URL(req.url).host))
            return NextResponse.json({ error: 'Cross-origin request denied' }, { status: 403 });
    }
    catch {
        return NextResponse.json({ error: 'Invalid origin' }, { status: 400 });
    }
    if (isRateLimited(`air-acoustic:${getClientIp(req)}`, 20, 60000))
        return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    if (new URL(req.url).search)
        return NextResponse.json({ error: 'Unexpected query' }, { status: 400 });
    try {
        const reader = req.body?.getReader();
        let text = '', size = 0;
        const decoder = new TextDecoder();
        if (reader)
            try {
                while (true) {
                    const r = await reader.read();
                    if (r.done)
                        break;
                    size += r.value.length;
                    if (size > 2000) {
                        await reader.cancel();
                        return NextResponse.json({ error: 'Input too large' }, { status: 413 });
                    }
                    text += decoder.decode(r.value, { stream: true });
                }
            }
            finally {
                reader.releaseLock();
            }
        let body;
        try {
            body = JSON.parse(text + decoder.decode());
        }
        catch {
            return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['observation_id', 'at', 'scenario', 'reference_db', 'reference_m', 'background_db'].includes(k)))
            return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
        const base = process.env.INTEL_URL || (process.env.NODE_ENV === 'production' ? 'http://osiris-intel:4000' : 'http://localhost:4000');
        const response = await fetch(`${base}/intelligence/air-threat/acoustic`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        return NextResponse.json(await response.json(), { status: response.status });
    }
    catch {
        return NextResponse.json({ error: 'Acoustic service unavailable' }, { status: 502 });
    }
}
