'use client';
/* eslint-disable @next/next/no-img-element -- Live MJPEG and bounded refreshing frames must bypass static image optimization. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '@/lib/i18n';
import { STARTUP_TIMEOUT_MS, cameraPlan, mediaPresentation, iframeResult, startVideoPlayback, youtubeFrameUrl, type PlaybackCamera, type PlaybackResult } from '@/lib/camera-playback';
import { youtubeAPI, type YouTubePlayer } from '@/lib/youtube-player';

export interface CameraMediaDiagnostics { snapshot: string; video: PlaybackResult; snapshot_at?: string }
function Snapshot({ url, name, onStatus }: { url: string; name: string; onStatus: (status: string, at?: string) => void }) {
  const { t } = useLocale(); const [image, setImage] = useState(''), [error, setError] = useState(false), [stale, setStale] = useState(false);
  useEffect(() => {
    let alive = true, saved = false, pending = false, frame: HTMLImageElement | null = null, deadline: ReturnType<typeof setTimeout>;
    const load = () => {
      if (pending) return; pending = true; frame = new Image();
      const finish = (ok: boolean) => {
        clearTimeout(deadline); pending = false;
        if (!alive) return;
        if (ok && frame) { saved = true; setImage(frame.src); setError(false); setStale(false); onStatus('SNAPSHOT_AVAILABLE', new Date().toISOString()); }
        else { setError(!saved); setStale(saved); onStatus(saved ? 'SNAPSHOT_STALE' : 'SNAPSHOT_UNAVAILABLE'); }
        if (frame) { frame.onload = null; frame.onerror = null; if (!ok) frame.src = ''; }
      };
      frame.onload = () => finish(true); frame.onerror = () => finish(false);
      deadline = setTimeout(() => finish(false), STARTUP_TIMEOUT_MS);
      frame.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
    };
    load(); const timer = setInterval(load, 15_000);
    return () => { alive = false; clearTimeout(deadline); clearInterval(timer); if (frame) { frame.onload = null; frame.onerror = null; frame.src = ''; } };
  }, [url, onStatus]);
  return <>{image && <img src={image} alt={name} className="w-full h-full object-contain" />}{!image && <div className="absolute inset-0 grid place-items-center text-xs">{t(error ? 'Snapshot unavailable' : 'Loading snapshot…')}</div>}{stale && <span className="absolute bottom-2 left-2 bg-black/90 text-amber-300 text-xs p-1">{t('Last received snapshot · refresh failed')}</span>}</>;
}
function Video({ url, kind, onState }: { url: string; kind: 'hls' | 'mp4'; onState: (s: PlaybackResult) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => ref.current ? startVideoPlayback(ref.current, url, kind, onState) : undefined, [url, kind, onState]);
  return <video ref={ref} muted autoPlay playsInline controls className="h-full w-full object-contain" />;
}
function Embed({ url, name, onState }: { url: string; name: string; onState: (s: PlaybackResult) => void }) {
  const ref = useRef<HTMLIFrameElement>(null), loaded = useRef(false);
  const youtube = youtubeFrameUrl(url, typeof window === 'undefined' ? '' : window.location.origin);
  useEffect(() => {
    let alive = true, confirmed = false, player: YouTubePlayer | undefined; const started = Date.now();
    const emit = (state: PlaybackResult) => { if (alive) onState({ ...state, checked_at: new Date().toISOString() }); };
    const deadline = setTimeout(() => { if (!confirmed) emit(youtube ? { status: 'STREAM_OFFLINE', error: 'EMBED_TIMEOUT' } : iframeResult(loaded.current, false)); }, STARTUP_TIMEOUT_MS);
    if (youtube) void youtubeAPI().then(api => {
      if (!alive || !ref.current) return;
      player = new api.Player(ref.current, { events: {
        onReady: e => { if (alive) { e.target.mute(); e.target.playVideo(); } },
        onStateChange: e => { if (e.data === 1) { confirmed = true; clearTimeout(deadline); emit({ status: 'STREAM_AVAILABLE', first_frame_ms: Date.now() - started }); } },
        onError: e => { clearTimeout(deadline); emit({ status: [101, 150, 153].includes(e.data) ? 'STREAM_BLOCKED' : 'STREAM_OFFLINE', error: `YOUTUBE_${e.data}` }); },
        onAutoplayBlocked: () => { clearTimeout(deadline); emit({ status: 'STREAM_BLOCKED', error: 'AUTOPLAY_BLOCKED' }); },
      } });
    }).catch(() => emit({ status: 'UNKNOWN', error: 'YOUTUBE_API_UNAVAILABLE' }));
    return () => { alive = false; clearTimeout(deadline); player?.destroy(); };
  }, [url, youtube, onState]);
  return <iframe ref={ref} src={youtube || url} title={name} className="h-full w-full border-0" referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen onLoad={() => { loaded.current = true; if (!youtube) onState({ ...iframeResult(true, false), checked_at: new Date().toISOString() }); }} onError={() => onState({ status: 'STREAM_OFFLINE', checked_at: new Date().toISOString(), error: 'EMBED_LOAD_FAILED' })} />;
}
function Mjpeg({ url, name, onState }: { url: string; name: string; onState: (s: PlaybackResult) => void }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const started = Date.now(); const timer = setInterval(() => {
      if (ref.current && ref.current.naturalWidth > 0) { clearInterval(timer); onState({ status: 'UNKNOWN', checked_at: new Date().toISOString(), error: 'MJPEG_FIRST_FRAME_ONLY', first_frame_ms: Date.now() - started }); }
      else if (Date.now() - started >= STARTUP_TIMEOUT_MS) { clearInterval(timer); onState({ status: 'STREAM_OFFLINE', checked_at: new Date().toISOString(), error: 'STARTUP_TIMEOUT' }); }
    }, 250);
    return () => clearInterval(timer);
  }, [url, onState]);
  return <img ref={ref} src={url} alt={name} className="h-full w-full object-contain" onError={() => onState({ status: 'STREAM_OFFLINE', checked_at: new Date().toISOString(), error: 'MJPEG_LOAD_FAILED' })} />;
}
/** Parent keys this component by camera/resolution/retry: old transports always unmount. */
export default function CameraMedia({ camera, resolved, offline, onDiagnostics }: { camera: PlaybackCamera & { name: string }; resolved?: string | null; offline?: boolean; onDiagnostics: (d: CameraMediaDiagnostics) => void }) {
  const { t } = useLocale(), plan = cameraPlan(camera, resolved);
  const [video, setVideo] = useState<PlaybackResult>({ status: offline ? 'STREAM_OFFLINE' : plan.kind === 'unsupported' ? 'STREAM_UNSUPPORTED' : plan.kind === 'external' ? 'EXTERNAL_ONLY' : plan.kind === 'jpg' ? (plan.external ? 'EXTERNAL_ONLY' : 'UNKNOWN') : 'STARTING' });
  const [snapshot, setSnapshot] = useState('UNKNOWN'), [snapshotAt, setSnapshotAt] = useState<string>();
  // Stable callbacks prevent feed restarts on clocks, diagnostics and locale changes.
  const callback = useRef(onDiagnostics); useEffect(() => { callback.current = onDiagnostics; }, [onDiagnostics]);
  useEffect(() => { callback.current({ snapshot, video, snapshot_at: snapshotAt }); }, [snapshot, video, snapshotAt]);
  const [snapshotOnly, setSnapshotOnly] = useState(false);
  const snapshotStatus = useCallback((status: string, at?: string) => { setSnapshot(status); if (at) setSnapshotAt(at); }, []);
  const { failed, showSnapshot, caption } = mediaPresentation(plan.kind, Boolean(plan.snapshot), video.status, snapshot, snapshotOnly);
  return <div className="relative h-full w-full bg-black text-slate-200" data-video-status={video.status} data-snapshot-status={snapshot}>
    {showSnapshot && plan.snapshot && !offline ? <Snapshot url={plan.snapshot} name={camera.name} onStatus={snapshotStatus} /> : !failed && plan.video && !snapshotOnly ? (
      plan.kind === 'hls' || plan.kind === 'mp4' ? <Video url={plan.video} kind={plan.kind} onState={setVideo} /> : plan.kind === 'iframe' ? <Embed url={plan.video} name={camera.name} onState={setVideo} /> : plan.kind === 'mjpeg' ? <Mjpeg url={plan.video} name={camera.name} onState={setVideo} /> : null
    ) : <div className="absolute inset-0 flex items-center justify-center text-xs p-8 text-center">{t(offline ? 'Camera offline at source' : plan.kind === 'external' ? 'Live video is hosted by the provider' : 'Live video unavailable')}</div>}
    {video.status === 'STARTING' && !showSnapshot && <div role="status" className="absolute top-2 left-2 bg-black/80 px-2 py-1 text-xs pointer-events-none">{t('Starting video · maximum 15 seconds')}</div>}
    <div className="absolute top-2 right-2 bg-black/85 p-1 text-[10px] pointer-events-none">{t(caption)}</div>
    {!showSnapshot && plan.snapshot && <button onClick={() => setSnapshotOnly(true)} className="absolute bottom-2 right-2 bg-black/85 border border-amber-300/40 p-1 text-xs">{t('Show snapshot')}</button>}
  </div>;
}
