import { NextRequest, NextResponse } from 'next/server';
import { allowedImageUrl, fetchCameraImage } from '@/lib/cctv-image';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * CCTV image proxy — bypasses CORS / hotlink protection on camera CDNs.
 * Whitelisted domains only to prevent open-proxy abuse.
 */
/**
 * The type to serve a frame as.
 *
 * Singapore's LTA cameras label every JPEG `application/octet-stream` and send
 * `X-Content-Type-Options: nosniff` with it, so the browser refuses to render
 * it in an <img> and all nine cameras showed as broken. The first bytes of a
 * file say what it is; a declared image type is taken at its word.
 */
export function imageType(data: Buffer, declared: string): string {
  if (/^image\//i.test(declared)) return declared;
  const head = data.subarray(0, 12);
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return declared;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (!allowedImageUrl(target.href)) {
    return NextResponse.json({ error: 'Forbidden domain: ' + target.hostname }, { status: 403 });
  }

  try {
    const result = await fetchCameraImage(target.href);

    if (result.status >= 400) {
      return NextResponse.json({ error: `Upstream ${result.status}` }, { status: result.status });
    }

    // Never serve upstream login HTML or active SVG on our origin.
    const contentType = imageType(result.data, '');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(contentType)) return NextResponse.json({ error: 'Upstream did not return a supported image' }, { status: 502 });
    return new NextResponse(new Uint8Array(result.data), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=10',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error: unknown) {
    console.error('Camera proxy error:', error instanceof Error ? error.message : 'IMAGE_UNAVAILABLE');
    return NextResponse.json({ error: 'Proxy failed: ' + (error instanceof Error ? error.message : 'unknown') }, { status: 502 });
  }
}
