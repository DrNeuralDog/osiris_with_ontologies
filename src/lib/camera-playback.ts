import Hls from 'hls.js';
import type { ResolvableCamera } from './camera-feed';
import { parseYouTubeUrl } from './youtube';

export const STARTUP_TIMEOUT_MS = 15_000;
export type VideoStatus = 'UNKNOWN' | 'STARTING' | 'STREAM_AVAILABLE' | 'STREAM_BLOCKED' | 'STREAM_OFFLINE' | 'STREAM_UNSUPPORTED' | 'EXTERNAL_ONLY';
export interface PlaybackResult { status: VideoStatus; error?: string; checked_at?: string; first_frame_ms?: number }
export interface PlaybackCamera extends ResolvableCamera { stream_type?: string }
/** Only browser-safe URLs, not a new server fetch/proxy surface. */
export function cameraUrl(value?: string): string | null {
  if (!value || value.length > 4096) return null;
  if (value.startsWith('/api/cctv/') && !value.startsWith('//')) return value;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function cameraPlan(camera: PlaybackCamera, resolved?: string | null) {
  const stream = cameraUrl(resolved || camera.stream_url), feed = cameraUrl(camera.feed_url);
  const declared = resolved ? 'iframe' : camera.stream_type || (stream && /\.mp4(?:[?#]|$)/i.test(stream) ? 'mp4' : stream && /\.m3u8(?:[?#]|$)/i.test(stream) ? 'hls' : feed ? 'jpg' : stream ? 'unsupported' : 'external');
  const kind = ['jpg', 'hls', 'mp4', 'iframe', 'mjpeg', 'external'].includes(declared) ? declared : 'unsupported';
  const video = stream || (['hls', 'mp4', 'iframe', 'mjpeg'].includes(kind) ? feed : null);
  const snapshot = feed && feed !== video && !/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(feed) ? feed : kind === 'jpg' ? feed || video : null;
  return { kind: !video && !snapshot ? 'external' : kind, video, snapshot, external: cameraUrl(camera.external_url) };
}
export function mediaPresentation(kind: string, hasSnapshot: boolean, status: VideoStatus, snapshot: string, snapshotOnly = false) {
  const failed = ['STREAM_OFFLINE', 'STREAM_BLOCKED', 'STREAM_UNSUPPORTED'].includes(status);
  const fallback = hasSnapshot && (failed || snapshotOnly), showSnapshot = kind === 'jpg' || fallback;
  const caption = showSnapshot ? snapshot === 'SNAPSHOT_UNAVAILABLE' ? 'Snapshot unavailable' : snapshot === 'UNKNOWN' ? 'Loading snapshot…' : fallback ? 'LIVE VIDEO UNAVAILABLE · SHOWING SNAPSHOT' : 'REFRESHING SNAPSHOT' : status === 'STREAM_AVAILABLE' ? kind === 'mp4' ? 'VIDEO CLIP · CAPTURE TIME NOT VERIFIED' : 'LIVE VIDEO' : status === 'UNKNOWN' ? 'PLAYBACK UNVERIFIED' : status;
  return { failed, showSnapshot, caption };
}
export function iframeResult(loaded: boolean, confirmed: boolean): PlaybackResult {
  return confirmed ? { status: 'STREAM_AVAILABLE' } : loaded ? { status: 'UNKNOWN', error: 'EMBED_PLAYBACK_UNVERIFIED' } : { status: 'STREAM_OFFLINE', error: 'EMBED_TIMEOUT' };
}
export function youtubeFrameUrl(url: string, origin: string) {
  const target = parseYouTubeUrl(url); if (target?.kind !== 'video') return null;
  const result = new URL(`https://www.youtube-nocookie.com/embed/${target.videoId}`);
  for (const [k, v] of Object.entries({ enablejsapi: '1', autoplay: '1', mute: '1', playsinline: '1', origin, rel: '0' })) result.searchParams.set(k, v);
  return result.href;
}

/** Shared production/test lifecycle. Manifest/metadata never imply decoded playback. */
export function startVideoPlayback(video: HTMLVideoElement, url: string, kind: 'hls' | 'mp4', report: (state: PlaybackResult) => void, Library: typeof Hls = Hls) {
  const started = Date.now(); let disposed = false, failed = false, confirmed = false, hls: Hls | null = null;
  let errors = 0, recoveries = 0, previous = video.currentTime, progressAt = started;
  const listeners: [string, EventListener][] = [];
  const emit = (state: PlaybackResult) => { if (!disposed) report({ ...state, checked_at: new Date().toISOString() }); };
  const destroyHls = () => { const instance = hls; hls = null; instance?.stopLoad(); instance?.destroy(); };
  const fail = (error: string, status: VideoStatus = 'STREAM_OFFLINE') => {
    if (disposed || failed) return; failed = true; destroyHls(); video.pause(); video.removeAttribute('src'); video.load(); emit({ status, error });
  };
  const on = (event: string, fn: EventListener) => { video.addEventListener(event, fn); listeners.push([event, fn]); };
  const playing = () => {
    if (disposed || failed || video.readyState < 2 || video.videoWidth <= 0) return;
    progressAt = Date.now(); errors = 0;
    if (!confirmed) { confirmed = true; emit({ status: 'STREAM_AVAILABLE', first_frame_ms: Date.now() - started }); }
  };
  const play = () => { if (!disposed && !failed) void video.play().catch((e: unknown) => { if (e instanceof Error && e.name === 'NotAllowedError') fail('AUTOPLAY_BLOCKED', 'STREAM_BLOCKED'); }); };
  on('playing', playing);
  on('timeupdate', () => { if (video.currentTime > previous) playing(); previous = video.currentTime; });
  on('loadedmetadata', play);
  on('error', () => fail(video.error?.code === 4 ? 'FORMAT_UNSUPPORTED' : 'MEDIA_ERROR', video.error?.code === 4 ? 'STREAM_UNSUPPORTED' : 'STREAM_OFFLINE'));
  const timer = setInterval(() => {
    if (disposed || failed) return;
    if (!confirmed && Date.now() - started >= STARTUP_TIMEOUT_MS) fail('STARTUP_TIMEOUT');
    else if (confirmed && !video.paused && Date.now() - progressAt >= STARTUP_TIMEOUT_MS) fail('STALL_TIMEOUT');
  }, 250);
  emit({ status: 'STARTING' });
  try {
    if (kind === 'hls' && Library.isSupported()) {
      hls = new Library({ enableWorker: false, maxBufferLength: 15, maxMaxBufferLength: 30, manifestLoadingTimeOut: 8000, manifestLoadingMaxRetry: 1, levelLoadingTimeOut: 8000, levelLoadingMaxRetry: 1, fragLoadingTimeOut: 8000, fragLoadingMaxRetry: 2 });
      hls.on(Library.Events.MANIFEST_PARSED, play);
      hls.on(Library.Events.ERROR, (_event, data) => {
        if (disposed || failed) return;
        if (data.type === Library.ErrorTypes.MEDIA_ERROR && data.fatal && recoveries++ < 1) { hls?.recoverMediaError(); return; }
        if (!data.fatal && ++errors < 6) return;
        const code = data.response?.code;
        if (code === 401 || code === 403) fail(`HTTP_${code}`, 'STREAM_BLOCKED');
        else fail(code ? `HTTP_${code}` : data.type === Library.ErrorTypes.NETWORK_ERROR ? 'NETWORK_OR_CORS' : 'MEDIA_ERROR');
      });
      hls.attachMedia(video); hls.loadSource(url);
    } else if (kind === 'mp4' || video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; play(); }
    else fail('FORMAT_UNSUPPORTED', 'STREAM_UNSUPPORTED');
  } catch { fail('PLAYER_INITIALIZATION_FAILED', 'STREAM_UNSUPPORTED'); }
  return () => { if (disposed) return; disposed = true; clearInterval(timer); listeners.forEach(([event, fn]) => video.removeEventListener(event, fn)); destroyHls(); video.pause(); video.removeAttribute('src'); video.load(); };
}
