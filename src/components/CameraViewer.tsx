"use client";
import { useEffect, useState } from 'react';
import { X, ExternalLink, RefreshCw, MapPin, Camera, Maximize2 } from 'lucide-react';
import { useLocale } from '@/lib/i18n';
import { cameraUrl } from '@/lib/camera-playback';
import { localEmbed, needsResolution, liveFeedAtSource, skylineSnapshotMatches } from '@/lib/camera-feed';
import type { CctvCamera } from '@/app/api/cctv/types';
import type { InvestigationSeed } from '@/lib/ontology';
import type { InvestigationIntent } from '@/lib/investigation';
import InvestigationActions from './InvestigationActions';
import CameraMedia, { type CameraMediaDiagnostics } from './CameraMedia';

interface Props {
  camera: CctvCamera | null;
  onClose: () => void;
  onLocate?: (lat: number, lng: number) => void;
  onInvestigate?: (seed: InvestigationSeed, intent: InvestigationIntent) => void;
}
interface Resolution { key: string; embed: string | null; kind: string; reason?: string; snapshot_id?: string }
interface Check { status?: string; snapshot_status?: string; stream_status?: string; checked_at?: string; error?: string; cached?: boolean }
export default function CameraViewer(props: Props) {
  return props.camera ? <Viewer key={props.camera.id} {...props} camera={props.camera} /> : null;
}
function Viewer({ camera, onClose, onLocate, onInvestigate }: Props & { camera: CctvCamera }) {
  const { t } = useLocale();
  const [fullscreen, setFullscreen] = useState(false), [retry, setRetry] = useState(0);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [diagnostic, setDiagnostic] = useState<CameraMediaDiagnostics>({ snapshot: 'UNKNOWN', video: { status: 'UNKNOWN' } });
  const [check, setCheck] = useState<Check | null>(null), [checking, setChecking] = useState(false);
  const direct = localEmbed(camera), resolveKey = (needsResolution(camera) ? camera.external_url : null) ?? liveFeedAtSource(camera);
  const resolving = Boolean(resolveKey && resolution?.key !== resolveKey);
  const resolved = direct || (resolution?.key === resolveKey ? resolution?.embed : null);
  const unavailable = resolution?.key === resolveKey && ['offline', 'missing'].includes(resolution?.kind || '');
  const snapshotVerified = skylineSnapshotMatches(camera, resolution?.key === resolveKey ? resolution.snapshot_id : undefined);
  const mediaCamera = snapshotVerified ? camera : { ...camera, feed_url: undefined };
  const source = cameraUrl(camera.external_url || camera.stream_url || camera.feed_url);
  useEffect(() => {
    if (!resolveKey) return;
    const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 12_000); let active = true;
    void fetch(`/api/cctv/resolve?url=${encodeURIComponent(resolveKey)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async r => { if (!r.ok) throw new Error('Resolver unavailable'); return r.json(); })
      .then(d => { if (active) setResolution({ key: resolveKey, embed: d.embeddable ? cameraUrl(d.embedUrl) : null, kind: d.kind || 'unknown', reason: d.reason, snapshot_id: d.snapshot_id }); })
      .catch(() => { if (active) setResolution({ key: resolveKey, embed: null, kind: 'unreachable' }); })
      .finally(() => clearTimeout(deadline));
    return () => { active = false; clearTimeout(deadline); controller.abort(); };
  }, [resolveKey, retry]);
  async function checkHealth() {
    setChecking(true);
    try { const r = await fetch(`/api/intelligence/camera-check?id=${encodeURIComponent(camera.id)}`, { method: 'POST', signal: AbortSignal.timeout(25_000) }); setCheck(await r.json()); }
    catch { setCheck({ error: 'Camera health check unavailable' }); }
    finally { setChecking(false); }
  }
  const button = 'border border-[var(--gold-primary)]/35 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40';
  return <section role="dialog" aria-label={t('Camera viewer')} className={`fixed z-[500] font-mono text-[var(--text-primary)] ${fullscreen ? 'inset-3' : 'bottom-[70px] left-2 right-2 md:bottom-6 md:left-auto md:right-6 md:w-[520px]'}`}>
    <div className="h-full flex flex-col bg-black/95 border border-[var(--border-primary)] shadow-2xl rounded overflow-hidden">
      <header className="p-3 border-b border-white/15 flex items-start gap-2">
        <Camera size={18} className="text-[var(--gold-primary)] shrink-0" />
        <div className="min-w-0 flex-1"><h3 className="text-xs font-bold truncate">{camera.name}</h3><p className="text-[10px] text-slate-400">{camera.city}, {camera.country} · {camera.source}</p></div>
        <button className={button} onClick={() => setFullscreen(!fullscreen)} title={t('Toggle fullscreen')}><Maximize2 size={14}/></button>
        {onLocate && Number.isFinite(camera.lat) && Number.isFinite(camera.lng) && <button className={button} onClick={() => onLocate?.(camera.lat, camera.lng)} title={t('Fly to location')}><MapPin size={14}/></button>}
        <button className={button} onClick={onClose} aria-label={t('Close')}><X size={16}/></button>
      </header>
      {onInvestigate && <InvestigationActions entity={{ ...camera, type: 'camera' }} onInvestigate={onInvestigate}/>}
      <div className={`relative min-h-[180px] ${fullscreen ? 'flex-1' : 'aspect-video max-h-[40vh]'}`}>
        <CameraMedia key={`${camera.id}:${resolved || ''}:${unavailable}:${snapshotVerified}:${retry}`} camera={mediaCamera} resolved={resolved} offline={unavailable} onDiagnostics={setDiagnostic}/>
      </div>
      <div className="p-2 flex flex-wrap items-center gap-2 border-t border-white/15 text-[10px]">
        {(camera.stream_url || camera.feed_url || resolveKey || resolved) && <button className={button} onClick={() => setRetry(n => n + 1)}><RefreshCw size={11} className="inline mr-1"/>{t(camera.stream_url || resolveKey || resolved ? 'RETRY LIVE' : 'Refresh snapshot')}</button>}
        {source && <a className={button} href={source} target="_blank" rel="noopener noreferrer"><ExternalLink size={11} className="inline mr-1"/>{t('OPEN AT SOURCE')}</a>}
        <button className={button} onClick={() => void checkHealth()} disabled={checking || !camera.id}>{t(checking ? 'Checking snapshot…' : 'Check source health')}</button>
        {resolving && <span role="status">{t('Resolving provider · maximum 12 seconds')}</span>}
      </div>
      <details className="text-[10px] p-2 border-t border-white/10 max-h-44 overflow-auto">
        <summary className="cursor-pointer text-slate-400">{t('Camera diagnostics')}</summary>
        <dl className="grid grid-cols-[100px_1fr] gap-1 mt-2 break-words">
          <dt>{t('Provider')}</dt><dd>{camera.source}</dd>
          <dt>{t('Snapshot')}</dt><dd>{t(snapshotVerified ? diagnostic.snapshot : 'Source image identity not verified')}</dd>
          <dt>{t('Video')}</dt><dd>{t(diagnostic.video.status)}</dd>
          <dt>{t('Last check')}</dt><dd>{diagnostic.video.checked_at || diagnostic.snapshot_at || t('Not provided')}</dd>
          <dt>{t('First frame')}</dt><dd>{diagnostic.video.first_frame_ms == null ? t('Not provided') : `${diagnostic.video.first_frame_ms} ms`}</dd>
          <dt>{t('Detail')}</dt><dd>{t(diagnostic.video.error || 'Not provided')}</dd>
          <dt>{t('Resolver')}</dt><dd>{resolveKey ? `${t(resolution?.kind || 'STARTING')} ${resolution?.reason || ''}` : '—'}</dd>
          {check && <><dt>{t('Server snapshot')}</dt><dd>{t(check.snapshot_status || check.status || 'UNKNOWN')} · {t(check.error || 'Not provided')} {check.cached && t('cached check')}</dd><dt>{t('Server video')}</dt><dd>{t(check.stream_status || 'UNKNOWN')}</dd></>}
        </dl>
        <p className="text-slate-400 mt-2">{t('A received image does not prove live video. Network errors may include CORS; the browser does not always distinguish them.')}</p>
      </details>
    </div>
  </section>;
}
