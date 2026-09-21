'use client';
import { createContext, useContext, useState, useEffect, useRef, type ReactNode, type Dispatch, type SetStateAction } from 'react';
import { useWorldReplay } from './WorldReplayProvider';
import { intelligenceRequest } from '@/lib/intelligence';
import { REPORT_GROUPS, visibleSnapshot, type AOI, type AirState, type Audibility, type AirReport, type AirCluster } from '@/lib/air-threat/types';
interface Context {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    aoi: AOI | null;
    setAOI: Dispatch<SetStateAction<AOI | null>>;
    viewport: string;
    setViewport: Dispatch<SetStateAction<string>>;
    state: AirState | null;
    error: string;
    busy: boolean;
    groups: string[];
    setGroups: Dispatch<SetStateAction<string[]>>;
    heat: boolean;
    setHeat: Dispatch<SetStateAction<boolean>>;
    envelopes: boolean;
    setEnvelopes: Dispatch<SetStateAction<boolean>>;
    selected: AirReport | AirCluster | null;
    select: Dispatch<SetStateAction<AirReport | AirCluster | null>>;
    acoustic: Audibility | null;
    setAcoustic: Dispatch<SetStateAction<Audibility | null>>;
}
const Context = createContext<Context | null>(null);
export function useAirThreat() { const c = useContext(Context); if (!c)
    throw new Error('AirThreatProvider required'); return c; }
export default function AirThreatProvider({ children }: {
    children: ReactNode;
}) {
    const replay = useWorldReplay(), [open, setOpen] = useState(false), [aoi, setAOI] = useState<AOI | null>(null), [viewport, setViewport] = useState(''), [state, setState] = useState<AirState | null>(null), [loadedMode, setLoadedMode] = useState<'live' | 'replay'>('live'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [groups, setGroups] = useState(REPORT_GROUPS), [heat, setHeat] = useState(true), [envelopes, setEnvelopes] = useState(true), [selected, select] = useState<AirReport | AirCluster | null>(null), [acoustic, setAcoustic] = useState<Audibility | null>(null);
    const clock = useRef({ mode: replay.state.mode, at: replay.state.at }), refreshRef = useRef<() => void>(() => { });
    useEffect(() => { clock.current = { mode: replay.state.mode, at: replay.state.at }; refreshRef.current(); }, [replay.state.mode, replay.state.at]);
    const key = JSON.stringify(aoi);
    useEffect(() => {
        if (!aoi)
            return;
        const controller = new AbortController();
        let pending = false, last = 0, timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => { clearTimeout(timer); const delay = Math.max(0, 10000 - (Date.now() - last)); timer = setTimeout(() => void load(), delay); };
        const load = async () => {
            if (pending || document.hidden)
                return;
            pending = true;
            last = Date.now();
            setBusy(true);
            const time = clock.current;
            const q = new URLSearchParams({ limit: '500' });
            if (aoi.bbox)
                q.set('bbox', aoi.bbox);
            if (aoi.admin)
                q.set('admin', aoi.admin);
            if (time.mode === 'replay')
                q.set('at', new Date(time.at).toISOString());
            try {
                const data = await intelligenceRequest<AirState>(`air-threat/state?${q}`, controller.signal);
                if (!controller.signal.aborted) {
                    setState(data);
                    setLoadedMode(time.mode);
                    setError('');
                }
            }
            catch (e) {
                if (!controller.signal.aborted) {
                    setState(null);
                    setError(e instanceof Error ? e.message : 'Awareness unavailable');
                }
            }
            finally {
                pending = false;
                if (!controller.signal.aborted)
                    setBusy(false);
            }
        };
        const initial = setTimeout(() => { setState(null); select(null); setAcoustic(null); void load(); }, 0);
        refreshRef.current = refresh;
        const poll = setInterval(refresh, 20000);
        return () => { controller.abort(); clearTimeout(initial); clearTimeout(timer); clearInterval(poll); refreshRef.current = () => { }; };
        // AOI is represented by a stable serialized key; clock changes are throttled above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const visibleState = visibleSnapshot(state, loadedMode, replay.state.mode, replay.state.at);
    useEffect(() => { const t = setTimeout(() => { setAcoustic(null); select(null); }, 0); return () => clearTimeout(t); }, [replay.state.mode, replay.state.at]);
    return <Context.Provider value={{ open, setOpen, aoi, setAOI, viewport, setViewport, state: visibleState, error, busy, groups, setGroups, heat, setHeat, envelopes, setEnvelopes, selected, select, acoustic, setAcoustic }}>{children}</Context.Provider>;
}
