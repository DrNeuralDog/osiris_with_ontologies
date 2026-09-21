import { trackedFetch as fetch } from '@/lib/source-health-reporter';
import { NextResponse } from 'next/server';
import {
  parseFeodoBlocklist,
  FEODO_SOURCE,
  FEODO_SOURCE_URL,
  type C2Indicator,
} from '@/lib/c2-indicators';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — botnet C2 indicators from abuse.ch Feodo Tracker.
 *
 * One indicator per listed command-and-control server, carrying only what the
 * blocklist reports. This route does not synthesise attacker origins, attack
 * actions or duplicate events; see `@/lib/c2-indicators` for what it used to
 * do and why that was wrong.
 *
 * `fetched_at` is when OSIRIS polled the provider. It is not an observation
 * time — those are each indicator's `first_seen` and `last_online`.
 */

interface C2Payload {
  indicators: C2Indicator[];
  total: number;
  online: number;
  fetched_at: string;
  source: string;
  source_url: string;
}

let cached: C2Payload | null = null;
let cacheTime = 0;
const CACHE_TTL = 300_000; // 5 min — the blocklist changes on the order of hours

const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' };

export async function GET() {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cached, { headers: CACHE_HEADERS });
  }

  try {
    const res = await fetch('https://feodotracker.abuse.ch/downloads/ipblocklist.json', {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: { 'User-Agent': 'OSIRIS/4.3', Accept: 'application/json' },
    });

    if (!res.ok) {
      return NextResponse.json({ indicators: [], total: 0, online: 0, error: 'Feodo unavailable' });
    }

    const indicators = parseFeodoBlocklist(await res.json());

    const result: C2Payload = {
      indicators,
      total: indicators.length,
      online: indicators.filter(i => i.status === 'online').length,
      fetched_at: new Date().toISOString(),
      source: FEODO_SOURCE,
      source_url: FEODO_SOURCE_URL,
    };

    cached = result;
    cacheTime = now;

    return NextResponse.json(result, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error('[OSIRIS] C2 indicator feed error:', error);
    return NextResponse.json({ indicators: [], total: 0, online: 0, error: 'Feed unavailable' }, { status: 500 });
  }
}
