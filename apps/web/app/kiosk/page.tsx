'use client';
import { Button, Card, ErrorBox, Input, Label, ThemeProvider } from '@erp/ui';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { barcodeDetector } from '@/lib/scan';

interface Punch { nfcUid?: string; qrToken?: string; at: string; idempotencyKey: string }
interface Station { name: string; methods: string[]; company?: string; logo?: string | null; punchesToday?: number }
const ls = {
  get<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
/** The server no longer knows this device (an admin unpaired it, or it was paired elsewhere). */
class Unpaired extends Error {}

/**
 * Attendance kiosk: a standalone, wall-mounted device. No user login — it holds a station-scoped device token from
 * pairing. Only an admin can unpair it (HR › Kiosk Stations › Unpair device); the kiosk then returns to pairing by itself.
 * Works with USB NFC readers (keyboard wedge), Web NFC on Android, the camera for personal QR codes (any browser),
 * and shows a rotating QR for app check-in. Punches queue offline and sync later.
 */
export default function Kiosk() {
  const [token, setTokenState] = useState<string | null>(null);
  const [station, setStation] = useState<Station | null>(null);
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; title: string; text?: string } | null>(null);
  const [queue, setQueue] = useState<Punch[]>([]);
  const [qr, setQr] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const wedge = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => { setTokenState(ls.get('kiosk:token', null)); setStation(ls.get('kiosk:station', null)); setQueue(ls.get('kiosk:queue', [])); }, []);
  useEffect(() => ls.set('kiosk:queue', queue), [queue]);

  const headers = useCallback(() => ({ 'Content-Type': 'application/json', 'x-device-token': token ?? '' }), [token]);
  /** Back to pairing (offline punches stay queued and sync once paired again). */
  const unpaired = useCallback(() => {
    try { localStorage.removeItem('kiosk:token'); } catch { /* ignore */ }
    setTokenState(null);
    setNotice('This kiosk was unpaired by an administrator. Pair it again to continue.');
  }, []);

  const send = useCallback(async (p: Punch) => {
    const r = await fetch('/api/hrm/kiosk/punch', { method: 'POST', headers: headers(), body: JSON.stringify(p) });
    if (r.status === 401) throw new Unpaired();
    if (r.status >= 500 || r.status === 0) throw new Error('offline');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, title: body.message ?? 'Not recognised', text: 'Please try again or see HR' };
    return { ok: true, title: `Welcome, ${body.employee.name}`, text: `Recorded at ${new Date(body.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` };
  }, [headers]);

  const punch = useCallback(async (p: Omit<Punch, 'at' | 'idempotencyKey'>) => {
    const full = { ...p, at: new Date().toISOString(), idempotencyKey: crypto.randomUUID() };
    try { setFlash(await send(full)); }
    catch (e) {
      setQueue((q) => [...q, full]);
      if (e instanceof Unpaired) return unpaired();
      setOnline(false);
      setFlash({ ok: true, title: 'Saved', text: 'No connection — it will sync automatically' });
    }
    setTimeout(() => setFlash(null), 5000);
  }, [send, unpaired]);

  // Heartbeat every minute: "last seen" for HR, current methods and branding, online state; flushes the offline queue.
  useEffect(() => {
    if (!token) return;
    const beat = async () => {
      const r = await fetch('/api/hrm/kiosk/health', { headers: headers() }).catch(() => null);
      if (r?.status === 401) return unpaired();
      setOnline(!!r?.ok);
      if (r?.ok) {
        const h = await r.json();
        const next = { name: h.station, methods: h.methods ?? [], company: h.company, logo: h.logo, punchesToday: h.punchesToday };
        setStation(next);
        ls.set('kiosk:station', { name: next.name, methods: next.methods });
        const q: Punch[] = ls.get('kiosk:queue', []);
        const left: Punch[] = [];
        for (const p of q) { try { await send(p); } catch (e) { if (e instanceof Unpaired) return unpaired(); left.push(p); } }
        if (q.length) setQueue(left);
      }
    };
    beat();
    const t = setInterval(beat, 60_000);
    return () => clearInterval(t);
  }, [token, headers, send, unpaired]);

  const methods = station?.methods ?? [];
  // Rotating QR for app scan.
  useEffect(() => {
    if (!token || !methods.includes('rotating_qr')) return setQr(null);
    let t: ReturnType<typeof setTimeout>;
    const load = async () => {
      const r = await fetch('/api/hrm/kiosk/qr', { headers: headers() }).catch(() => null);
      if (r?.status === 401) return unpaired();
      const d = r?.ok ? await r.json() : null;
      setQr(d?.svg ?? null);
      t = setTimeout(load, Math.max((d?.refreshInSec ?? 30) - 2, 5) * 1000);
    };
    load();
    return () => clearTimeout(t);
  }, [token, methods.join(), headers, unpaired]); // eslint-disable-line react-hooks/exhaustive-deps

  // Web NFC (Android Chrome); USB readers type into the hidden input instead.
  useEffect(() => {
    if (!token || !methods.includes('nfc')) return;
    const NDEF = (window as unknown as { NDEFReader?: new () => { scan(): Promise<void>; onreading: (e: { serialNumber: string }) => void } }).NDEFReader;
    if (!NDEF) return;
    const r = new NDEF();
    r.scan().then(() => { r.onreading = (e) => punch({ nfcUid: e.serialNumber }); }).catch(() => {});
  }, [token, methods.join(), punch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Camera: an employee shows their personal QR (built-in reader or the bundled one, so iPads work too).
  useEffect(() => {
    if (!token || !methods.includes('qr')) return;
    let live = true;
    let stream: MediaStream | null = null;
    let last = '';
    (async () => {
      const det = await barcodeDetector();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      if (!video.current || !live) return;
      video.current.srcObject = stream;
      await video.current.play();
      while (live) {
        const [c] = await det.detect(video.current).catch(() => []);
        if (c && c.rawValue !== last) { last = c.rawValue; punch({ qrToken: c.rawValue }); setTimeout(() => { last = ''; }, 5000); }
        await new Promise((res) => setTimeout(res, 300));
      }
    })().catch(() => {});
    return () => { live = false; stream?.getTracks().forEach((x) => x.stop()); };
  }, [token, methods.join(), punch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const t = setInterval(() => wedge.current?.focus(), 1000); return () => clearInterval(t); }, []);

  // Opened from a pairing link (/kiosk?code=123456): pair straight away, then drop the code from the address bar.
  useEffect(() => {
    const c = new URLSearchParams(location.search).get('code');
    if (!c || ls.get('kiosk:token', null)) return;
    history.replaceState(null, '', '/kiosk');
    setCode(c);
    pairWith(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pair(e: FormEvent) {
    e.preventDefault();
    await pairWith(code);
  }

  async function pairWith(code: string) {
    setError(null);
    const r = await fetch('/api/hrm/kiosk/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (!r.ok) return setError(d.message ?? 'Pairing failed');
    ls.set('kiosk:token', d.deviceToken);
    ls.set('kiosk:station', d.station);
    setNotice(null);
    setTokenState(d.deviceToken);
    setStation(d.station);
    document.documentElement.requestFullscreen?.().catch(() => {});
  }

  if (!token) return (
    <ThemeProvider>
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm" title="Pair this kiosk">
          <form onSubmit={pair} className="space-y-3">
            {notice && <p className="rounded-md px-3 py-2 text-sm" style={{ color: 'var(--tone-amber)', background: 'var(--tone-amber-bg)' }}>{notice}</p>}
            <p className="text-sm text-muted-foreground">An administrator opens <b>HR › Kiosk Stations › Pair a device</b> and either opens that link on this device (or scans its QR), or reads out the 6-digit code to type here.</p>
            <div><Label htmlFor="code">Pairing code</Label><Input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></div>
            <ErrorBox error={error} />
            <Button className="w-full">Pair</Button>
            {queue.length > 0 && <p className="text-xs" style={{ color: 'var(--tone-amber)' }}>{queue.length} punch(es) saved on this device will sync after pairing.</p>}
          </form>
        </Card>
      </main>
    </ThemeProvider>
  );

  const hints = [methods.includes('nfc') && 'Tap your card', methods.includes('qr') && 'Show your QR code to the camera', methods.includes('rotating_qr') && 'Or, in the ERP app: My HR › Check in at a kiosk, and scan this code'].filter(Boolean) as string[];
  return (
    <ThemeProvider>
      <main className="flex min-h-screen select-none flex-col" onContextMenu={(e) => e.preventDefault()}>
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            {station?.logo && <img src={station.logo} alt="" className="h-9 max-w-40 object-contain" />}
            <div className="min-w-0"><div className="truncate font-semibold">{station?.company ?? ''}</div><div className="truncate text-sm text-muted-foreground">{station?.name}</div></div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--tone-${online ? 'green' : 'red'})` }} />{online ? 'Online' : 'Offline — saving on this device'}
          </div>
        </header>

        <section className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
          <Clock />
          <form onSubmit={(e) => { e.preventDefault(); const v = wedge.current!.value.trim(); wedge.current!.value = ''; if (v) punch({ nfcUid: v }); }}>
            <input ref={wedge} aria-label="Card reader input" className="sr-only" autoFocus autoComplete="off" />
          </form>
          <div role="status" aria-live="assertive"
            className={`flex min-h-28 w-full max-w-xl flex-col items-center justify-center rounded-2xl px-8 py-5 transition ${flash ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}
            style={{ color: `var(--tone-${flash?.ok ? 'green' : 'red'})`, background: `var(--tone-${flash?.ok ? 'green' : 'red'}-bg)` }}>
            <div className="text-3xl font-semibold">{flash ? `${flash.ok ? '✓' : '✕'} ${flash.title}` : '—'}</div>
            {flash?.text && <div className="mt-1 text-lg opacity-90">{flash.text}</div>}
          </div>
          <div className="space-y-1">{hints.map((h) => <p key={h} className="text-xl text-muted-foreground">{h}</p>)}</div>
          {(qr || methods.includes('qr')) && (
            <div className="flex flex-wrap items-center justify-center gap-6">
              {qr && <div className="rounded-xl bg-white p-3" style={{ width: 220 }} dangerouslySetInnerHTML={{ __html: qr }} aria-label="Scan with the ERP app to check in" />}
              {methods.includes('qr') && <video ref={video} className="h-44 rounded-xl bg-black/40" muted playsInline aria-label="Camera for personal QR codes" />}
            </div>
          )}
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-2 px-6 py-2 text-xs text-muted-foreground">
          <span>{station?.punchesToday != null ? `${station.punchesToday} punch${station.punchesToday === 1 ? '' : 'es'} today` : ''}</span>
          {queue.length > 0 && <span style={{ color: 'var(--tone-amber)' }}>{queue.length} punch(es) waiting to sync</span>}
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>Full screen</button>
        </footer>
      </main>
    </ThemeProvider>
  );
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return (
    <div>
      <p className="text-7xl font-light tabular-nums">{now?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      <p className="mt-2 text-xl text-muted-foreground">{now?.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
    </div>
  );
}
