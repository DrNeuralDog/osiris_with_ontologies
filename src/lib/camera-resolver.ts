import { isSkylineUrl, parseSkylinePage } from './skyline';
import { extractYouTubeId, isYouTubeUrl, parseYouTubeUrl, youtubeEmbedUrl } from './youtube';
import { validateHost } from './ssrf-guard';
export type Resolution = { embeddable: boolean; kind: 'youtube' | 'hls' | 'offline' | 'missing' | 'unknown' | 'unreachable'; videoId?: string; embedUrl?: string; reason?: string; snapshot_id?: string };
export const resolutionTTL = (value: Resolution) => value.embeddable ? 1_800_000 : value.kind === 'unreachable' ? 30_000 : 300_000;
export function resolvableUrl(value: string) {
  try { const u = new URL(value); return value.length <= 2048 && u.protocol === 'https:' && !u.username && !u.password && !u.port && (isSkylineUrl(value) && u.pathname.includes('/webcam/') || isYouTubeUrl(value) && parseYouTubeUrl(value)?.kind === 'live-channel'); } catch { return false; }
}
export function skylineSnapshotId(html: string): string | undefined {
  for (const meta of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/property=["']og:image["']/i.test(meta)) continue;
    const content = meta.match(/content=["']([^"']+)["']/i)?.[1];
    return content?.match(/^https:\/\/cdn(?:2)?\.skylinewebcams\.com\/(?:social|live)([0-9]+)\.jpg(?:[?#]|$)/)?.[1];
  }
}
/** Existing public pages only. Protected manifests are not extracted. */
export async function resolveCameraPage(url: string): Promise<Resolution> {
  if (!resolvableUrl(url)) return { embeddable: false, kind: 'unknown' };
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    let current = url;
    for (let hop = 0; hop <= 2; hop++) {
      const u = new URL(current);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !(isSkylineUrl(url) ? isSkylineUrl(current) : isYouTubeUrl(current))) throw new Error('RESOLVER_REDIRECT_BLOCKED');
      const host = await Promise.race([validateHost(u.hostname), new Promise<never>((_, reject) => { if (controller.signal.aborted) reject(new Error('RESOLVER_TIMEOUT')); else controller.signal.addEventListener('abort', () => reject(new Error('RESOLVER_TIMEOUT')), { once: true }); })]); if (!host.ok) throw new Error(host.reason?.startsWith('DNS lookup failed:') ? 'RESOLVER_DNS_UNAVAILABLE' : 'RESOLVER_HOST_BLOCKED');
      const res = await fetch(current, { cache: 'no-store', redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OSIRIS/1.0)', Accept: 'text/html,application/xhtml+xml' } });
      if (res.status >= 300 && res.status < 400) { const location = res.headers.get('location'); await res.body?.cancel(); if (!location) throw new Error('REDIRECT_WITHOUT_LOCATION'); current = new URL(location, current).href; continue; }
      if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return { embeddable: false, kind: 'missing' }; }
      if (!res.ok) { await res.body?.cancel(); return { embeddable: false, kind: 'unreachable', reason: `HTTP_${res.status}` }; }
      const reader = res.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('PAGE_TOO_LARGE'); } chunks.push(chunk.value); } } finally { reader?.releaseLock(); }
      const html = Buffer.concat(chunks).toString('utf8');
      if (isSkylineUrl(url)) { const feed = parseSkylinePage(html), snapshot_id = skylineSnapshotId(html); return feed.kind === 'youtube' ? { ...feed, embeddable: true, snapshot_id } : { kind: feed.kind, embeddable: false, snapshot_id }; }
      const videoId = extractYouTubeId(html); return videoId ? { embeddable: true, kind: 'youtube', videoId, embedUrl: youtubeEmbedUrl(videoId) } : { embeddable: false, kind: 'unknown' };
    }
    return { embeddable: false, kind: 'unreachable' };
  } catch (error) { const category = error instanceof Error && /^(RESOLVER_|REDIRECT_|PAGE_TOO_LARGE)/.test(error.message) ? error.message : controller.signal.aborted ? 'RESOLVER_TIMEOUT' : 'NETWORK_ERROR'; return { embeddable: false, kind: 'unreachable', reason: category }; } finally { clearTimeout(deadline); }
}
