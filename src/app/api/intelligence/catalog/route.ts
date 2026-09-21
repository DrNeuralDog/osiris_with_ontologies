import { NextResponse } from 'next/server';
import { getAllAirports } from '@/lib/airports';
import { NUCLEAR_FACILITIES } from '@/app/api/infrastructure/route';
export async function GET() {
  return NextResponse.json({ airports: getAllAirports(), infrastructure: NUCLEAR_FACILITIES, source: 'Existing OSIRIS reference catalogs', state: 'IMPORTED' }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
