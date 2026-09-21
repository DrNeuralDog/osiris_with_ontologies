'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export const intelButton = 'rounded border border-[var(--border-primary)] hover:border-[var(--gold-primary)] px-2 py-1.5 text-xs disabled:opacity-40';
export default function IntelligencePanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.querySelector('button')?.focus(); const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Tab') { const elements = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href],summary'); const first = elements?.[0], last = elements?.[elements.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
  }; window.addEventListener('keydown', key); return () => { window.removeEventListener('keydown', key); previous?.focus(); }; }, [onClose]);
  return <section ref={panel} role="dialog" aria-modal="true" aria-label={title} className="fixed inset-2 md:inset-8 z-[1200] flex flex-col rounded-lg border border-[var(--gold-primary)]/50 bg-[var(--bg-primary)] text-[var(--text-primary)] font-mono shadow-2xl overflow-hidden"><header className="flex justify-between items-center p-4 border-b border-[var(--border-primary)]"><h2 className="text-sm tracking-widest text-[var(--gold-primary)]">{title}</h2><button className={intelButton} aria-label={`Close ${title}`} onClick={onClose}><X size={16} /></button></header>{children}</section>;
}
