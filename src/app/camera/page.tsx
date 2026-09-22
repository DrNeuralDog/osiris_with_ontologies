'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import CameraViewer from '@/components/CameraViewer';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import type { CctvCamera } from '@/app/api/cctv/types';
import { useLocale } from '@/lib/i18n';
function CatalogViewer() {
  const { t } = useLocale(), query = useSearchParams(), router = useRouter(), id = query.get('id') || '';
  const [attempt, setAttempt] = useState(0);
  const [input, setInput] = useState(id), [result, setResult] = useState<{ id: string; camera?: CctvCamera; error?: string }>();
  useEffect(() => {
    if (!id) return; const c = new AbortController();
    void fetch(`/api/cctv/camera?id=${encodeURIComponent(id)}`, { signal: AbortSignal.any([c.signal, AbortSignal.timeout(10_000)]) }).then(async r => { const body = await r.json(); if (!r.ok) throw new Error(body.error); return body; }).then(camera => setResult({ id, camera })).catch(e => { if (!c.signal.aborted) setResult({ id, error: e instanceof Error ? e.message : 'Camera unavailable' }); });
    return () => c.abort();
  }, [id, attempt]);
  return <main className="min-h-screen bg-black text-slate-200 p-6 font-mono">
    <div className="flex gap-4 items-center"><Link href="/">OSIRIS · {t('Back to map')}</Link><LanguageSwitcher/></div>
    <h1 className="mt-5 text-lg">{t('Camera diagnostics')}</h1>
    <form className="flex gap-2 mt-3" onSubmit={e => { e.preventDefault(); setAttempt(n => n + 1); router.push(`/camera?id=${encodeURIComponent(input)}`); }}><input aria-label={t('Catalog camera ID')} maxLength={200} value={input} onChange={e => setInput(e.target.value)} className="bg-slate-900 border p-2 w-80"/><button className="border px-3">{t('Open')}</button></form>
    <p className="mt-2 text-xs text-slate-400">{t('Uses an existing catalog ID. Does not load all camera providers or record video.')}</p>
    {id && result?.id !== id && <p role="status">{t('Loading camera…')}</p>}
    {result?.id === id && result.error && <p role="alert" className="text-amber-300 mt-3">{t(result.error)}</p>}
    <CameraViewer camera={result?.id === id ? result.camera || null : null} onClose={() => router.push('/camera')}/>
  </main>;
}
export default function Page() { return <Suspense><CatalogViewer/></Suspense>; }
