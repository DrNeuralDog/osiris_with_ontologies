import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./ssrf-guard', () => ({ validateHost: vi.fn().mockResolvedValue({ ok: true }) }));
import { resolutionTTL, resolvableUrl, resolveCameraPage, skylineSnapshotId } from './camera-resolver';
afterEach(() => vi.unstubAllGlobals());
describe('bounded camera resolver', () => {
  const skyline = 'https://www.skylinewebcams.com/en/webcam/test.html';
  it('validates host, protocol, credential and URL shape', () => {
    expect(resolvableUrl(skyline)).toBe(true); expect(resolvableUrl('https://www.youtube.com/@operator/live')).toBe(true);
    for (const url of ['https://evil.example/?skylinewebcams.com', 'http://localhost/', 'https://user:pass@www.skylinewebcams.com/en/webcam/a.html', 'https://stream.example/live.m3u8']) expect(resolvableUrl(url)).toBe(false);
  });
  it('resolves public YouTube embeds but does not expose protected HLS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response("videoId:'abcdefghijk'")).mockResolvedValueOnce(new Response('protected.m3u8')));
    expect(await resolveCameraPage(skyline)).toMatchObject({ kind: 'youtube', videoId: 'abcdefghijk', embeddable: true }); expect(await resolveCameraPage(skyline)).toEqual({ kind: 'hls', embeddable: false });
  });
  it('extracts current page snapshot identity without inventing a stream URL', () => {
    expect(skylineSnapshotId('<meta property="og:image" content="https://cdn.skylinewebcams.com/social177.jpg">')).toBe('177');
    expect(skylineSnapshotId('<meta property="og:image" content="https://evil.test/social177.jpg">')).toBeUndefined();
  });
  it('network failure is short-lived and distinct from source offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(new Response('<strong>OFFLINE</strong>')));
    const failed = await resolveCameraPage(skyline); expect(failed.kind).toBe('unreachable'); expect(resolutionTTL(failed)).toBe(30000); expect((await resolveCameraPage(skyline)).kind).toBe('offline');
  });
  it('rejects off-provider redirects and oversized pages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, {status:302,headers:{location:'http://127.0.0.1/'}})).mockResolvedValueOnce(new Response('a'.repeat(2*1024*1024+1))));
    expect((await resolveCameraPage(skyline)).kind).toBe('unreachable'); expect(fetch).toHaveBeenCalledTimes(1); expect((await resolveCameraPage(skyline)).kind).toBe('unreachable');
  });
});
