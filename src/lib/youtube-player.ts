/** Official IFrame API only; iframe load is never treated as playback. */
export interface YouTubePlayer {
  destroy(): void; playVideo(): void; mute(): void;
}
interface API {
  Player: new (element: HTMLIFrameElement, options: { events: {
    onReady: (e: { target: YouTubePlayer }) => void;
    onStateChange: (e: { data: number }) => void;
    onError: (e: { data: number }) => void;
    onAutoplayBlocked: () => void;
  } }) => YouTubePlayer;
}
let pending: Promise<API> | null = null;
export function youtubeAPI(): Promise<API> {
  if (pending) return pending;
  pending = new Promise<API>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
    const script = existing || document.createElement('script');
    const finish = (api?: API) => { clearInterval(interval); clearTimeout(deadline); script.removeEventListener('error', error); if (api) resolve(api); else reject(new Error('YOUTUBE_API_UNAVAILABLE')); };
    const error = () => finish();
    const deadline = setTimeout(error, 8000);
    const interval = setInterval(() => { const api = (window as Window & { YT?: API }).YT; if (api?.Player) finish(api); }, 100);
    script.addEventListener('error', error, { once: true });
    if (!existing) { script.src = 'https://www.youtube.com/iframe_api'; script.async = true; document.head.appendChild(script); }
  }).catch(error => { pending = null; document.querySelector('script[src="https://www.youtube.com/iframe_api"]')?.remove(); throw error; });
  return pending;
}
