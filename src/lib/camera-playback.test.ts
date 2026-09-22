import { afterEach, describe, expect, it, vi } from 'vitest';
import Hls from 'hls.js';
import { skylineSnapshotMatches } from './camera-feed';
import { startVideoPlayback, STARTUP_TIMEOUT_MS, cameraPlan, iframeResult, mediaPresentation } from './camera-playback';

class Video extends EventTarget {
  src = ''; currentTime = 0; readyState = 0; videoWidth = 0; paused = false;
  play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); load = vi.fn();
  removeAttribute = vi.fn(); canPlayType = () => '';
}
class FakeHls {
  static isSupported = () => true; static Events = Hls.Events; static ErrorTypes = Hls.ErrorTypes;
  static instances: FakeHls[] = [];
  handlers = new Map<string, (...args: unknown[]) => void>();
  destroy = vi.fn(); stopLoad = vi.fn(); loadSource = vi.fn(); attachMedia = vi.fn(); recoverMediaError = vi.fn();
  constructor() { FakeHls.instances.push(this); }
  on(name: string, cb: (...args: unknown[]) => void) { this.handlers.set(name, cb); }
  emit(name: string, data = {}) { this.handlers.get(name)?.(name, data); }
}
function session(kind: 'hls' | 'mp4' = 'hls') {
  vi.useFakeTimers(); const video = new Video(), report = vi.fn();
  const stop = startVideoPlayback(video as unknown as HTMLVideoElement, 'https://camera.example/live.m3u8', kind, report, FakeHls as unknown as typeof Hls);
  return { video, report, stop, hls: FakeHls.instances.at(-1)! };
}
afterEach(() => { vi.useRealTimers(); FakeHls.instances = []; });
describe('actual camera playback lifecycle', () => {
  it('manifest success is not playback; decoded playing is', () => {
    const s = session(); s.hls.emit(Hls.Events.MANIFEST_PARSED);
    expect(s.report.mock.lastCall?.[0].status).toBe('STARTING');
    s.video.readyState = 3; s.video.videoWidth = 640; s.video.dispatchEvent(new Event('playing'));
    expect(s.report.mock.lastCall?.[0].status).toBe('STREAM_AVAILABLE'); s.stop();
  });
  it('never-starting HLS has a hard deadline and destroys transport', () => {
    const s = session(); vi.advanceTimersByTime(STARTUP_TIMEOUT_MS + 1);
    expect(s.report.mock.lastCall?.[0]).toMatchObject({ status: 'STREAM_OFFLINE', error: 'STARTUP_TIMEOUT' });
    expect(s.hls.destroy).toHaveBeenCalledOnce(); s.stop(); expect(s.hls.destroy).toHaveBeenCalledOnce();
  });
  it('fatal forbidden manifests are blocked; snapshot remains a separate capability', () => {
    const s = session(); s.hls.emit(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, response: { code: 403 } });
    expect(s.report.mock.lastCall?.[0].status).toBe('STREAM_BLOCKED');
    expect(cameraPlan({ stream_type: 'hls', stream_url: 'https://x/live.m3u8', feed_url: 'https://x/frame.jpg' }).snapshot).toBe('https://x/frame.jpg');
    expect(s.hls.destroy).toHaveBeenCalledOnce(); s.stop();
  });
  it('bounds nonfatal network retries and one media recovery', () => {
    const s = session();
    for (let i = 0; i < 6; i++) s.hls.emit(Hls.Events.ERROR, { fatal: false, type: Hls.ErrorTypes.NETWORK_ERROR });
    expect(s.report.mock.lastCall?.[0].error).toBe('NETWORK_OR_CORS'); s.stop();
    const other = session(); other.hls.emit(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR });
    expect(other.hls.recoverMediaError).toHaveBeenCalledOnce();
    other.hls.emit(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR });
    expect(other.hls.destroy).toHaveBeenCalledOnce(); other.stop();
  });
  it('camera switch destroys old instance; retry creates clean instance and ignores late callbacks', () => {
    const first = session(); first.stop(); const calls = first.report.mock.calls.length;
    first.hls.emit(Hls.Events.ERROR, { fatal: true }); first.video.dispatchEvent(new Event('playing'));
    expect(first.report).toHaveBeenCalledTimes(calls); expect(first.hls.destroy).toHaveBeenCalledOnce();
    const second = session(); expect(second.hls).not.toBe(first.hls); second.stop();
  });
  it('native MP4 requires actual advancing frames too', () => {
    const s = session('mp4'); s.video.readyState = 3; s.video.videoWidth = 320; s.video.currentTime = 1; s.video.dispatchEvent(new Event('timeupdate'));
    expect(s.report.mock.lastCall?.[0].status).toBe('STREAM_AVAILABLE'); s.stop();
  });
  it('iframe load is not proof of playing; no load times out', () => {
    expect(iframeResult(true, false)).toEqual({ status: 'UNKNOWN', error: 'EMBED_PLAYBACK_UNVERIFIED' });
    expect(iframeResult(false, false).error).toBe('EMBED_TIMEOUT');
    expect(iframeResult(true, true).status).toBe('STREAM_AVAILABLE');
  });
  it('a working but reassigned Skyline image is not shown under a wrong place name', () => {
    const c = { external_url: 'https://www.skylinewebcams.com/en/webcam/a.html', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive343.jpg' };
    expect(skylineSnapshotMatches(c, '177')).toBe(false);
    expect(skylineSnapshotMatches(c)).toBe(false);
    expect(skylineSnapshotMatches(c, '343')).toBe(true);
  });
  it('HLS failure falls back without claiming an image before it loads', () => {
    expect(mediaPresentation('hls', true, 'STREAM_OFFLINE', 'UNKNOWN')).toMatchObject({ failed: true, showSnapshot: true, caption: 'Loading snapshot…' });
    expect(mediaPresentation('hls', true, 'STREAM_OFFLINE', 'SNAPSHOT_AVAILABLE').caption).toBe('LIVE VIDEO UNAVAILABLE · SHOWING SNAPSHOT');
    expect(mediaPresentation('hls', true, 'STREAM_OFFLINE', 'SNAPSHOT_UNAVAILABLE').caption).toBe('Snapshot unavailable');
    expect(mediaPresentation('mp4', false, 'STREAM_AVAILABLE', 'UNKNOWN').caption).toBe('VIDEO CLIP · CAPTURE TIME NOT VERIFIED');
  });
  it('legacy feed-only video works; unknown transport cannot wait forever', () => {
    expect(cameraPlan({ stream_type: 'hls', feed_url: 'https://x/live.m3u8' })).toMatchObject({ kind: 'hls', video: 'https://x/live.m3u8', snapshot: null });
    expect(cameraPlan({ stream_type: 'rtsp', stream_url: 'https://x/opaque' }).kind).toBe('unsupported');
    expect(mediaPresentation('unsupported', false, 'STREAM_UNSUPPORTED', 'UNKNOWN').failed).toBe(true);
  });
  it('snapshot, video and external-only plans never claim each other healthy', () => {
    expect(cameraPlan({ feed_url: 'https://x/frame.jpg' })).toMatchObject({ kind: 'jpg', video: null });
    expect(cameraPlan({ external_url: 'https://provider.example/camera' })).toMatchObject({ kind: 'external', video: null });
    expect(cameraPlan({ stream_type: 'mp4', stream_url: 'https://x/movie.mp4' }).kind).toBe('mp4');
    expect(cameraPlan({ stream_type: 'hls', stream_url: 'https://x/live.m3u8', feed_url: 'https://x/live.m3u8' }).snapshot).toBeNull();
    expect(cameraPlan({ feed_url: 'javascript:alert(1)' }).snapshot).toBeNull();
  });
});
